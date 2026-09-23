import type { CheckSettings } from "./types.js";

// Structural rather than importing Candidate (discover.ts), so api.ts can
// import CheckAlert from here without pulling in the discovery chain.
// Candidate satisfies it as-is.
export interface AlertTarget {
  frequencyMs: number;
  settings: CheckSettings;
}

// Synthetic Monitoring's own per-check alerts. The SM API builds and
// provisions the Grafana-managed rule off the back of the PUT
// (github.com/grafana/synthetic-monitoring-api internal/alerts/rules.go),
// which is why nothing here authors PromQL.
//
// These are the two the wizard turns on. The API also has three latency
// alerts (HTTP/Ping/DNS RequestDurationTooHighAvg), left out because a
// latency budget needs to know something about the target and this wizard
// only knows its URL.
export type AlertPresetName = "ProbeFailedExecutionsTooHigh" | "TLSTargetCertificateCloseToExpiring";

// Matches the SM API's own CheckAlert model
// (github.com/grafana/synthetic-monitoring-api-go-client model/model.go).
// The API's rule catalogue is keyed on the exact period string, so the
// no-period preset has to send "" rather than omit the field.
export interface CheckAlert {
  name: AlertPresetName;
  threshold: number;
  period: string;
}

type CheckType = keyof CheckSettings;

// The only periods the SM API has rule builders for: anything else is
// rejected as "period not supported for alert" even though it parses fine
// as a duration. Ordered ascending, which periodFor relies on.
const ALERT_PERIODS = ["5m", "10m", "15m", "20m", "30m", "1h"] as const;

const ALERT_PERIOD_MS: Record<(typeof ALERT_PERIODS)[number], number> = {
  "5m": 5 * 60 * 1000,
  "10m": 10 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "20m": 20 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

// The SM API rejects a period shorter than the check's own frequency, and
// every candidate discover.ts generates runs at 10 minutes or slower — so
// a constant here (the SM app's form defaults to "5m") would be rejected
// for all of them. Smallest supported period that clears the frequency,
// or undefined when nothing does, which makes the preset inapplicable to
// that check rather than a 400.
export function periodFor(frequencyMs: number): string | undefined {
  return ALERT_PERIODS.find((p) => ALERT_PERIOD_MS[p] >= frequencyMs);
}

export interface AlertPreset {
  name: AlertPresetName;
  threshold: number;
  usesPeriod: boolean;
  // Sending an alert for a type the API doesn't accept it on fails the
  // whole check, so this gates which presets a pass gets.
  checkTypes: CheckType[];
}

// Thresholds match the SM app's own form defaults
// (github.com/grafana/synthetic-monitoring-app
// src/components/CheckForm/AlertsPerCheck/AlertsPerCheck.constants.tsx).
export const ALERT_PRESETS: AlertPreset[] = [
  {
    name: "ProbeFailedExecutionsTooHigh",
    // The API caps this at (period / frequency) * probes, which is always
    // at least 1 given periodFor's floor and runCreate refusing to run
    // with zero probes.
    threshold: 1,
    usesPeriod: true,
    checkTypes: ["http", "dns", "ping", "tcp", "traceroute", "grpc", "scripted", "browser", "multihttp"],
  },
  {
    name: "TLSTargetCertificateCloseToExpiring",
    threshold: 30,
    usesPeriod: false,
    // http and tcp only, so this does not attach to the wizard's own "SSL"
    // candidate, which is a k6 browser check. Not a gap worth routing
    // around: sslCheckScript already sets failOnNearExpiry with
    // warnDays: 30, so an expiring cert fails the check and probe failures
    // fire at the same threshold.
    checkTypes: ["http", "tcp"],
  },
];

// settingsSchema (types.ts) refines that exactly one key is present, so
// the first match is the only match.
function checkTypeOf(target: AlertTarget): CheckType | undefined {
  return (Object.keys(target.settings) as CheckType[]).find((k) => target.settings[k] !== undefined);
}

function appliesTo(preset: AlertPreset, target: AlertTarget): boolean {
  const type = checkTypeOf(target);
  if (!type || !preset.checkTypes.includes(type)) return false;
  return !preset.usesPeriod || periodFor(target.frequencyMs) !== undefined;
}

// Which presets a create pass gets: everything at least one of its checks
// qualifies for. Per pass rather than per check, so a mixed pass qualifies
// for the union and alertsForCheck narrows it again per check.
export function presetsFor(targets: AlertTarget[]): AlertPreset[] {
  return ALERT_PRESETS.filter((preset) => targets.some((t) => appliesTo(preset, t)));
}

// Presets are resolved per pass, not per check, so one that a mixed pass
// qualifies for has to resolve to nothing on the checks it doesn't apply
// to rather than failing them.
export function alertsForCheck(target: AlertTarget, selected: Iterable<AlertPresetName>): CheckAlert[] {
  const chosen = new Set(selected);
  const alerts: CheckAlert[] = [];
  for (const preset of ALERT_PRESETS) {
    if (!chosen.has(preset.name) || !appliesTo(preset, target)) continue;
    alerts.push({
      name: preset.name,
      threshold: preset.threshold,
      // appliesTo already established periodFor resolves here.
      period: preset.usesPeriod ? periodFor(target.frequencyMs)! : "",
    });
  }
  return alerts;
}

// One clause per preset for the confirm screen, with the threshold
// interpolated rather than restated so it can't drift from the value being
// sent. Says nothing about the period: it differs per check inside one
// pass, so any single number would be wrong for some of them.
function presetClause(preset: AlertPreset): string {
  switch (preset.name) {
    case "ProbeFailedExecutionsTooHigh":
      // At a threshold of 1 the literal "fails 1 time" is clumsy, and "starts
      // failing" says the same thing. Still branches on the threshold rather
      // than hard-coding either phrasing, so raising it can't leave the
      // sentence claiming something narrower than what's sent.
      return preset.threshold === 1 ? "a check starts failing" : `a check fails ${preset.threshold} times`;
    case "TLSTargetCertificateCloseToExpiring":
      return `a certificate is within ${preset.threshold} days of expiring`;
  }
}

// Reads into the confirm screen's sentence, so it stays a fragment:
// "... so you're notified when <this>." Built from what the pass actually
// qualifies for, since an all-browser pass gets no certificate alert and
// naming one there would be a lie.
export function alertsSummary(presets: AlertPreset[]): string {
  const clauses = presets.map(presetClause);
  if (clauses.length <= 1) return clauses.join("");
  return `${clauses.slice(0, -1).join(", ")} or ${clauses[clauses.length - 1]}`;
}
