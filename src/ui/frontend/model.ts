import type { FaroApp } from "../../products/frontendO11y/faroAuth.js";
import type { FaroInstrumentation, FrontendTarget, ReplayMasking } from "../../products/frontendO11y/instrument.js";
import type { CommonInputs, CommonState } from "../workflow/commonSteps.js";
import type { StepContext, WorkflowState } from "../workflow/controller.js";

export const FRONTEND_STEPS = {
  gcx: "Install Grafana Cloud CLI (gcx)",
  auth: "Authenticate with OAuth",
  "pick-app": "Pick and configure app",
  instrument: "Instrument project with Faro SDK",
};
export type FrontendStep = keyof typeof FRONTEND_STEPS;
export interface FrontendInputs extends CommonInputs {
  app: FaroApp | undefined;
  createApp: boolean;
  collectorUrl: string;
  sampling: string;
  replay: boolean;
  masking: ReplayMasking;
}
export interface FrontendState extends WorkflowState<FrontendStep>, CommonState {
  target?: Exclude<FrontendTarget, { kind: "unsupported" }>;
  apps: FaroApp[];
  appUrl?: string;
  instrumentation?: FaroInstrumentation;
  // instrumentation is populated with placeholder defaults the moment an app
  // is chosen, so its fields' own presence can't tell a real answer apart
  // from the default — these flags can. samplingKnown/replayKnown flip true
  // only once "sampling"/"replay" are actually answered; replayMaskingKnown
  // stays false between answering "replay" and (if enabled) actually
  // answering "masking".
  samplingKnown: boolean;
  replayKnown: boolean;
  replayMaskingKnown: boolean;
  progress: number;
  error?: string;
  instrumentedFiles?: { file: string; created: boolean }[];
}
export interface FrontendOptions {
  stackUrl: string;
  forceGcxInstall: boolean;
  appName?: string;
  cwd: string;
}
export type FrontendContext = StepContext<FrontendState, FrontendInputs>;
