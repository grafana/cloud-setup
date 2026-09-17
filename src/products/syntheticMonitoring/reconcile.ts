import type { RemoteCheck, SmClient } from "./api.js";
import type { CheckDefinition, CheckSettings, SyntheticConfig } from "./types.js";

// The SM API stores scripted/browser check bodies as base64, not plaintext —
// sending raw source fails with "failed to decode incoming check: illegal
// base64 data". Our own config model keeps the script as plain source (so a
// future Terraform export can emit it as-is); only the API payload needs it
// encoded.
function encodeSettings(settings: CheckSettings): CheckSettings {
  if (settings.scripted) {
    return { ...settings, scripted: { script: Buffer.from(settings.scripted.script, "utf8").toString("base64") } };
  }
  if (settings.browser) {
    return { ...settings, browser: { script: Buffer.from(settings.browser.script, "utf8").toString("base64") } };
  }
  return settings;
}

export const DEFAULT_FREQUENCY_MS = 60000;

// Matches the Synthetic Monitoring app's own default timeout (1 minute)
// for a new check — a prior flat 3000ms default here applied to every
// check regardless of type, which the SM UI's own editor then refuses to
// re-save (it enforces a 5s minimum), even though the API accepted it
// uncomplaining on create.
export const DEFAULT_TIMEOUT_MS = 60000;

export type PlanAction =
  | { kind: "create"; name: string; payload: Record<string, unknown> }
  | { kind: "update"; name: string; id: number; payload: Record<string, unknown> }
  | { kind: "noop"; name: string; id: number };

export interface Plan {
  actions: PlanAction[];
}

function toPayload(name: string, def: CheckDefinition, probeIds: Map<string, number>): Record<string, unknown> {
  const probes = def.probes.map((p) => {
    const id = probeIds.get(p);
    if (id === undefined) {
      throw new Error(`Check "${name}" references unknown probe "${p}"`);
    }
    return id;
  });

  const labels = Object.entries(def.labels ?? {}).map(([labelName, value]) => ({ name: labelName, value }));

  return {
    job: name,
    target: def.target,
    probes,
    labels,
    settings: encodeSettings(def.settings),
    frequency: def.frequency ?? DEFAULT_FREQUENCY_MS,
    timeout: def.timeout ?? DEFAULT_TIMEOUT_MS,
    enabled: def.enabled ?? true,
    alertSensitivity: def.alertSensitivity ?? "none",
    basicMetricsOnly: def.basicMetricsOnly ?? true,
  };
}

function sortedLabels(labels: { name: string; value: string }[]): { name: string; value: string }[] {
  return [...labels].sort((a, b) => a.name.localeCompare(b.name));
}

// True if every field present in `subset` deep-equals the corresponding field
// in `full`. Extra fields in `full` are ignored — needed because the SM API
// back-fills settings the config left unspecified with its own defaults
// (e.g. a dns check with no `protocol` comes back with `protocol: "TCP"`), so
// a config that only sets some fields must still compare equal to the
// server's filled-in version.
function isSubsetDeepEqual(subset: unknown, full: unknown): boolean {
  if (Array.isArray(subset)) {
    return Array.isArray(full) && subset.length === full.length && subset.every((v, i) => isSubsetDeepEqual(v, full[i]));
  }
  if (subset !== null && typeof subset === "object") {
    if (full === null || typeof full !== "object") return false;
    return Object.entries(subset).every(([k, v]) => isSubsetDeepEqual(v, (full as Record<string, unknown>)[k]));
  }
  return subset === full;
}

function isUnchanged(payload: Record<string, unknown>, existing: RemoteCheck): boolean {
  const current = {
    target: existing.target,
    probes: [...existing.probes].sort((a, b) => a - b),
    labels: sortedLabels(existing.labels),
    frequency: existing.frequency,
    timeout: existing.timeout,
    enabled: existing.enabled,
    alertSensitivity: existing.alertSensitivity,
    basicMetricsOnly: existing.basicMetricsOnly,
  };
  const desired = {
    target: payload.target,
    probes: [...(payload.probes as number[])].sort((a, b) => a - b),
    labels: sortedLabels(payload.labels as { name: string; value: string }[]),
    frequency: payload.frequency,
    timeout: payload.timeout,
    enabled: payload.enabled,
    alertSensitivity: payload.alertSensitivity,
    basicMetricsOnly: payload.basicMetricsOnly,
  };
  return JSON.stringify(current) === JSON.stringify(desired) && isSubsetDeepEqual(payload.settings, existing.settings);
}

export async function plan(config: SyntheticConfig, client: SmClient): Promise<Plan> {
  const probes = await client.listProbes();
  const probeIds = new Map(probes.map((p) => [p.name, p.id]));

  const actions: PlanAction[] = [];

  for (const [name, def] of Object.entries(config)) {
    const payload = toPayload(name, def, probeIds);
    const existing = await client.findCheck(name, def.target);

    if (!existing) {
      actions.push({ kind: "create", name, payload });
    } else if (isUnchanged(payload, existing)) {
      actions.push({ kind: "noop", name, id: existing.id });
    } else {
      actions.push({
        kind: "update",
        name,
        id: existing.id,
        payload: { ...payload, id: existing.id, tenantId: existing.tenantId },
      });
    }
  }

  return { actions };
}
