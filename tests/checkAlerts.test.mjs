import assert from "node:assert/strict";
import { test } from "node:test";

const { alertsForCheck, periodFor, presetDescription, presetMeta, presetsFor } =
  await import("../dist/products/syntheticMonitoring/checkAlerts.js");
const { isEmailish, isPlaceholderAddresses, joinAddresses, parseAddresses } =
  await import("../dist/products/syntheticMonitoring/notifications.js");

const MINUTE = 60 * 1000;

// What discover.ts actually generates. Not one of these runs fast enough
// for the SM app's own "5m" form default to be a legal period.
const UPTIME = { frequencyMs: 10 * MINUTE, settings: { http: { method: "GET" } } };
const BROWSER = { frequencyMs: 20 * MINUTE, settings: { browser: { script: "" } } };
const SSL = { frequencyMs: 60 * MINUTE, settings: { browser: { script: "" } } };
const AI_ENDPOINT = { frequencyMs: 30 * MINUTE, settings: { http: { method: "GET" } } };

test("the derived period is never shorter than the check frequency", () => {
  // The constraint that makes a hard-coded period impossible.
  for (const frequencyMs of [10 * MINUTE, 20 * MINUTE, 30 * MINUTE, 60 * MINUTE]) {
    const period = periodFor(frequencyMs);
    assert.ok(period, `no period for a ${frequencyMs}ms check`);
    const ms = period === "1h" ? 60 * MINUTE : Number(period.replace("m", "")) * MINUTE;
    assert.ok(ms >= frequencyMs, `period ${period} is shorter than the ${frequencyMs}ms frequency`);
  }
});

test("the derived period is one the API has a rule builder for", () => {
  // An unlisted duration parses fine but is rejected as "period not
  // supported for alert".
  const supported = new Set(["5m", "10m", "15m", "20m", "30m", "1h"]);
  for (const frequencyMs of [MINUTE, 5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 30 * MINUTE, 60 * MINUTE]) {
    assert.ok(supported.has(periodFor(frequencyMs)), `${frequencyMs}ms produced an unsupported period`);
  }
});

test("a frequency slower than the longest period yields no period at all", () => {
  // The preset stops applying to that check rather than 400ing.
  assert.equal(periodFor(2 * 60 * MINUTE), undefined);
});

test("each candidate gets the period matching its own frequency", () => {
  const periodOf = (target) => alertsForCheck(target, ["ProbeFailedExecutionsTooHigh"])[0].period;
  assert.equal(periodOf(UPTIME), "10m");
  assert.equal(periodOf(BROWSER), "20m");
  assert.equal(periodOf(AI_ENDPOINT), "30m");
  assert.equal(periodOf(SSL), "1h");
});

test("probe failures apply to every check type", () => {
  for (const target of [UPTIME, BROWSER, SSL, AI_ENDPOINT]) {
    const alerts = alertsForCheck(target, ["ProbeFailedExecutionsTooHigh"]);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].threshold, 1);
  }
});

test("certificate expiry is dropped for a browser check and kept for an http one", () => {
  // If this regresses, every SSL check in a pass fails with "invalid check
  // type for alert". Dropping it costs nothing, since probe failures cover
  // cert expiry for that check anyway (see the note on the preset).
  assert.deepEqual(alertsForCheck(SSL, ["TLSTargetCertificateCloseToExpiring"]), []);
  assert.equal(
    alertsForCheck(SSL, ["ProbeFailedExecutionsTooHigh"]).length,
    1,
    "the SSL check still alerts, via probe failures",
  );
  const [alert] = alertsForCheck(UPTIME, ["TLSTargetCertificateCloseToExpiring"]);
  assert.equal(alert.name, "TLSTargetCertificateCloseToExpiring");
  assert.equal(alert.threshold, 30);
  // Certificate expiry's only rule-catalogue key is the empty period.
  assert.equal(alert.period, "");
});

test("http latency is dropped for a browser check", () => {
  assert.deepEqual(alertsForCheck(BROWSER, ["HTTPRequestDurationTooHighAvg"]), []);
  assert.equal(alertsForCheck(UPTIME, ["HTTPRequestDurationTooHighAvg"])[0].threshold, 300);
});

test("an unpicked preset is never sent", () => {
  assert.deepEqual(alertsForCheck(UPTIME, []), []);
  const names = alertsForCheck(UPTIME, ["ProbeFailedExecutionsTooHigh"]).map((a) => a.name);
  assert.deepEqual(names, ["ProbeFailedExecutionsTooHigh"]);
});

test("the picker only offers presets that apply to something in the pass", () => {
  // Showing one would mean ticking a box that silently does nothing.
  const browserOnly = presetsFor([BROWSER, SSL]).map((e) => e.preset.name);
  assert.deepEqual(browserOnly, ["ProbeFailedExecutionsTooHigh"]);

  const mixed = presetsFor([UPTIME, BROWSER, SSL, AI_ENDPOINT]).map((e) => e.preset.name);
  assert.deepEqual(mixed, [
    "ProbeFailedExecutionsTooHigh",
    "TLSTargetCertificateCloseToExpiring",
    "HTTPRequestDurationTooHighAvg",
  ]);
});

