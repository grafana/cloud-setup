import path from "node:path";
import { MIN_SPINNER_MS } from "../shared.js";
import type { StepResult } from "../workflow/controller.js";
import { availableActions, type SyntheticsContext, type SyntheticsOptions, type SyntheticsStep } from "./model.js";
import type { SyntheticsServices } from "./services.js";

export async function nextSteps(
  ctx: SyntheticsContext,
  services: SyntheticsServices,
  options: SyntheticsOptions,
): Promise<StepResult<SyntheticsStep>> {
  const pending = ctx.get().pendingNextStepLog;
  if (pending) ctx.update({ nextStepsLog: [...ctx.get().nextStepsLog, pending], pendingNextStepLog: undefined });
  for (;;) {
    const action = availableActions(ctx.get()).length ? await ctx.ask("nextAction") : "finish";
    if (action === "finish") {
      // Only export counts toward the overall outcome — configuring the
      // skill (like the old dedicated step it replaced) is a nice-to-have,
      // never required for a successful setup.
      const exportFailed = ctx.get().nextStepsLog.some((entry) => entry.key === "export" && entry.status === "failed");
      return { next: "done", properties: { status: exportFailed ? "failed" : "ok" } };
    }
    if (action === "browser-discovery") {
      ctx.update({ items: [], analyzeMode: "browser-discovery" });
      return { next: "analyze" };
    }
    if (action === "configure-skills") {
      ctx.update({ configuringSkills: true });
      let detail: string;
      let status: "ok" | "failed" = "ok";
      try {
        const skillStatus = await ctx.wait(services.getSkillStatus());
        const [result] = await ctx.wait(
          Promise.all([
            skillStatus.installed ? skillStatus : services.installSkill(),
            services.sleep(MIN_SPINNER_MS),
          ]),
        );
        if (result.path) {
          detail = `Wrote to ${path.relative(options.cwd, result.path)}`;
        } else {
          status = "failed";
          detail = "Couldn't configure the skill.";
        }
      } catch (error) {
        ctx.signal.throwIfAborted();
        status = "failed";
        detail = `Couldn't configure the skill (${error instanceof Error ? error.message : String(error)}).`;
      }
      ctx.update({
        configuringSkills: false,
        nextStepsLog: [
          ...ctx.get().nextStepsLog,
          { key: "configure-skills", label: "Configure agent skills", detail, status },
        ],
      });
      continue;
    }
    ctx.update({ exporting: true });
    let detail: string;
    let status: "ok" | "failed" = "ok";
    try {
      const { records, session } = ctx.get();
      if (!session) throw new Error("No Synthetic Monitoring session is available.");
      const config = Object.fromEntries(records.map((item) => [item.candidate.label, item.config]));
      const ids = new Map(
        records.filter((item) => item.id !== undefined).map((item) => [item.candidate.label, item.id!]),
      );
      const [written] = await ctx.wait(
        Promise.all([
          services.writeTerraformExport(config, session.probes, ids, options.stackUrl, session.url, options.cwd),
          services.sleep(MIN_SPINNER_MS),
        ]),
      );
      detail = `Wrote to ${path.relative(options.cwd, written)}`;
    } catch (error) {
      ctx.signal.throwIfAborted();
      status = "failed";
      detail = `Couldn't export (${error instanceof Error ? error.message : String(error)}).`;
    }
    ctx.update({
      exporting: false,
      nextStepsLog: [...ctx.get().nextStepsLog, { key: "export", label: "Export checks as Terraform", detail, status }],
    });
  }
}
