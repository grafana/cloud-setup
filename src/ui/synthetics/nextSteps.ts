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
      ctx.update({ outcome: "ok" });
      return { next: "done", properties: { status: "ok" } };
    }
    if (action === "browser-discovery") {
      ctx.update({ items: [], analyzeMode: "browser-discovery" });
      return { next: "analyze" };
    }
    if (action === "configure-skills") {
      ctx.update({ configuringSkills: true });
      let detail: string;
      try {
        const status = await ctx.wait(services.getSkillStatus());
        const [result] = await ctx.wait(
          Promise.all([status.installed ? status : services.installSkill(), services.sleep(MIN_SPINNER_MS)]),
        );
        detail = result.path ? `Wrote to ${path.relative(options.cwd, result.path)}` : "Couldn't configure the skill.";
      } catch (error) {
        ctx.signal.throwIfAborted();
        detail = `Couldn't configure the skill (${error instanceof Error ? error.message : String(error)}).`;
      }
      ctx.update({
        configuringSkills: false,
        nextStepsLog: [...ctx.get().nextStepsLog, { key: "configure-skills", label: "Configure agent skills", detail }],
      });
      continue;
    }
    ctx.update({ exporting: true });
    let detail: string;
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
      detail = `Couldn't export (${error instanceof Error ? error.message : String(error)}).`;
    }
    ctx.update({
      exporting: false,
      nextStepsLog: [...ctx.get().nextStepsLog, { key: "export", label: "Export checks as Terraform", detail }],
    });
  }
}
