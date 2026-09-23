import assert from "node:assert/strict";
import { test } from "node:test";

const { alertsForCheck, alertsSummary, periodFor, presetsFor } =
  await import("../dist/products/syntheticMonitoring/checkAlerts.js");
const { isEmailish, joinAddresses, parseAddresses } =
  await import("../dist/products/syntheticMonitoring/notifications.js");

const MINUTE = 60 * 1000;

// What discover.ts actually generates. Not one of these runs fast enough
// for the SM app's own "5m" form default to be a legal period.
const HTTPS = "https://example.com";
const UPTIME = { target: HTTPS, frequencyMs: 10 * MINUTE, settings: { http: { method: "GET" } } };
const BROWSER = { target: HTTPS, frequencyMs: 20 * MINUTE, settings: { browser: { script: "" } } };
const SSL = { target: HTTPS, frequencyMs: 60 * MINUTE, settings: { browser: { script: "" } } };
const AI_ENDPOINT = { target: `${HTTPS}/api/profile`, frequencyMs: 30 * MINUTE, settings: { http: { method: "GET" } } };
// Same check type as UPTIME, but a target with no certificate to watch.
const UPTIME_PLAIN = { target: "http://example.com", frequencyMs: 10 * MINUTE, settings: { http: { method: "GET" } } };

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

test("certificate expiry is dropped for a plain-http target", () => {
  // The alert queries probe_ssl_earliest_cert_expiry, which the agent only
  // emits when the probe negotiates TLS. On an http:// target the rule
  // would be created and then sit on NoData forever, so it's dropped here
  // rather than shipped as a rule that can never fire. The check type is
  // identical to UPTIME's, so only the scheme can be doing this.
  assert.deepEqual(alertsForCheck(UPTIME_PLAIN, ["TLSTargetCertificateCloseToExpiring"]), []);
  assert.equal(alertsForCheck(UPTIME, ["TLSTargetCertificateCloseToExpiring"]).length, 1);

  // Probe failures are unaffected: those work on any target.
  assert.equal(alertsForCheck(UPTIME_PLAIN, ["ProbeFailedExecutionsTooHigh"]).length, 1);
});

test("a plain-http pass is not offered, or told about, a certificate alert", () => {
  // presetsFor drives the confirm question, so this is also what stops the
  // copy promising certificate monitoring for a target with no certificate.
  assert.deepEqual(
    presetsFor([UPTIME_PLAIN, BROWSER]).map((p) => p.name),
    ["ProbeFailedExecutionsTooHigh"],
  );
  assert.equal(alertsSummary(presetsFor([UPTIME_PLAIN, BROWSER])), "check failures");
});

test("an unpicked preset is never sent", () => {
  assert.deepEqual(alertsForCheck(UPTIME, []), []);
  const names = alertsForCheck(UPTIME, ["ProbeFailedExecutionsTooHigh"]).map((a) => a.name);
  assert.deepEqual(names, ["ProbeFailedExecutionsTooHigh"]);
});

test("a pass only gets the presets its check types qualify for", () => {
  // There's no picker, so this set is what gets turned on. Naming an alert
  // the pass can't have would also make the confirm screen lie.
  const browserOnly = presetsFor([BROWSER, SSL]).map((p) => p.name);
  assert.deepEqual(browserOnly, ["ProbeFailedExecutionsTooHigh"]);

  const mixed = presetsFor([UPTIME, BROWSER, SSL, AI_ENDPOINT]).map((p) => p.name);
  assert.deepEqual(mixed, ["ProbeFailedExecutionsTooHigh", "TLSTargetCertificateCloseToExpiring"]);
});

test("a preset counts for the pass if any one check qualifies", () => {
  // Per pass, not per check: certificate expiry survives a mixed pass on
  // the strength of its http checks, and alertsForCheck drops it again for
  // the browser ones.
  assert.deepEqual(
    presetsFor([SSL, UPTIME]).map((p) => p.name),
    ["ProbeFailedExecutionsTooHigh", "TLSTargetCertificateCloseToExpiring"],
  );
  assert.deepEqual(alertsForCheck(SSL, ["TLSTargetCertificateCloseToExpiring"]), []);
});

test("the confirm question names only what the pass will actually get", () => {
  // Reads as "Alert on <this>?" — a noun phrase, and one that must not
  // promise a certificate alert an all-browser pass can't have.
  assert.equal(
    alertsSummary(presetsFor([UPTIME, BROWSER, SSL, AI_ENDPOINT])),
    "check failures and expiring certificates",
  );
  assert.equal(alertsSummary(presetsFor([BROWSER, SSL])), "check failures");
  assert.equal(alertsSummary([]), "");
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
