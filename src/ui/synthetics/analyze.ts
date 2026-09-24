import type { StepResult } from "../workflow/controller.js";
import { MIN_SPINNER_MS } from "../shared.js";
import type { SyntheticsContext, SyntheticsOptions, SyntheticsStep } from "./model.js";
import type { SyntheticsServices } from "./services.js";

export async function analyze(
  ctx: SyntheticsContext,
  services: SyntheticsServices,
  options: SyntheticsOptions,
): Promise<StepResult<SyntheticsStep>> {
  const mode = ctx.get().analyzeMode;
  const target = /^https?:\/\//.test(options.targetUrl) ? options.targetUrl : `https://${options.targetUrl}`;
  if (mode === "fast") {
    const [candidates] = await ctx.wait(Promise.all([services.candidatesFor(target), services.sleep(5000)]));
    ctx.update({
      candidates,
      selectedKeys: candidates.filter((candidate) => candidate.selectedByDefault).map((candidate) => candidate.key),
    });
    return { next: "create", properties: { status: "ok", analyze_mode: mode, default_candidates: candidates.length } };
  }
  const log = (detail: string) =>
    ctx.update({ pendingNextStepLog: { key: "browser-discovery", label: "Find additional synthetic checks", detail } });
  if (ctx.get().auth.error) {
    log(`Grafana Assistant isn't signed in (${ctx.get().auth.error}). Skipped.`);
    return { next: "next-steps", properties: { status: "skipped", analyze_mode: mode } };
  }
  ctx.update({ analyzeProgress: 0 });
  const progress = services.startFakeProgress(
    (value) => ctx.update({ analyzeProgress: value }),
    () => ctx.signal.aborted,
    60_000,
  );
  ctx.onCleanup(() => progress.stop());
  await ctx.wait(services.sleep(6000));
  progress.pause();
  const allowed = await ctx.ask("browser");
  progress.resume();
  if (!allowed) {
    log("Skipped. No browser opened.");
    return {
      next: "next-steps",
      properties: { status: "declined", analyze_mode: mode, browser_permission: "declined" },
    };
  }
  try {
    const [discovered] = await ctx.wait(
      Promise.all([
        services.aiEndpointCandidatesFor(target, options.stackUrl, () => true),
        services.sleep(MIN_SPINNER_MS),
      ]),
    );
    const state = ctx.get();
    const known = new Set(state.candidates.map((candidate) => candidate.key));
    const fresh = discovered.filter((candidate) => {
      if (known.has(candidate.key)) return false;
      known.add(candidate.key);
      return true;
    });
    log(fresh.length ? `${fresh.length} new checks found.` : "No new endpoints found.");
    ctx.update({ candidates: [...state.candidates, ...fresh] });
    if (fresh.length) await ctx.wait(progress.finish());
    return {
      next: fresh.length ? "create" : "next-steps",
      properties: { status: "ok", analyze_mode: mode, browser_permission: "allowed", ai_candidates: fresh.length },
    };
  } catch {
    log("Couldn't discover additional endpoints.");
    return { next: "next-steps", properties: { status: "failed", analyze_mode: mode, browser_permission: "allowed" } };
  }
}
