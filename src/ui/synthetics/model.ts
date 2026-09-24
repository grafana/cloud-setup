import type { Candidate } from "../../products/syntheticMonitoring/discover.js";
import type { Probe, SmClient } from "../../products/syntheticMonitoring/api.js";
import type { AlertPresetName } from "../../products/syntheticMonitoring/checkAlerts.js";
import type { SyntheticConfig } from "../../products/syntheticMonitoring/types.js";
import type { CommonInputs, CommonState } from "../workflow/commonSteps.js";
import type { StepContext, WorkflowState } from "../workflow/controller.js";

export const SYNTHETICS_STEPS = {
  gcx: "Install Grafana Cloud CLI (gcx)",
  auth: "Authenticate with OAuth",
  skills: "Configure skills",
  analyze: "Analyze target",
  create: "Create synthetic checks",
  alerting: "Configure alerts",
  "next-steps": "Next steps",
};
export type SyntheticsStep = keyof typeof SYNTHETICS_STEPS;
export type AnalyzeMode = "fast" | "browser-discovery";
export type CreatePhase =
  "reviewing" | "auto-discovering" | "base-url-input" | "connecting" | "token-input" | "validating" | "creating";
export type ItemStatus = "pending" | "running" | "created" | "updated" | "skipped" | "failed";
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
  detail?: string;
  items?: CreationItem[];
}
export interface AlertingDetail {
  text: string;
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
  nextAction: "browser-discovery" | "export" | "finish";
}
export interface SyntheticsState extends WorkflowState<SyntheticsStep>, CommonState {
  // Where the synthetic-monitoring-checks skill landed — read back from
  // `skills list`/`skills add` rather than assumed, so the "Configure
  // skills" detail line shows a real, familiar path (e.g.
  // .agents/skills/synthetic-monitoring-checks) rather than naming tools.
  skillPath?: string;
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
  alertingChoice?: { presets: AlertPresetName[]; addresses?: string };
  alertingDetail: AlertingDetail[];
  emailInput: string;
  emailError?: string;
  nextStepsLog: NextStepLog[];
  pendingNextStepLog?: NextStepLog;
  exporting: boolean;
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
];
export function availableActions(state: SyntheticsState) {
  return NEXT_ACTIONS.filter((option) => !state.nextStepsLog.some((entry) => entry.key === option.key));
}
export function unhandledCandidates(state: SyntheticsState) {
  const handled = new Set(state.records.filter((item) => item.id !== undefined).map((item) => item.candidate.key));
  return state.candidates.filter((candidate) => !handled.has(candidate.key));
}
