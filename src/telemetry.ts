import crypto from "node:crypto";
import Analytics from "@rudderstack/rudder-sdk-node";
import { ensureAssistantAuth } from "./harness/index.js";

// setup-cli's own dedicated RudderStack source — never reuse this key elsewhere, and never point this at another source's key.
const DEFAULT_WRITE_KEY = "3JOyeIKkNErApzVtlBJv1z5wHwy";
const DEFAULT_DATA_PLANE_URL = "https://grafanadabncka.dataplane.rudderstack.com";

type Mode = "enabled" | "disabled" | "log";

function resolveMode(): Mode {
  const raw = (process.env.SETUP_CLI_TELEMETRY ?? "").trim().toLowerCase();
  if (raw === "enabled" || raw === "disabled" || raw === "log") return raw;
  if (raw !== "") return "disabled";
  if (["1", "true"].includes((process.env.DO_NOT_TRACK ?? "").trim().toLowerCase())) return "disabled";
  return "enabled";
}

const mode = resolveMode();

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

// Fallback only — overwritten once resolveIdentity succeeds, never persisted.
let identity: Identity = { anonymousId: crypto.randomUUID() };

const IDENTITY_FETCH_TIMEOUT_MS = 4000;

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
    // Falls back to the ephemeral anonymousId.
  }
}

export type Command = "frontend" | "synthetics";
export type Outcome = "ok" | "error" | "canceled";

let pending: Promise<void> = Promise.resolve();

function send(event: string, stackUrl: string, properties: Record<string, string | number | boolean>): void {
  if (mode === "disabled") return;
  if (mode === "log") {
    console.error("[telemetry]", { event, ...properties });
    return;
  }

  pending = (async () => {
    await resolveIdentity(stackUrl);
    client!.track({
      ...(identity.userId ? { userId: identity.userId } : { anonymousId: identity.anonymousId! }),
      event,
      properties: { ...(identity.orgId ? { org_id: identity.orgId } : {}), ...properties },
    });
    await new Promise<void>((resolve) => client!.flush(() => resolve()));
  })().catch(() => {
    // Fire-and-forget — telemetry must never surface an error or affect the command's own outcome.
  });
}

// Fired once per wizard step completed (advance() in FrontendApp.tsx/SetupApp.tsx) — `step` is a
// closed-vocabulary property (each command's own StepId), not baked into the event name, so funnel
// drop-off is one group-by rather than a UNION across per-step event tables.
export function recordStep(command: Command, stackUrl: string, step: string): void {
  send(`setup_cli_${command}_completed_step`, stackUrl, { step });
}

export function recordRun(command: Command, stackUrl: string, outcome: Outcome, durationMs: number, properties: Record<string, string | number | boolean> = {}): void {
  send(`setup_cli_${command}_finished_setup`, stackUrl, { outcome, duration_ms: durationMs, ...properties });
}

const SHUTDOWN_TIMEOUT_MS = 1500;

export function waitForTelemetry(): Promise<void> {
  if (mode !== "enabled") return Promise.resolve();
  return Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))]);
}
