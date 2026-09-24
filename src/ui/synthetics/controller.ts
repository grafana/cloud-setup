import path from "node:path";
import { recordStep, type StepProperties } from "../../telemetry.js";
import { initialCommonState, runAuth, runGcx } from "../workflow/commonSteps.js";
import { WorkflowController } from "../workflow/controller.js";
import { analyze } from "./analyze.js";
import { createChecks } from "./create.js";
import { configureAlerting } from "./alerting.js";
import { nextSteps } from "./nextSteps.js";
import type { SyntheticsInputs, SyntheticsOptions, SyntheticsState, SyntheticsStep } from "./model.js";
import { syntheticsServices, type SyntheticsServices } from "./services.js";

export function createSyntheticsController(
  options: SyntheticsOptions,
  services: SyntheticsServices = syntheticsServices,
  record: (step: SyntheticsStep, properties: StepProperties) => void = (step, properties) =>
    recordStep("synthetics", options.stackUrl, step, properties),
) {
  return new WorkflowController<SyntheticsState, SyntheticsInputs>(
    {
      ...initialCommonState,
      currentStep: "gcx",
      started: false,
      completed: new Set(),
      results: {},
      done: false,
      outcome: "incomplete",
      candidates: [],
      selectedKeys: [],
      analyzeMode: "fast",
      analyzeProgress: 0,
      createPhase: "reviewing",
      baseUrl: options.baseUrl,
      items: [],
      records: [],
      alertingPhase: "confirm",
      alertingDetail: [],
      emailInput: "",
      nextStepsLog: [],
      exporting: false,
    },
    {
      gcx: async (ctx) => ({ properties: await runGcx(ctx, services, options.forceGcxInstall), next: "auth" }),
      auth: async (ctx) => ({ properties: await runAuth(ctx, services, options.stackUrl), next: "skills" }),
      skills: async (ctx) => {
        let installed = true;
        let skillPath: string | undefined;
        try {
          const status = await ctx.wait(services.getSkillStatus());
          if (status.installed) {
            skillPath = status.path;
            await ctx.wait(services.sleep(4500));
          } else {
            const [result] = await ctx.wait(Promise.all([services.installSkill(), services.sleep(4500)]));
            skillPath = result.path;
          }
        } catch {
          ctx.signal.throwIfAborted();
          installed = false;
        }
        ctx.update({ skillPath: skillPath ? path.relative(options.cwd, skillPath) : undefined });
        return { properties: { status: installed ? "ok" : "failed" }, next: "analyze" };
      },
      analyze: (ctx) => analyze(ctx, services, options),
      create: async (ctx) => ({ properties: await createChecks(ctx, services, options), next: "alerting" }),
      alerting: async (ctx) => ({ properties: await configureAlerting(ctx, services, options), next: "next-steps" }),
      "next-steps": (ctx) => nextSteps(ctx, services, options),
    },
    record,
  );
}
