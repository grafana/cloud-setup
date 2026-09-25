import { recordStep, type StepProperties } from "../../telemetry.js";
import { initialCommonState, runAuth, runGcx } from "../workflow/commonSteps.js";
import { WorkflowController } from "../workflow/controller.js";
import { instrument } from "./instrument.js";
import type { FrontendInputs, FrontendOptions, FrontendState, FrontendStep } from "./model.js";
import { pickApp } from "./pickApp.js";
import { frontendServices, type FrontendServices } from "./services.js";

export function createFrontendController(
  options: FrontendOptions,
  services: FrontendServices = frontendServices,
  record: (step: FrontendStep, properties: StepProperties) => void = (step, properties) =>
    recordStep("frontend", options.stackUrl, step, properties),
) {
  return new WorkflowController<FrontendState, FrontendInputs>(
    {
      ...initialCommonState,
      currentStep: "gcx",
      started: false,
      completed: new Set(),
      results: {},
      failedSteps: new Set(),
      done: false,
      outcome: "incomplete",
      apps: [],
      replayMaskingKnown: false,
      progress: 0,
    },
    {
      gcx: async (ctx) => ({ properties: await runGcx(ctx, services, options.forceGcxInstall), next: "auth" }),
      auth: async (ctx) => ({ properties: await runAuth(ctx, services, options.stackUrl), next: "pick-app" }),
      "pick-app": async (ctx) => ({ properties: await pickApp(ctx, services, options), next: "instrument" }),
      instrument: async (ctx) => ({ properties: await instrument(ctx, services, options), next: "done" }),
    },
    record,
    ["pick-app", "instrument"],
  );
}
