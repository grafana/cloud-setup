import { K6_V2_CHANNEL, SmApiError, type Probe } from "../../products/syntheticMonitoring/api.js";
import type { Candidate } from "../../products/syntheticMonitoring/discover.js";
import { orderProbes } from "../../products/syntheticMonitoring/probes.js";
import type { SyntheticConfig } from "../../products/syntheticMonitoring/types.js";
import type { StepProperties } from "../../telemetry.js";
import { MIN_SPINNER_MS } from "../shared.js";
import { connect } from "./connect.js";
import { unhandledCandidates, type CreationItem, type SyntheticsContext, type SyntheticsOptions } from "./model.js";
import type { SyntheticsServices } from "./services.js";

// Only `null` for this channel actually means "not eligible" — the probe
// reported k6 versions and none satisfy it. An absent key or "unknown"
// means we don't have enough information, and the SM API itself allows
// those by default (see synthetic-monitoring-api's
// probeK6ChannelsValidator), so this stays permissive to match.
function supportsK6Channel(probe: Probe): boolean {
  return probe.k6Versions?.[K6_V2_CHANNEL] !== null;
}

// One shared, ordered probe list for the whole pass rather than each
// candidate re-filtering session.probes on its own — otherwise a plain
// HTTP check (no capability needs) and a browser check (SSL/broken-links,
// needs k6 v2) can end up drawing from different-looking slices of the
// same list, so a check asking for 1 probe might land on a different
// location than the first of another check's 3, which reads as arbitrary.
// Filtering once up front, if anything selected needs it, means every
// candidate's `probeCount` is just a prefix of this same list — a smaller
// pick is always among a bigger one's.
//
// SSL and broken-links checks both run as a k6 script (settings.browser),
// assigned to the v2 channel (see reconcile.ts's toPayload) — probes
// predating the k6 runner, or whose k6 version doesn't satisfy that
// channel, would otherwise still get slotted in and just fail to execute.
// Only fall back to the full set if filtering would leave none at all (a
// check with zero probes is a worse outcome than one that might not run on
// every probe it was told to try).
function eligibleProbes(probes: Probe[], selected: Candidate[]): Probe[] {
  if (!selected.some((candidate) => candidate.settings.browser)) return probes;
  const capable = probes.filter((probe) => !probe.capabilities?.disableBrowserChecks && supportsK6Channel(probe));
  return capable.length ? capable : probes;
}

export async function createChecks(
  ctx: SyntheticsContext,
  services: SyntheticsServices,
  options: SyntheticsOptions,
): Promise<StepProperties> {
  ctx.update({ createPhase: "reviewing" });
  const chosen = await ctx.ask("selection");
  ctx.update({ selectedKeys: chosen });
  const session = await connect(ctx, services, options);
  ctx.update({ createPhase: "creating" });
  const selected = unhandledCandidates(ctx.get()).filter((candidate) => chosen.includes(candidate.key));
  if (!session.probes.length) throw new Error("No probes are available on this tenant.");
  const probePool = orderProbes(eligibleProbes(session.probes, selected), session.url);
  let items: CreationItem[] = selected.map((candidate) => {
    const probes = probePool.slice(0, candidate.probeCount).map((probe) => probe.name);
    return {
      candidate,
      pass: ctx.get().analyzeMode,
      probes,
      status: "pending",
      config: { target: candidate.target, probes, settings: candidate.settings, frequency: candidate.frequencyMs },
    };
  });
  const config: SyntheticConfig = Object.fromEntries(items.map((item) => [item.candidate.label, item.config]));
  ctx.update({ items });
  const updateItem = (key: string, patch: Partial<CreationItem>) => {
    items = items.map((item) => (item.candidate.key === key ? { ...item, ...patch } : item));
    // Persist each successful result immediately, including partial passes.
    const records = new Map(ctx.get().records.map((item) => [item.candidate.key, item]));
    for (const item of items) if (item.id !== undefined) records.set(item.candidate.key, item);
    ctx.update({ items, records: [...records.values()] });
  };
  const plan = await ctx.wait(services.buildPlan(config, session.client));
  for (const action of plan.actions) {
    const candidate = selected.find((candidate) => candidate.label === action.name);
    if (!candidate) continue;
    updateItem(candidate.key, { status: "running" });
    if (action.kind === "noop") {
      await ctx.wait(services.sleep(MIN_SPINNER_MS));
      updateItem(candidate.key, { status: "skipped", id: action.id, detail: "already exists" });
      continue;
    }
    try {
      const [remote] = await ctx.wait(
        Promise.all([
          action.kind === "create"
            ? session.client.createCheck(action.payload)
            : session.client.updateCheck(action.payload),
          services.sleep(MIN_SPINNER_MS),
        ]),
      );
      updateItem(candidate.key, { status: action.kind === "create" ? "created" : "updated", id: remote.id });
    } catch (error) {
      updateItem(candidate.key, {
        status: "failed",
        detail: error instanceof SmApiError ? error.body : error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failed = items.find((item) => item.status === "failed");
  if (failed) throw new Error(`Could not create ${failed.candidate.title}: ${failed.detail}`);
  if (ctx.get().analyzeMode === "browser-discovery")
    ctx.update({
      pendingNextStepLog: {
        key: "browser-discovery",
        label: "Additional synthetic checks",
        status: "ok",
        items,
        detail: items.length ? undefined : "No checks created.",
      },
    });
  return {
    status: "ok",
    analyze_mode: ctx.get().analyzeMode,
    created: items.filter((item) => item.status === "created").length,
    updated: items.filter((item) => item.status === "updated").length,
    skipped: items.filter((item) => item.status === "skipped").length,
  };
}
