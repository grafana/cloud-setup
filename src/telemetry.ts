import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Grafana's shared usage-stats service, which Grafana, Loki, Mimir, Alloy, k6
// and gcx also report to.
const DEFAULT_ENDPOINT = "https://stats.grafana.org/cloud-setup-usage-report";

type Mode = "enabled" | "disabled" | "log";

// Only `dist` is published, so a sibling `src` means this is a source checkout
// rather than an installed package.
function isSourceCheckout(): boolean {
  try {
    const here = fileURLToPath(new URL("./", import.meta.url));
    return fs.existsSync(path.join(here, "..", "src"));
  } catch {
    return false;
  }
}

function resolveMode(): Mode {
  const raw = (process.env.CLOUD_SETUP_TELEMETRY ?? "").trim().toLowerCase();
  if (raw === "enabled" || raw === "disabled" || raw === "log") return raw;
  if (raw !== "") return "disabled";
  if (["1", "true"].includes((process.env.DO_NOT_TRACK ?? "").trim().toLowerCase())) return "disabled";
  // Development runs would otherwise be indistinguishable from real ones: the
  // version comes from package.json either way, so they could not be filtered
  // out afterwards. Set CLOUD_SETUP_TELEMETRY=enabled to report anyway.
  if (isSourceCheckout()) return "disabled";
  return "enabled";
}

const mode = resolveMode();
const endpoint = process.env.CLOUD_SETUP_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;

// Groups the events of one wizard run. Regenerated every invocation and never
// persisted, so it cannot identify a returning user.
const runId = crypto.randomUUID();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stateHome(): string | undefined {
  const configured = (process.env.XDG_STATE_HOME ?? "").trim();
  if (configured) return configured;
  try {
    const home = os.homedir();
    // With no home directory there is nowhere sensible to put the file — never
    // fall back to something relative to the working directory.
    return home ? path.join(home, ".local", "state") : undefined;
  } catch {
    return undefined;
  }
}

type DeviceIdentity = { device_id?: string };

// An anonymous per-install ID, so repeat runs from one machine can be told apart
// from one-off runs by different people. Deleting the file resets it.
//
// Reports nothing when it could not be persisted: a throwaway UUID would look
// like a real install and inflate any count of distinct installs, where an
// absent one drops out of those counts by itself.
function resolveDeviceIdentity(allowWrite: boolean): DeviceIdentity {
  const home = stateHome();
  if (!home) return {};
  const file = path.join(home, "cloud-setup", "device-id");

  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (UUID_PATTERN.test(existing)) return { device_id: existing };
  } catch {
    // Not written yet, or unreadable — fall through and try to create it.
  }

  // "log" mode reads an existing ID so its output is representative, but must
  // not create one: inspecting telemetry is not opting in.
  if (!allowWrite) return {};

  try {
    const fresh = crypto.randomUUID();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
    return { device_id: fresh };
  } catch {
    return {};
  }
}

// Resolved on the first event rather than at import, so an opted-out run never
// touches the filesystem.
let deviceIdentity: DeviceIdentity | undefined;
function currentDeviceIdentity(): DeviceIdentity {
  deviceIdentity ??= resolveDeviceIdentity(mode === "enabled");
  return deviceIdentity;
}

