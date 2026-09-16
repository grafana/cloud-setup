import crypto from "node:crypto";
import Analytics from "@rudderstack/rudder-sdk-node";
import { ensureAssistantAuth } from "./harness/index.js";

// setup-cli's own dedicated RudderStack source — per grafana/ai-kit's
// rudderstack-event-design skill ("Never reuse an existing source's write
// key for a different application"), this must never be copy-pasted into
// another tool, and this tool must never point at anyone else's key.
// Safe to embed in the published package: a write key only authorizes
// *sending* events, never reading them back — the same property that lets
// every Grafana frontend ship one in its browser bundle. The env vars
// below exist only to point a dev build at a different source for testing.
const DEFAULT_WRITE_KEY = "3JOyeIKkNErApzVtlBJv1z5wHwy";
const DEFAULT_DATA_PLANE_URL = "https://grafanadabncka.dataplane.rudderstack.com";

type Mode = "enabled" | "disabled" | "log";

// Mirrors gcx's own telemetry.ResolveMode (internal/telemetry/telemetry.go):
// SETUP_CLI_TELEMETRY takes precedence, then the cross-tool DO_NOT_TRACK
// convention, defaulting to enabled. An unrecognised SETUP_CLI_TELEMETRY
// value fails toward privacy (disabled), not toward enabled.
function resolveMode(): Mode {
  const raw = (process.env.SETUP_CLI_TELEMETRY ?? "").trim().toLowerCase();
  if (raw === "enabled" || raw === "disabled" || raw === "log") return raw;
  if (raw !== "") return "disabled";
  if (["1", "true"].includes((process.env.DO_NOT_TRACK ?? "").trim().toLowerCase())) return "disabled";
  return "enabled";
}

const mode = resolveMode();

// flushAt: 1 — every run is a handful of calls over a few seconds at most,
// never worth batching; each track() should already be in flight rather
// than waiting on a queue threshold that a short-lived CLI process may
// never reach on its own.
const client =
  mode === "enabled"
    ? new Analytics(process.env.SETUP_CLI_TELEMETRY_WRITE_KEY || DEFAULT_WRITE_KEY, {
        dataPlaneUrl: process.env.SETUP_CLI_TELEMETRY_DATA_PLANE_URL || DEFAULT_DATA_PLANE_URL,
        flushAt: 1,
      })
    : undefined;

interface Identity {
  userId?: string;
  anonymousId?: string;
  orgId?: string;
}

// Never persisted to disk — only ever the fallback for a run where
// resolveIdentity below doesn't complete (auth declined/failed). Unlike
// gcx's genuinely anonymous device_id, this CLI's "auth" step already
// knows exactly who's running it by the time this could matter, so there
// is no meaningful anonymity being protected here — this random id is
// just a placeholder identity, not a privacy feature.
let identity: Identity = { anonymousId: crypto.randomUUID() };

const IDENTITY_FETCH_TIMEOUT_MS = 4000;

// Best-effort and capped. Reuses whatever OAuth token the run's own "auth"
// step already obtained — ensureAssistantAuth caches per stack for the
// process lifetime (harness/auth.ts), so this never pops open a second
// browser window — then reads the org/user that token belongs to via the
// same plugin-proxy pattern faroAuth.ts/smAuth.ts already use elsewhere in
// this codebase. Any failure (auth never happened, network, non-200) just
// leaves the ephemeral anonymousId above in place; never throws.
async function resolveIdentity(stackUrl: string): Promise<void> {
  try {
    const tokens = await ensureAssistantAuth(stackUrl);
    const proxyBase = `${tokens.apiEndpoint}/api/cli/v1/proxy`;
    const headers = { Authorization: `Bearer ${tokens.accessToken}` };
    const [orgRes, userRes] = await Promise.all([
      fetch(`${proxyBase}/api/org`, { headers, signal: AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS) }),
      fetch(`${proxyBase}/api/user`, { headers, signal: AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS) }),
    ]);
    const org = orgRes.ok ? ((await orgRes.json()) as { id?: number }) : undefined;
    const user = userRes.ok ? ((await userRes.json()) as { id?: number }) : undefined;
    if (user?.id === undefined) return;

    const userId = String(user.id);
    const orgId = org?.id !== undefined ? String(org.id) : undefined;
    identity = { userId, orgId };
    client?.identify({ userId, traits: orgId ? { org_id: orgId } : {} });
  } catch {
    // See above — falls back to the ephemeral anonymousId.
  }
}

export type Command = "frontend" | "synthetics";
export type Outcome = "ok" | "error" | "canceled";

let pending: Promise<void> = Promise.resolve();

// Event name: setup_cli_<command>_finished_setup — product ("setup_cli") _
// feature (the subcommand) _ action (past tense) _ context, per
// grafana/ai-kit's rudderstack-event-design naming schema. `outcome` is a
// property, not baked into the name (splitting ok/error/canceled into
// three event names would need UNIONing three tables to answer one
// question — the schema's own "gcom_billing_upgrade_clicked_*" example of
// what not to do). `org_id`/`user_id` are included explicitly because this
// is a server-side, non-Grafana-frontend source with no automatic
// identity attached the way a Grafana frontend event gets for free.
// Properties are always closed-vocabulary/low-cardinality — never a raw
// resource name, URL, or anything else content-bearing.
export function recordRun(command: Command, stackUrl: string, outcome: Outcome, durationMs: number, properties: Record<string, string | number | boolean> = {}): void {
  if (mode === "disabled") return;

  const event = `setup_cli_${command}_finished_setup`;
  if (mode === "log") {
    console.error("[telemetry]", { event, outcome, duration_ms: durationMs, ...properties });
    return;
  }

  pending = (async () => {
    await resolveIdentity(stackUrl);
    client!.track({
      ...(identity.userId ? { userId: identity.userId } : { anonymousId: identity.anonymousId! }),
      event,
      properties: {
        outcome,
        duration_ms: durationMs,
        ...(identity.orgId ? { org_id: identity.orgId } : {}),
        ...properties,
      },
    });
    await new Promise<void>((resolve) => client!.flush(() => resolve()));
  })().catch(() => {
    // Telemetry must never surface an error to the user or affect the
    // command's own outcome — same fire-and-forget contract as gcx's
    // Export(). A lost event is fine.
  });
}

const SHUTDOWN_TIMEOUT_MS = 1500;

// Bounds how long the CLI's exit path waits for recordRun's in-flight
// request/flush — a slow or unreachable endpoint costs this one fixed
// delay, never an indefinitely stuck exit. Never rejects.
export function waitForTelemetry(): Promise<void> {
  if (mode !== "enabled") return Promise.resolve();
  return Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))]);
}
