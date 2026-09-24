import {
  JAVASCRIPT_FARO_PACKAGES,
  REACT_FARO_PACKAGES,
  REPLAY_FARO_PACKAGE,
} from "../../products/frontendO11y/instrument.js";
import type { StepProperties } from "../../telemetry.js";
import type { FrontendContext, FrontendOptions } from "./model.js";
import type { FrontendServices } from "./services.js";

export async function instrument(
  ctx: FrontendContext,
  services: FrontendServices,
  { cwd, stackUrl }: FrontendOptions,
): Promise<StepProperties> {
  const { target, instrumentation } = ctx.get();
  if (!target || !instrumentation) return { status: "skipped" };
  const progress = services.startFakeProgress(
    (value) => ctx.update({ progress: value }),
    () => ctx.signal.aborted,
    45_000,
  );
  ctx.onCleanup(() => progress.stop());
  let complete = false;
  let packageInstall: "ok" | "failed" | undefined;
  let routerWired: boolean | undefined;
  let layoutWired: boolean | undefined;
  try {
    if (target.kind === "javascript") {
      services.insertFaroSnippet(cwd, target, instrumentation);
      complete = true;
      ctx.update({ instrumentedFile: target.file });
    } else if (target.kind === "react") {
      const result = await ctx.wait(services.instrumentReact(cwd, stackUrl, target.file, instrumentation));
      complete = result.complete;
      routerWired = Boolean(result.routerFile);
      ctx.update({
        instrumentedFile: result.routerFile
          ? `${result.entryFile}, router wrapped in ${result.routerFile}`
          : result.entryFile,
        error: result.complete ? undefined : (result.detail ?? "React instrumentation is incomplete."),
      });
    } else {
      const result = await ctx.wait(services.instrumentNextjs(cwd, stackUrl, instrumentation));
      complete = result.complete;
      layoutWired = Boolean(result.layoutFile);
      ctx.update({
        instrumentedFile: result.componentFile,
        error: result.complete
          ? undefined
          : (result.detail ?? "Add <FrontendObservability /> to the layout to finish instrumentation."),
      });
    }
    try {
      await ctx.wait(
        services.installFaroPackages(cwd, [
          ...(target.kind === "react" ? REACT_FARO_PACKAGES : JAVASCRIPT_FARO_PACKAGES),
          ...(instrumentation.sessionReplay ? [REPLAY_FARO_PACKAGE] : []),
        ]),
      );
      packageInstall = "ok";
    } catch (error) {
      packageInstall = "failed";
      ctx.update({ error: `Package install failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  } catch (error) {
    ctx.update({ error: error instanceof Error ? error.message : String(error) });
  }
  await ctx.wait(progress.finish());
  const outcome = complete && packageInstall === "ok" ? "ok" : "incomplete";
  ctx.update({ outcome });
  return {
    status: outcome === "ok" ? "ok" : "failed",
    instrumentation: complete ? "complete" : "partial",
    target_kind: target.kind,
    package_install: packageInstall,
    ...(routerWired !== undefined ? { router_wired: routerWired } : {}),
    ...(layoutWired !== undefined ? { layout_wired: layoutWired } : {}),
  };
}
