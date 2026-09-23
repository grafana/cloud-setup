// Presentation vocabulary for both output surfaces: the Ink wizard and the
// plain console output (--help, usage errors). Free of React and Ink
// imports on purpose, so cliStyle.ts, cli.ts and the OAuth callback page
// can share it without pulling the UI in.

// Any non-empty value opts out, per no-color.org: "when present and not an
// empty string, regardless of its value". So NO_COLOR=0 disables color.
export const NO_COLOR = Boolean(process.env.NO_COLOR);

// Spinners and progress meters only animate on a real terminal, and never
// when the user has asked for no color.
export const ANIMATE = Boolean(process.stdout.isTTY) && !NO_COLOR;

// Undefined, not a fallback string, when color is off: Ink reads undefined
// as "leave the foreground alone", where any value at all is a color it
// emits. See tests/colors.test.mjs for the contrast floors these hold.
//
// OK, BAD and URL are ANSI palette names, so the terminal resolves them
// against its own theme. ACCENT and MUTED are absolute hex and cannot
// adapt, which is why only those two have floors to hold.
export const COLORS = {
  ACCENT: NO_COLOR ? undefined : "#FFA500",
  OK: NO_COLOR ? undefined : "green",
  BAD: NO_COLOR ? undefined : "red",
  // Always rendered through ui/shared.tsx's Link, which underlines as well
  // — ANSI blue is whatever the theme says, and on the common dark palettes
  // that lands between 1.6:1 and 3.4:1 against their own backgrounds.
  URL: NO_COLOR ? undefined : "blue",
  // A plain ANSI gray (bright-black, code 90) reads as near-invisible on a
  // dark/charcoal background — verified live. This medium gray instead.
  MUTED: NO_COLOR ? undefined : "#999999",
};

// One vocabulary for the symbols that carry meaning, so a mark and its
// opposite cannot drift apart: the tree previously used both U+2716 and
// U+2717 for the same failure, on different surfaces.
//
// OK and FAIL are the weight-matched Dingbats pair. The heavy forms (✔ ✖)
// are deliberately unused, so mixing them in reads as a different state
// rather than the same one.
export const ICONS = {
  OK: "✓",
  FAIL: "✗",
  SKIPPED: "=",
  PENDING: "○",
  // A step that is current but waiting on the user rather than working, so
  // the spinner would be misleading.
  WAITING: "●",
  // Marks the focused row in a picker, alongside bold — the focused row
  // must stay identifiable when color is off.
  CURSOR: "›",
  ENTER: "⏎",
  // Only ever named as a pair, in the "↑↓ move" hints.
  ARROWS: "↑↓",
  BRAND: "🦕",
} as const;
