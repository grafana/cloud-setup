import path from "node:path";
import { debugLog } from "../../debug.js";
import type { StepProperties } from "../../telemetry.js";
import { MIN_SPINNER_MS } from "../shared.js";
import type { ReplayMasking } from "../../products/frontendO11y/instrument.js";
import type { FrontendContext, FrontendOptions } from "./model.js";
import type { FrontendServices } from "./services.js";

export function parseSamplingRateInput(raw: string): number {
  const percent = Number(raw.trim().replace(/%$/, ""));
  return !Number.isFinite(percent) || percent <= 0 ? 1 : Math.min(100, percent) / 100;
}

export async function pickApp(
  ctx: FrontendContext,
  services: FrontendServices,
  options: FrontendOptions,
): Promise<StepProperties> {
  const { cwd, stackUrl, appName } = options;
  const target = services.detectFrontendTarget(cwd);
  if (target.kind === "unsupported")
    throw new Error("This project doesn't have a supported Next.js layout or JS/TS entry file.");
  ctx.update({ target });
  let resolution: StepProperties["app_resolution"] = "manual";
  let name: string;
  let collectorUrl: string;
  let appUrl = `${stackUrl.replace(/\/$/, "")}/a/grafana-kowalski-app`;
  const transition = () => ctx.wait(services.sleep(500));
  try {
    const [faro] = await ctx.wait(
      Promise.all([
        ctx.get().auth.error ? undefined : services.tryFaroClient(stackUrl),
        services.sleep(MIN_SPINNER_MS),
      ]),
    );
    let chosen;
    if (appName) {
      chosen = faro ? await ctx.wait(faro.findExisting(appName)) : undefined;
      if (chosen) resolution = "named";
    } else {
      const apps = faro ? await ctx.wait(faro.list()) : [];
      if (apps.length === 1) {
        chosen = apps[0];
        resolution = "auto_single";
      } else if (apps.length > 1) {
        ctx.update({ apps });
        chosen = await ctx.ask("app");
        if (chosen) resolution = "picker";
      }
    }
    if (!chosen) {
      await transition();
      if (!(await ctx.ask("createApp"))) {
        ctx.update({ error: "declined" });
        return { status: "declined", app_resolution: resolution };
      }
      name = appName ?? services.readPkgName(cwd) ?? path.basename(cwd);
      const [created] = await ctx.wait(
        Promise.all([
          faro?.create(name).catch((error: unknown) => {
            debugLog("faro create", String(error));
            return undefined;
          }),
          services.sleep(500),
        ]),
      );
      chosen = created;
      if (created) resolution = "created";
    }
    if (chosen) {
      name = chosen.name;
      collectorUrl = `${chosen.collectEndpointURL}/${chosen.appKey}`;
      if (chosen.id) appUrl += `/apps/${chosen.id}`;
    } else {
      name = appName ?? services.readPkgName(cwd) ?? path.basename(cwd);
      services.openFrontendO11ySetupPage(stackUrl);
      collectorUrl = await ctx.ask("collectorUrl");
    }
  } catch (error) {
    ctx.update({ error: error instanceof Error ? error.message : String(error) });
    return { status: "failed", app_resolution: resolution };
  }
  const instrumentation = {
    name,
    collectorUrl,
    version: services.readPkgVersion(cwd),
    environmentExpr: services.detectEnvironmentExpr(target),
    sessionPersistent: false,
    sessionReplay: false,
    replayMasking: "balanced" as const,
    samplingRate: 1,
  };
  ctx.update({ appUrl, instrumentation });
  await transition();
  const samplingRate = parseSamplingRateInput(await ctx.ask("sampling"));
  ctx.update({ instrumentation: { ...instrumentation, samplingRate } });
  await transition();
  const sessionReplay = await ctx.ask("replay");
  // Reveal "enabled"/"disabled" right away — that much is genuinely decided
  // — but replayMaskingKnown stays false, since `instrumentation.
  // replayMasking` is still its placeholder default here, not a real
  // choice. Without that flag the render would show "enabled (balanced)"
  // before the user has actually been asked, or answered, the masking
  // question below.
  ctx.update({ instrumentation: { ...instrumentation, samplingRate, sessionReplay }, replayMaskingKnown: false });
  let replayMasking: ReplayMasking = instrumentation.replayMasking;
  if (sessionReplay) {
    await transition();
    replayMasking = await ctx.ask("masking");
  }
  ctx.update({
    instrumentation: { ...instrumentation, samplingRate, sessionReplay, replayMasking },
    replayMaskingKnown: true,
  });
  return {
    status: "ok",
    app_resolution: resolution,
    sampling_rate: Math.round(samplingRate * 100),
    session_replay: sessionReplay,
    ...(sessionReplay ? { replay_masking: replayMasking } : {}),
  };
}