function cliVersion(): string | undefined {
  try {
    // new URL("./", ...) drops the query string the tests add to defeat the
    // ESM module cache.
    const here = fileURLToPath(new URL("./", import.meta.url));
    const raw = fs.readFileSync(path.join(here, "..", "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

const version = cliVersion();

type StackIdentity = { stack_id?: number };
const identities = new Map<string, StackIdentity>();

// The Cloud stack the wizard is working against, taken from the session the
// wizard already established. Keyed by stack URL so an identity can never
// attach to events for a different stack.
//
// Only known from sign-in onward, so earlier events in the same run carry no
// stack and are joined to it by run_id.
export function setStackIdentity(stackUrl: string, stackId: number | undefined): void {
  if (mode === "disabled") return;
  identities.set(stackUrl, stackId !== undefined ? { stack_id: stackId } : {});
}

export type Command = "frontend" | "synthetics";
// "no_tty" is a run that could not start at all because stdin is not a
// terminal, reported so that cohort is visible rather than silent.
export type Outcome = "ok" | "incomplete" | "error" | "canceled" | "no_tty";
type EventKind = "completed_step" | "finished_setup";

// How a step actually went. The wizard advances past a step whether it worked or
// not, so without this a broken step and a successful one look identical.
export type StepStatus = "ok" | "failed" | "declined" | "skipped" | "aborted";

// Closed set, so a mistyped key is a compile error rather than a silently
// ignored one.
export interface StepProperties {
  status: StepStatus;

  // gcx
  already_installed?: boolean;
  install_declined?: boolean;

  // auth
  auth_outcome?: "yes" | "declined" | "aborted" | "failed";

  // synthetics: analyze
  analyze_mode?: "fast" | "browser-discovery";
  default_candidates?: number;
  ai_candidates?: number;
  browser_permission?: "allowed" | "declined" | "skipped";

  // synthetics: create
  selected_default?: number;
  selected_ai?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;

  // synthetics: alerting. The step's two halves land independently, so
  // "rules_only" is alerts on the checks with no email destination (the
  // step declined, or the prompt left blank), and "unavailable" is no
  // session to reach the Alerting API with. A decline shows up as
  // status:"declined" alongside it, not as its own outcome.
  alerting_outcome?: "configured" | "rules_only" | "unavailable";
  alert_presets?: number;
  checks_alerted?: number;
  contact_point?: "created" | "updated" | "unchanged";
  notification_route?: "created" | "unchanged";

  // frontend: pick-app
  app_resolution?: "named" | "picker" | "created" | "manual";
  used_defaults?: boolean;
  session_replay?: boolean;
  replay_masking?: "strict" | "balanced" | "open";
  sampling_rate?: number;

  // frontend: instrument. Not named "outcome": that belongs to the run, and
  // reusing it here made one run report two conflicting outcomes.
  instrumentation?: "complete" | "partial";
  target_kind?: "javascript" | "react" | "nextjs" | "unsupported";
  package_install?: "ok" | "failed";
  router_wired?: boolean;
  layout_wired?: boolean;
}

const pending = new Set<Promise<void>>();

const REQUEST_TIMEOUT_MS = 1000;

function send(
  command: Command,
  event: EventKind,
  stackUrl: string,
  core: { step?: string; outcome?: Outcome; duration_ms?: number },
  properties: Record<string, string | number | boolean | undefined>,
): void {
  if (mode === "disabled") return;

  // Step properties go first so they can never shadow a field below: a step is
  // free to report a property called "command" or "os".
  const payload = {
    ...properties,
    service: "cloud-setup",
    ...(version !== undefined ? { version } : {}),
    os: process.platform,
    arch: process.arch,
    ...currentDeviceIdentity(),
    run_id: runId,
    ...identities.get(stackUrl),
    command,
    event,
    ...core,
  };

  if (mode === "log") {
    console.error("[telemetry]", payload);
    return;
  }

  // Fire and forget, one attempt, no retries: a lost event beats delaying the
  // user's exit. Wrapped because send() runs inside a step handler and inside
  // the exit path, where a throw would take the wizard down with it —
  // JSON.stringify throws on a value it cannot serialize, and the property
  // types above are only enforced at compile time.
  try {
    const delivery = fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).then(
      () => {},
      () => {},
    );
    pending.add(delivery);
    void delivery.then(() => pending.delete(delivery));
  } catch {
    // Dropped. Telemetry never changes the command's result.
  }
}

// One event per completed wizard step. `step` is a property rather than part of
// the event name, so drop-off is a group-by instead of a union across events.
export function recordStep(command: Command, stackUrl: string, step: string, properties: StepProperties): void {
  send(command, "completed_step", stackUrl, { step }, { ...properties });
}

export function recordRun(command: Command, stackUrl: string, outcome: Outcome, durationMs: number): void {
  send(command, "finished_setup", stackUrl, { outcome, duration_ms: durationMs }, {});
}

const SHUTDOWN_TIMEOUT_MS = 1500;

export async function waitForTelemetry(): Promise<void> {
  if (mode !== "enabled") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([...pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
