import assert from "node:assert/strict";
import { test } from "node:test";

// The tokens read NO_COLOR at import time, so each case needs its own
// module instance. The query string defeats the ESM cache, the same way
// tests/telemetry.test.mjs does it.
let sequence = 0;
async function loadTheme(noColor) {
  if (noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColor;
  // Nothing here should reach the network or the state directory, and this
  // makes sure of it.
  process.env.CLOUD_SETUP_TELEMETRY = "disabled";
  return import(`../dist/theme.js?colors=${sequence++}`);
}

const TOKENS = ["ACCENT", "OK", "BAD", "URL", "MUTED"];

// WCAG 2.1 relative luminance and contrast ratio.
function luminance(hex) {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

test("NO_COLOR clears every color token", async () => {
  // Not cosmetic: a token that stays set is a value Ink will emit, and the
  // one that did — `accent ?? "white"` at the picker call sites — painted
  // the focused row white, which on a light terminal is invisible.
  const { COLORS } = await loadTheme("1");
  for (const name of TOKENS) {
    assert.equal(COLORS[name], undefined, `${name} must be undefined under NO_COLOR`);
  }
});

test("any non-empty NO_COLOR value opts out, per the spec", async () => {
  // no-color.org: "when present and not an empty string, regardless of its
  // value". So NO_COLOR=0 disables color rather than enabling it.
  for (const value of ["1", "0", "false", "anything"]) {
    const { COLORS } = await loadTheme(value);
    assert.equal(COLORS.MUTED, undefined, `NO_COLOR=${value} must opt out`);
  }
  const { COLORS: empty } = await loadTheme("");
  assert.notEqual(empty.MUTED, undefined, "an empty NO_COLOR is not an opt-out");
});

test("every token has a value when color is on", async () => {
  const { COLORS } = await loadTheme(undefined);
  for (const name of TOKENS) {
    assert.notEqual(COLORS[name], undefined, `${name} must have a value`);
  }
});

// `ok`, `bad` and `url` are ANSI palette names, so their contrast is the
// theme's business. `accent` and `muted` are absolute hex, so theirs is
// ours, and these are the backgrounds they have to survive.
const DARK_BACKGROUNDS = {
  black: "#000000",
  "VS Code dark": "#1E1E1E",
  "GitHub dark": "#0D1117",
  "Solarized Dark": "#002B36",
  Dracula: "#282A36",
};
const LIGHT_BACKGROUNDS = {
  white: "#FFFFFF",
  "Solarized Light": "#FDF6E3",
  Novel: "#DFDBC3",
  "Man Page": "#FEF49C",
};

// Dark is the case this app is tuned for, and 4.5:1 is WCAG AA. Light
// cannot also reach AA: no single luminance clears 4.5:1 on every dark
// background and 3:1 on every light one, so the light figures are floors
// against illegibility rather than quality targets.
const FLOORS = {
  // The only token that carries content by itself — detail lines, hints,
  // picker descriptions — so it needs a light floor that keeps it readable.
  // #999999 sits at 2.04:1 on the worst light background here.
  MUTED: { dark: 4.5, light: 2.0 },
  // Every accent site pairs it with bold, a glyph (● › ⏎) or a spinner, so
  // poor contrast costs legibility and never information. Its light floor
  // is therefore set only to catch the catastrophe: white-on-white is
  // 1.0:1. Note the headroom is 0.02 — lightening accent at all will trip
  // this, which is the point.
  ACCENT: { dark: 4.5, light: 1.4 },
};

test("the absolute color tokens hold their contrast floors", async () => {
  const { COLORS } = await loadTheme(undefined);
  for (const [name, floors] of Object.entries(FLOORS)) {
    const value = COLORS[name];
    assert.match(value, /^#[0-9A-Fa-f]{6}$/, `${name} should be a hex value`);
    for (const [label, background] of Object.entries(DARK_BACKGROUNDS)) {
      const r = contrast(value, background);
      assert.ok(r >= floors.dark, `${name} (${value}) is ${r.toFixed(2)}:1 on ${label}, below ${floors.dark}:1`);
    }
    for (const [label, background] of Object.entries(LIGHT_BACKGROUNDS)) {
      const r = contrast(value, background);
      assert.ok(r >= floors.light, `${name} (${value}) is ${r.toFixed(2)}:1 on ${label}, below ${floors.light}:1`);
    }
  }
});

test("no token can become invisible against any supported background", async () => {
  // The blunt guard, and the reason this file exists: `accent ?? "white"`
  // used to paint the picker's focused row white under NO_COLOR, which on a
  // light terminal is text you cannot see. Nothing may sit near 1:1.
  const { COLORS } = await loadTheme(undefined);
  const backgrounds = { ...DARK_BACKGROUNDS, ...LIGHT_BACKGROUNDS };
  for (const name of ["ACCENT", "MUTED"]) {
    for (const [label, background] of Object.entries(backgrounds)) {
      const r = contrast(COLORS[name], background);
      assert.ok(r >= 1.4, `${name} (${COLORS[name]}) is ${r.toFixed(2)}:1 on ${label} — effectively invisible`);
    }
  }
});

test("the contrast helper agrees with known WCAG values", async () => {
  // A miscalculating helper would make the assertions above meaningless.
  assert.equal(contrast("#FFFFFF", "#000000").toFixed(0), "21");
  assert.equal(contrast("#777777", "#FFFFFF").toFixed(2), "4.48");
  assert.equal(contrast("#000000", "#000000").toFixed(0), "1");
});

test("no two icon names share a glyph", async () => {
  // Two names for one symbol is how a vocabulary stops being one: it lets a
  // caller pick ICONS.FAIL in one place and something equal-but-different in
  // another, which is the drift this object exists to stop.
  const { ICONS } = await loadTheme(undefined);
  const values = Object.values(ICONS);
  assert.equal(new Set(values).size, values.length, `duplicate glyph in ICONS: ${values.join(" ")}`);
});

test("the status pair is weight-matched", async () => {
  // U+2713/U+2717 are the light Dingbats pair. Mixing in a heavy form
  // (U+2714 or U+2716) reads as a different state rather than the same one,
  // which is exactly what the tree used to do.
  const { ICONS } = await loadTheme(undefined);
  assert.equal(ICONS.OK, "\u2713");
  assert.equal(ICONS.FAIL, "\u2717");
  assert.ok(!Object.values(ICONS).includes("\u2714"), "heavy check mark must stay unused");
  assert.ok(!Object.values(ICONS).includes("\u2716"), "heavy cross must stay unused");
});