test("the picker reports how many checks each preset covers", () => {
  const entries = presetsFor([UPTIME, BROWSER, SSL, AI_ENDPOINT]);
  const byName = Object.fromEntries(entries.map((e) => [e.preset.name, e.targets.length]));
  assert.equal(byName.ProbeFailedExecutionsTooHigh, 4);
  // http only, so Uptime and the AI endpoint.
  assert.equal(byName.TLSTargetCertificateCloseToExpiring, 2);
  assert.equal(byName.HTTPRequestDurationTooHighAvg, 2);
});

test("failures and certificate expiry are ticked by default, latency is not", () => {
  // See the note on the latency preset.
  const defaults = presetsFor([UPTIME])
    .filter((e) => e.preset.selectedByDefault)
    .map((e) => e.preset.name);
  assert.deepEqual(defaults, ["ProbeFailedExecutionsTooHigh", "TLSTargetCertificateCloseToExpiring"]);
});

test("preset rows report the threshold and the scope, and stay inside 80 columns", () => {
  // The description carries the threshold, the meta carries the scope, and
  // neither carries a period (see presetDescription).
  const entries = presetsFor([UPTIME, BROWSER, SSL, AI_ENDPOINT]);
  const byName = Object.fromEntries(entries.map((e) => [e.preset.name, e]));
  assert.equal(presetDescription(byName.ProbeFailedExecutionsTooHigh.preset), "alert after 1 failed run");
  assert.equal(presetMeta(byName.ProbeFailedExecutionsTooHigh), "(4 checks)");
  assert.equal(presetDescription(byName.TLSTargetCertificateCloseToExpiring.preset), "alert 30 days before expiry");
  assert.equal(presetMeta(byName.TLSTargetCertificateCloseToExpiring), "(2 checks)");
  assert.equal(presetDescription(byName.HTTPRequestDurationTooHighAvg.preset), "alert above 300ms average");

  // CheckboxList pads these into aligned columns, so the widest row
  // decides whether the picker wraps. An earlier version of these strings
  // pushed it past a standard terminal.
  const labelWidth = Math.max(...entries.map((e) => e.preset.label.length));
  const descWidth = Math.max(...entries.map((e) => presetDescription(e.preset).length));
  const metaWidth = Math.max(...entries.map((e) => presetMeta(e).length));
  const widest = 2 + 4 + labelWidth + 2 + descWidth + 1 + metaWidth;
  assert.ok(widest <= 80, `widest preset row is ${widest} columns`);
});

test("the threshold is never written into a row twice", () => {
  // So a changed threshold can't leave a stale copy behind in prose.
  for (const entry of presetsFor([UPTIME])) {
    assert.match(presetDescription(entry.preset), new RegExp(String(entry.preset.threshold)));
  }
});

test("a placeholder address is recognised by its brackets, not its domain", () => {
  // The domain varies by what Cloud provisioned, so matching on it would
  // miss one of these.
  assert.ok(isPlaceholderAddresses("<example@mail.com>"));
  assert.ok(isPlaceholderAddresses("<example@example.com>"));
  assert.ok(isPlaceholderAddresses(" <example@mail.com> "));
  assert.ok(isPlaceholderAddresses("<a@b.com>;<c@d.com>"));
});

test("a real address is never treated as a placeholder", () => {
  // A false positive means offering to overwrite a real address.
  assert.equal(isPlaceholderAddresses("oncall@corp.com"), false);
  assert.equal(isPlaceholderAddresses("alerts@example.com"), false);
  assert.equal(isPlaceholderAddresses("alerts@example-corp.com"), false);
  assert.equal(isPlaceholderAddresses(""), false);
  // One real address among placeholders means the field is in use.
  assert.equal(isPlaceholderAddresses("<example@mail.com>;real@corp.com"), false);
});

test("addresses round-trip through the separator Grafana splits on", () => {
  // All three have to parse on the way in, and ";" goes back out.
  assert.deepEqual(parseAddresses("a@b.com, c@d.com"), ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseAddresses("a@b.com;c@d.com"), ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseAddresses("a@b.com c@d.com"), ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseAddresses("   "), []);
  assert.equal(joinAddresses(parseAddresses("a@b.com, c@d.com")), "a@b.com;c@d.com");
});

test("address validation catches an obvious typo and nothing more", () => {
  assert.ok(isEmailish("oncall@corp.com"));
  assert.ok(isEmailish("a.b+tag@sub.corp.co.uk"));
  assert.equal(isEmailish("oncall"), false);
  assert.equal(isEmailish("oncall@corp"), false);
  assert.equal(isEmailish("oncall @corp.com"), false);
});
