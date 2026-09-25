import type { Candidate } from "../../products/syntheticMonitoring/discover.js";
import type { Probe, SmClient } from "../../products/syntheticMonitoring/api.js";
import type { AlertPresetName } from "../../products/syntheticMonitoring/checkAlerts.js";
import type { SyntheticConfig } from "../../products/syntheticMonitoring/types.js";
import type { StepProperties, StepStatus } from "../../telemetry.js";
import type { CommonInputs, CommonState } from "../workflow/commonSteps.js";
import type { StepContext, WorkflowState } from "../workflow/controller.js";

export const SYNTHETICS_STEPS = {
  gcx: "Install Grafana Cloud CLI (gcx)",
  auth: "Authenticate with OAuth",
  analyze: "Analyze target",
  create: "Create synthetic checks",
  alerting: "Configure alerts",
  "next-steps": "Next steps",
};
export type SyntheticsStep = keyof typeof SYNTHETICS_STEPS;
export type AnalyzeMode = "fast" | "browser-discovery";
export type CreatePhase =
  "reviewing" | "auto-discovering" | "base-url-input" | "connecting" | "token-input" | "validating" | "creating";
export type ItemStatus = "pending" | "running" | "created" | "updated" | "skipped" | "failed" | "not-run";
export interface CreationItem {
  candidate: Candidate;
  pass: AnalyzeMode;
  config: SyntheticConfig[string];
  status: ItemStatus;
  detail?: string;
  id?: number;
  probes: string[];
}
export interface NextStepLog {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
  error?: string;
  items?: CreationItem[];
}
export interface AlertingDetail {
  text: string;
  error?: string;
  href?: string;
}
export interface Session {
  url?: string;
  client: SmClient;
  probes: Probe[];
}
export interface SyntheticsInputs extends CommonInputs {
  selection: string[];
  browser: boolean;
  baseUrl: string;
  token: string;
  alerting: boolean;
  email: string;
  nextAction: "browser-discovery" | "export" | "configure-skills" | "finish";
}
export interface SyntheticsState extends WorkflowState<SyntheticsStep>, CommonState {
  candidates: Candidate[];
  selectedKeys: string[];
  analyzeMode: AnalyzeMode;
  analyzeProgress: number;
  createPhase: CreatePhase;
  baseUrl?: string;
  connectError?: string;
  tokenError?: string;
  session?: Session;
  // Current-pass progress is disposable. Records keep each config and remote ID
  // together across discovery passes, for summaries and Terraform export.
  items: CreationItem[];
  records: CreationItem[];
  alertingPhase: "confirm" | "inspecting" | "email-input" | "applying";
  alertingChoice?: { presets: AlertPresetName[]; outcome: NonNullable<StepProperties["alerting_outcome"]> };
  alertingDetail: AlertingDetail[];
  emailInput: string;
  emailError?: string;
  nextStepsLog: NextStepLog[];
  pendingNextStepLog?: NextStepLog;
  exporting: boolean;
  configuringSkills: boolean;
}
export interface SyntheticsOptions {
  stackUrl: string;
  targetUrl: string;
  baseUrl?: string;
  forceGcxInstall: boolean;
  cwd: string;
}
export type SyntheticsContext = StepContext<SyntheticsState, SyntheticsInputs>;
export const NEXT_ACTIONS = [
  { key: "browser-discovery", label: "Find additional synthetic checks" },
  { key: "export", label: "Export checks as Terraform" },
  { key: "configure-skills", label: "Configure agent skills" },
];
export function availableActions(state: SyntheticsState) {
  return NEXT_ACTIONS.filter((option) => !state.nextStepsLog.some((entry) => entry.key === option.key));
}
export function unhandledCandidates(state: SyntheticsState) {
  const handled = new Set(state.records.filter((item) => item.id !== undefined).map((item) => item.candidate.key));
  return state.candidates.filter((candidate) => !handled.has(candidate.key));
}
