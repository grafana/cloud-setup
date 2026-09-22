import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { debugLog } from "../debug.js";
import React, { useEffect, useRef, useState } from "react";
import { Box, render, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { tryFaroClient, type FaroApp } from "../products/frontendO11y/faroAuth.js";
import { tryAutoSmSession } from "../products/syntheticMonitoring/smAuth.js";
import { pickSyntheticTarget } from "../products/syntheticMonitoring/authoring.js";
// Circular at the module level (SetupApp.tsx imports runFrontendUI back
// from this file, for the opposite handoff) — safe here because both sides
// only ever call the other's export from inside a runtime callback, long
// after both modules have finished loading, never at import time.
import { runSetupUI } from "./SetupApp.js";
import {
  detectEnvironmentExpr,
  detectFrontendTarget,
  insertFaroSnippet,
  installFaroPackages,
  openFrontendO11ySetupPage,
  readPkgName,
  readPkgVersion,
  JAVASCRIPT_FARO_PACKAGES,
  REACT_FARO_PACKAGES,
  REPLAY_FARO_PACKAGE,
} from "../products/frontendO11y/instrument.js";
import type { FaroInstrumentation, FrontendTarget, ReplayMasking } from "../products/frontendO11y/instrument.js";
import { instrumentNextjs } from "../products/frontendO11y/nextjs.js";
import { instrumentReact } from "../products/frontendO11y/react.js";
import { SelectMenu, type SelectMenuItem } from "./SelectMenu.js";
import { accent, bad, EnterHint, Header, MIN_SPINNER_MS, muted, ok, requireInteractiveTerminal, startFakeProgress, url, useHardExit } from "./shared.js";
import { recordStep, type Outcome, type StepProperties, type StepStatus } from "../telemetry.js";
import { useGcxStep } from "./steps/useGcxStep.js";
import { useAuthStep } from "./steps/useAuthStep.js";

// The standalone `frontend` subcommand — just the pieces of the main
// wizard that Frontend Observability actually needs (gcx, sign-in),
// without any of the Synthetic Monitoring-specific steps (no target URL,
// no SM skill install — that's not relevant here). See SetupApp.tsx for
// the full wizard this is trimmed from.
// "next-steps": a repeatable menu shown after "instrument" finishes —
// same shape as SetupApp.tsx's own next-steps menu (see NEXT_STEP_OPTIONS
// below), so more actions can land here later the same way SM's next
// actions grow. Not shown as its own row in StepsList (see its own
// filter) — a completed pick appends its own row instead (see
// nextStepsLog).
type StepId = "gcx" | "auth" | "pick-app" | "instrument" | "next-steps";
const STEP_ORDER: StepId[] = ["gcx", "auth", "pick-app", "instrument", "next-steps"];
const STEP_LABELS: Record<StepId, string> = {
  gcx: "Install Grafana Cloud CLI (gcx)",
  auth: "Authenticate with OAuth",
  "pick-app": "Pick and configure app",
  instrument: "Instrument project with Faro SDK",
  "next-steps": "Next steps",
};

// Verified against grafana/website's own docs content (quickstart.md,
// instrument.md, troubleshoot.md all link here inline, not just a
// redirect stub) — the doc this prompt should point at before someone
// enables Session Replay in production.
const SESSION_REPLAY_DATA_PRIVACY_URL =
  "https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/session-replay/data-privacy/";

// Label + description columns, same convention as the app picker below
// and SetupApp.tsx's CheckboxList (SelectBody): focused row bold+accent,
// unfocused row default terminal color, description always muted.
interface MaskingOption {
  key: ReplayMasking;
  label: string;
  description: string;
}
const MASKING_OPTIONS: MaskingOption[] = [
  { key: "strict", label: "Strict", description: "mask all text, inputs and images" },
  { key: "balanced", label: "Balanced", description: "all inputs" },
  { key: "open", label: "Open", description: "sensitive inputs only" },
];

// Blank means "use the SDK's own default" (100%) rather than an explicit
// value — keeps the generated snippet free of a samplingRate field unless
// the user actually asked for something other than 100%.
function parseSamplingRateInput(raw: string): number {
  const trimmed = raw.trim().replace(/%$/, "");
  if (trimmed === "") return 1;
  const percent = Number(trimmed);
  if (!Number.isFinite(percent) || percent <= 0) return 1;
  return Math.min(100, percent) / 100;
}

// No real progress signal across "instrument" either (a fixed file edit,
// or an agent-assisted React/Next.js edit) — same fake-progress treatment
// as "Analyze target" in SetupApp.tsx (see shared.tsx's startFakeProgress),
// just a shorter target since this step is typically much quicker.
const INSTRUMENT_PROGRESS_TARGET_MS = 45_000;

// Display-only detail next to each app in the picker — the collector
// host is a recognizable "which one is this" cue without printing the
// whole (long, key-bearing) collector URL.
function faroAppHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Filters a Faro app's own corsOrigins down to real, checkable candidates
// before ever handing them to pickSyntheticTarget — a bare "*" or
// "https://*.foo.com" isn't a concrete URL, and a dev/loopback origin is
// never worth a monitoring check regardless of what the model would say.
function looksLikeRealOrigin(origin: string): boolean {
  if (origin.includes("*")) return false;
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname !== "localhost" &&
      !hostname.endsWith(".local") &&
      !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
    );
  } catch {
    return false;
  }
}

// No confirm question here — running the `frontend` subcommand at all
// already means "yes, instrument this project," so asking again would
// just be a redundant question. Straight into "checking": look up
// existing Faro apps via the same OAuth session used everywhere else in
// this wizard. If --app named one that exists, or exactly one app exists
// overall, it's used directly with no extra step. With more than one and
// no --app, "picking-app" shows a picker (with a "create a new app"
// option at the end). If none exist at all (or the named one doesn't),
// asks to create one — tried first through this same OAuth session
// (see FaroClient.create), falling back only on failure to opening the
// Frontend Observability "create a new app" page and asking for its
// collector URL. Once an app is resolved (whichever path got there),
// "sampling-input"/"replay-confirm"/"masking-picker" configure it — same
// step, not a separate one, since these are properties of the app you
// just picked or created, not of instrumenting the project's code.
// Sampling comes first — it's the general, every-session setting — then
// Session Replay narrows down from there, then its masking preset if
// enabled.
//
// "advancing" is a brief, non-interactive beat inserted between each pair
// of questions (see the transition() helper in runPickApp below) — same
// idea as "checking"'s own spinner, just shorter: a completely instant
// question-after-question flow reads as broken/skipped rather than as a
// wizard progressing, especially right after the create attempt (which
// can resolve in well under a second).
type PickAppSubPhase =
  | "checking"
  | "advancing"
  | "picking-app"
  | "create-app-confirm"
  | "collector-url-input"
  | "sampling-input"
  | "replay-confirm"
  | "masking-picker";
const PICK_APP_WAITING_SUBPHASES: PickAppSubPhase[] = [
  "picking-app",
  "create-app-confirm",
  "collector-url-input",
  "sampling-input",
  "replay-confirm",
  "masking-picker",
];
const PICK_APP_TRANSITION_MS = 500;

// No "Finish"/"exit" entry — there's nothing left to pick once every one
// of these is used, and the menu quietly finishes itself then (see
// availableNextStepOptions and the auto-finish effect below). Leaving
// early before that happens is 'q' (see the global quit keybind), the
// same key that works everywhere else in this wizard. Only one action
// today — more land here later, same as SetupApp.tsx's own next-steps
// menu.
const SM_KEY = "synthetic-monitoring";
const SM_LABEL = "Set up Synthetic Monitoring for your app";
const NEXT_STEP_OPTIONS: SelectMenuItem[] = [{ key: SM_KEY, label: SM_LABEL }];

function availableNextStepOptions(log: { key: string }[]): SelectMenuItem[] {
  const used = new Set(log.map((e) => e.key));
  return NEXT_STEP_OPTIONS.filter((o) => !used.has(o.key));
}

// Picking "Set up Synthetic Monitoring for your app" IS its own
// confirmation (no separate y/n first) — same as SetupApp.tsx's own
// "Export checks as Terraform" next-step, which also runs inline without
// asking again. "suggesting": pickSyntheticTarget deciding which of the
// Faro app's own CORS origins (if any look real — see
// looksLikeRealOrigin) is worth a check. "target-input": that suggestion
// (if any) prefills the URL prompt rather than skipping it, so a bad
// guess is still caught by the same confirm-by-submitting the user
// already does. "checking": tryAutoSmSession + listChecks, to see
// whether that URL is already monitored before ever handing off.
// "handing-off": a brief visible pause between deciding to hand off and
// actually doing it (see runSyntheticMonitoringPick) — same
// MIN_SPINNER_MS beat every other loading moment in this wizard gets, so
// the handoff reads as loading the next thing rather than an instant
// jump cut.
type NextStepsSubPhase = "menu" | "suggesting" | "target-input" | "checking" | "handing-off";
const NEXT_STEPS_WAITING_SUBPHASES: NextStepsSubPhase[] = ["target-input"];

// One entry per completed next-step pick, rendered as its own checkmark
// row in StepsList (below the fixed steps) — same shape as
// SetupApp.tsx's own NextStepLogEntry.
interface NextStepLogEntry {
  key: string;
  label: string;
  detail?: string;
}

interface Props {
  initialStackUrl: string;
  forceGcxInstall: boolean;
  initialAppName?: string;
  // "chained": this run was launched by the `synthetics` wizard's own
  // cross-product recommendation rather than started directly — see the
  // "gcx" step's origin property in telemetry.ts.
  origin?: "direct" | "chained";
}

export function FrontendApp({ initialStackUrl, forceGcxInstall, initialAppName, origin = "direct" }: Props) {
  const exit = useHardExit("frontend", initialStackUrl);

  // A chained run skips the "start?" gate entirely — picking the
  // recommendation (or answering yes to it) in the other wizard already
  // was that confirmation. It also skips "gcx" and "auth" outright, not
  // just their own confirm prompts (see useAuthStep's skipConfirm) — the
  // wizard that chained into this one already verified both, in this same
  // process, so re-running either here would just be redundant work with
  // nothing left to ask or check.
  const [started, setStarted] = useState(origin === "chained");
  const [currentStep, setCurrentStep] = useState<StepId>(origin === "chained" ? "pick-app" : "gcx");
  const [completed, setCompleted] = useState<Set<StepId>>(new Set());
  const [done, setDone] = useState(false);
  const setupOutcome = useRef<Outcome>("incomplete");
  const [failureSummary, setFailureSummary] = useState<string>();

  const [pickAppSubPhase, setPickAppSubPhase] = useState<PickAppSubPhase>("checking");
  const [frontendFile, setFrontendFile] = useState<string>();
  const [frontendError, setFrontendError] = useState<string>();
  const [collectorUrlInput, setCollectorUrlInput] = useState("");
  const [faroApps, setFaroApps] = useState<FaroApp[]>([]);
  const [appPickerCursor, setAppPickerCursor] = useState(0);
  // The Frontend Observability app's own page — shown on the done screen
  // so "where does my data land" has a direct answer. Only ever an exact
  // per-app URL (.../apps/<id>) when an existing app was found via the
  // API; the manual-paste fallback (a brand-new app, no id available)
  // falls back to the app list page instead.
  const [appUrl, setAppUrl] = useState<string>();
  // Shown as its own line as soon as the app is resolved (picked or
  // created), separate from the sampling/replay/masking summary below it.
  const [appName, setAppName] = useState<string>();
  const [instrumentProgress, setInstrumentProgress] = useState(0);
  // The picked (or newly created) Faro app's own CORS allow-list — only
  // ever populated when an existing app was found via the API (see
  // runPickApp); the manual-paste fallback creates no app object at all,
  // so this stays empty and the synthetic-monitoring pick just falls back
  // to asking for the URL by hand.
  const faroAppCorsOriginsRef = useRef<string[]>([]);

  // next-steps menu
  const [nextStepsSubPhase, setNextStepsSubPhase] = useState<NextStepsSubPhase>("menu");
  const [nextStepsLog, setNextStepsLog] = useState<NextStepLogEntry[]>([]);
  const [smUrlInput, setSmUrlInput] = useState("");
  const [smSuggestionReason, setSmSuggestionReason] = useState<string>();
  // Set once a suggestion is shown (see runSyntheticMonitoringPick) — read
  // at submit time to tell whether the URL that ended up used was
  // accepted as-is or edited/typed by hand (see recommend_sm_url_source
  // in telemetry.ts).
  const smSuggestedUrlRef = useRef<string | undefined>(undefined);
  // Set once accepted (see runSyntheticMonitoringPick) — read by the
  // "done" effect below to decide whether to hand off into the
  // `synthetics` wizard once this one finishes.
  const pendingSmUrl = useRef<string | undefined>(undefined);
  // Local, not derived by re-scanning nextStepsLog from finishNextSteps —
  // a log update and the finish can happen in the same tick, and state
  // set with a setter still holds its previous value inside that same
  // closure. Same shape as SetupApp.tsx's own frontendO11yActionRef.
  const recommendSmActionRef = useRef<"not_taken" | "already_monitored" | "unavailable" | "accepted">("not_taken");
  const recommendSmUrlSourceRef = useRef<"ai_suggested" | "manual" | undefined>(undefined);

  const [sessionReplayEnabled, setSessionReplayEnabled] = useState(false);
  const [replayMasking, setReplayMasking] = useState<ReplayMasking>("balanced");
  const [maskingCursor, setMaskingCursor] = useState(0);
  const [samplingInput, setSamplingInput] = useState("100");
  const [samplingRate, setSamplingRate] = useState(1);

  // gcx/auth steps — shared with SetupApp via src/ui/steps. Never run at
  // all when chained (currentStep starts past both — see above), so
  // isActive here is moot in that case, not just false.
  const gcx = useGcxStep(forceGcxInstall, currentStep === "gcx");
  const auth = useAuthStep("Sign in to Grafana Cloud using your browser?", currentStep === "auth", origin === "chained");

  // undefined means "none of these — create a new app instead" (the
  // picker's trailing option), not "still waiting".
  const appPickerResolver = useRef<((app: FaroApp | undefined) => void) | undefined>(undefined);
  const createAppConfirmResolver = useRef<((allow: boolean) => void) | undefined>(undefined);
  const collectorUrlResolver = useRef<((url: string) => void) | undefined>(undefined);
  const smUrlResolver = useRef<((url: string) => void) | undefined>(undefined);
  const replayConfirmResolver = useRef<((enabled: boolean) => void) | undefined>(undefined);
  const maskingResolver = useRef<((masking: ReplayMasking) => void) | undefined>(undefined);
  const samplingResolver = useRef<((rate: number) => void) | undefined>(undefined);

  // Cross-step state: each step's run function is a fresh closure (the
  // effect re-fires per currentStep change), so anything a later step
  // needs from an earlier one lives in a ref rather than a local
  // variable. frontendSkippedRef short-circuits "instrument" straight
  // through (still earning its checkmark, doing nothing) when "pick-app"
  // failed outright.
  const targetRef = useRef<FrontendTarget | undefined>(undefined);
  const instrumentationBaseRef = useRef<{ name: string; collectorUrl: string } | undefined>(undefined);
  const frontendSkippedRef = useRef(false);

  const isWaiting =
    (currentStep === "gcx" && gcx.isWaiting) ||
    (currentStep === "auth" && auth.isWaiting) ||
    (currentStep === "pick-app" && PICK_APP_WAITING_SUBPHASES.includes(pickAppSubPhase)) ||
    (currentStep === "next-steps" && NEXT_STEPS_WAITING_SUBPHASES.includes(nextStepsSubPhase));

  function advance(properties: StepProperties) {
    recordStep("frontend", initialStackUrl, currentStep, properties);
    setCompleted((prev) => new Set(prev).add(currentStep));
    const idx = STEP_ORDER.indexOf(currentStep);
    const next = STEP_ORDER[idx + 1];
    if (next) setCurrentStep(next);
  }

  // "next-steps" is always the last entry in STEP_ORDER, so advance()
  // above never moves currentStep away from it — this just records the
  // step (folding in whatever the pick, if any, worked out — see
  // recommendSmActionRef) and finishes the whole wizard, same shape as
  // SetupApp.tsx's own finishNextSteps.
  function finishNextSteps() {
    advance({
      status: "ok",
      recommend_sm_action: recommendSmActionRef.current,
      ...(recommendSmUrlSourceRef.current ? { recommend_sm_url_source: recommendSmUrlSourceRef.current } : {}),
    });
    setDone(true);
  }

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") setStarted(true);
      else if (input.toLowerCase() === "n") exit("Cancelled.");
    },
    { isActive: !started }
  );

  // Quit is disabled while free text is being typed (a URL, or the
  // sampling rate, could legitimately contain the letter q) — Ctrl+C
  // still works there.
  const quittingBlocked =
    (currentStep === "pick-app" && (pickAppSubPhase === "collector-url-input" || pickAppSubPhase === "sampling-input")) ||
    (currentStep === "next-steps" && nextStepsSubPhase === "target-input");
  useInput(
    (input) => {
      if (input.toLowerCase() !== "q") return;
      // At the next-steps menu, 'q' IS "I'm done" — there's no "Finish"
      // entry to pick instead (see NEXT_STEP_OPTIONS) — so this finishes
      // the same graceful way an exhausted menu does on its own (see the
      // auto-finish effect below), rather than exiting through the
      // generic "Cancelled." path everywhere else 'q' means bailing out
      // early. Same shape as SetupApp.tsx's own next-steps 'q' handling.
      if (currentStep === "next-steps" && nextStepsSubPhase === "menu") finishNextSteps();
      else exit("Cancelled.");
    },
    { isActive: !quittingBlocked }
  );

  // The last row (index === faroApps.length) is "create a new app
  // instead" — resolving with undefined there falls through to the
  // manual collector-URL flow below, same as if no apps existed at all.
  useInput(
    (input, key) => {
      if (currentStep !== "pick-app" || pickAppSubPhase !== "picking-app") return;
      const total = faroApps.length + 1;
      if (key.upArrow) setAppPickerCursor((c) => (c - 1 + total) % total);
      else if (key.downArrow) setAppPickerCursor((c) => (c + 1) % total);
      else if (key.return) {
        appPickerResolver.current?.(appPickerCursor < faroApps.length ? faroApps[appPickerCursor] : undefined);
      }
    },
    { isActive: currentStep === "pick-app" && pickAppSubPhase === "picking-app" }
  );

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") createAppConfirmResolver.current?.(true);
      else if (input.toLowerCase() === "n") createAppConfirmResolver.current?.(false);
    },
    { isActive: currentStep === "pick-app" && pickAppSubPhase === "create-app-confirm" }
  );

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") replayConfirmResolver.current?.(true);
      else if (input.toLowerCase() === "n") replayConfirmResolver.current?.(false);
    },
    { isActive: currentStep === "pick-app" && pickAppSubPhase === "replay-confirm" }
  );

  useInput(
    (input, key) => {
      if (key.upArrow) setMaskingCursor((c) => (c - 1 + MASKING_OPTIONS.length) % MASKING_OPTIONS.length);
      else if (key.downArrow) setMaskingCursor((c) => (c + 1) % MASKING_OPTIONS.length);
      else if (key.return) maskingResolver.current?.(MASKING_OPTIONS[maskingCursor]!.key);
    },
    { isActive: currentStep === "pick-app" && pickAppSubPhase === "masking-picker" }
  );

  // Runs inline from the next-steps menu, independent of the step-driving
  // effect below (currentStep stays "next-steps" throughout — same shape
  // as SetupApp.tsx's own runExportNow) — picking it IS the confirmation,
  // so this starts immediately rather than asking a further y/n.
  async function runSyntheticMonitoringPick() {
    const realOrigins = faroAppCorsOriginsRef.current.filter(looksLikeRealOrigin);
    let suggestion: { url: string; reason: string } | undefined;
    if (realOrigins.length > 0) {
      setNextStepsSubPhase("suggesting");
      suggestion = await pickSyntheticTarget(realOrigins, initialStackUrl);
    }
    smSuggestedUrlRef.current = suggestion?.url;
    setSmSuggestionReason(suggestion?.reason);
    setSmUrlInput(suggestion?.url ?? "");

    setNextStepsSubPhase("target-input");
    const rawUrl = await new Promise<string>((resolve) => {
      smUrlResolver.current = resolve;
    });
    const targetUrl = /^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const urlSource: "ai_suggested" | "manual" =
      smSuggestedUrlRef.current && rawUrl.trim() === smSuggestedUrlRef.current.trim() ? "ai_suggested" : "manual";

    setNextStepsSubPhase("checking");
    // No fallback to the manual base-url/token flow here — that stays
    // exclusive to `synthetics`'s own "create" step. If this fails there's
    // no session to check with, so this just logs it and returns to the
    // menu rather than asking for an SM access token from inside this
    // wizard.
    const auto = await tryAutoSmSession(initialStackUrl);
    if (!auto) {
      setNextStepsLog((prev) => [...prev, { key: SM_KEY, label: SM_LABEL, detail: "Couldn't connect to Synthetic Monitoring automatically." }]);
      recommendSmActionRef.current = "unavailable";
      recommendSmUrlSourceRef.current = urlSource;
      setNextStepsSubPhase("menu");
      return;
    }

    let alreadyMonitored = false;
    try {
      const checks = await auto.client.listChecks();
      const normalize = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
      alreadyMonitored = checks.some((c) => normalize(c.target) === normalize(targetUrl));
    } catch {
      // Can't tell — treated the same as "not already monitored" rather
      // than blocking the handoff on a failed listing.
    }

    if (alreadyMonitored) {
      setNextStepsLog((prev) => [...prev, { key: SM_KEY, label: SM_LABEL, detail: "Already monitored." }]);
      recommendSmActionRef.current = "already_monitored";
      recommendSmUrlSourceRef.current = urlSource;
      setNextStepsSubPhase("menu");
      return;
    }

    setNextStepsSubPhase("handing-off");
    await sleep(MIN_SPINNER_MS);
    setNextStepsLog((prev) => [...prev, { key: SM_KEY, label: SM_LABEL, detail: "Continuing into Synthetic Monitoring setup…" }]);
    recommendSmActionRef.current = "accepted";
    recommendSmUrlSourceRef.current = urlSource;
    pendingSmUrl.current = targetUrl;
    finishNextSteps();
  }

  function handleNextStepChoice(key: string) {
    if (key === SM_KEY) runSyntheticMonitoringPick();
  }

  useEffect(() => {
    if (!started) return;
    let cancelled = false;

    async function runGcx() {
      const result = await gcx.run(() => cancelled);
      if (cancelled) return;
      advance({
        status: result.installDeclined ? "declined" : "ok",
        already_installed: result.alreadyInstalled,
        install_declined: result.installDeclined,
        origin,
      });
    }

    async function runAuth() {
      const authOutcome = await auth.run(initialStackUrl, () => cancelled);
      if (cancelled) return;
      advance({ status: authOutcome === "yes" ? "ok" : authOutcome, auth_outcome: authOutcome });
    }

    async function runPickApp() {
      setFrontendError(undefined);
      setFrontendFile(undefined);

      const target = detectFrontendTarget(process.cwd());
      if (target.kind === "unsupported") {
        throw new Error(
          "This project doesn't match a shape this tool can instrument automatically (Next.js, or a JS/TS project — React or otherwise — with a findable src/main or src/index entry file)."
        );
      }
      targetRef.current = target;

      let resolution: "named" | "auto_single" | "picker" | "created" | "manual" = "manual";
      // Local, not read back off frontendError — that is React state, so it
      // still holds its previous value inside this closure.
      let status: StepStatus = "ok";

      // A brief spinner beat before each subsequent question — see the
      // doc comment on PickAppSubPhase. Returns false (caller should
      // bail) if the step got cancelled mid-beat.
      async function transition(): Promise<boolean> {
        setPickAppSubPhase("advancing");
        await sleep(PICK_APP_TRANSITION_MS);
        return !cancelled;
      }

      try {
        setPickAppSubPhase("checking");
        const [faro] = await Promise.all([tryFaroClient(initialStackUrl), sleep(MIN_SPINNER_MS)]);
        if (cancelled) return;

        let chosen: FaroApp | undefined;
        if (initialAppName) {
          // Named explicitly — use it directly if it exists; if not,
          // fall through to manual creation below with that same name
          // rather than silently picking a different app.
          chosen = await faro?.findExisting(initialAppName);
          if (chosen) resolution = "named";
        } else {
          const apps = (await faro?.list()) ?? [];
          if (apps.length === 1) {
            chosen = apps[0];
            resolution = "auto_single";
          } else if (apps.length > 1) {
            setFaroApps(apps);
            setAppPickerCursor(0);
            setPickAppSubPhase("picking-app");
            chosen = await new Promise<FaroApp | undefined>((resolve) => {
              appPickerResolver.current = resolve;
            });
            if (cancelled) return;
            if (chosen) resolution = "picker";
          }
        }

        const base = initialStackUrl.replace(/\/$/, "");
        if (chosen) {
          instrumentationBaseRef.current = { name: chosen.name, collectorUrl: `${chosen.collectEndpointURL}/${chosen.appKey}` };
          faroAppCorsOriginsRef.current = chosen.corsOrigins;
          setAppUrl(chosen.id ? `${base}/a/grafana-kowalski-app/apps/${chosen.id}` : `${base}/a/grafana-kowalski-app`);
          setAppName(chosen.name);
        } else {
          if (!(await transition())) return;
          setPickAppSubPhase("create-app-confirm");
          const proceed = await new Promise<boolean>((resolve) => {
            createAppConfirmResolver.current = resolve;
          });
          if (cancelled) return;

          if (!proceed) {
            frontendSkippedRef.current = true;
            setFrontendError("declined");
            status = "declined";
          } else {
            const fallbackName = initialAppName ?? readPkgName(process.cwd()) ?? path.basename(process.cwd());

            // Try creating it through the same OAuth session first — no
            // second, browser-based login, no manual paste. Only fall
            // back to the manual flow if that fails (older stack, no
            // faro client, name conflict, ...): this is a nice-to-have
            // shortcut, not something worth hard-failing the step over.
            // The spinner (rather than an instant jump to either the
            // next question or the browser) doubles as the minimum
            // pacing beat between questions — a real request this can
            // resolve in well under a second, otherwise.
            setPickAppSubPhase("advancing");
            if (!faro) debugLog("faro create", "no Faro client — auth/session lookup failed earlier");
            const [created] = await Promise.all([
              faro?.create(fallbackName).catch((err) => {
                debugLog("faro create", err instanceof Error ? err.message : String(err));
                return undefined;
              }),
              sleep(PICK_APP_TRANSITION_MS),
            ]);
            if (cancelled) return;

            if (created) {
              resolution = "created";
              instrumentationBaseRef.current = { name: created.name, collectorUrl: `${created.collectEndpointURL}/${created.appKey}` };
              setAppUrl(created.id ? `${base}/a/grafana-kowalski-app/apps/${created.id}` : `${base}/a/grafana-kowalski-app`);
              setAppName(created.name);
            } else {
              openFrontendO11ySetupPage(initialStackUrl);
              setPickAppSubPhase("collector-url-input");
              const pastedUrl = await new Promise<string>((resolve) => {
                collectorUrlResolver.current = resolve;
              });
              if (cancelled) return;
              instrumentationBaseRef.current = { name: fallbackName, collectorUrl: pastedUrl };
              setAppUrl(`${base}/a/grafana-kowalski-app`);
              setAppName(fallbackName);
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        frontendSkippedRef.current = true;
        setFrontendError(err instanceof Error ? err.message : String(err));
        status = "failed";
      }
      if (cancelled) return;

      // Continues straight into configuring the app just picked/created —
      // same step, not a separate one (see the doc comment on
      // PickAppSubPhase). Skipped entirely if app resolution itself
      // failed or was declined, same as "instrument" already does.
      if (status !== "ok") {
        advance({ status, app_resolution: resolution });
        return;
      }

      // Sampling first — it's the general, every-session setting;
      // Session Replay (and its masking, if enabled) narrows down from
      // there, so it comes after.
      if (!(await transition())) return;
      setPickAppSubPhase("sampling-input");
      const rate = await new Promise<number>((resolve) => {
        samplingResolver.current = resolve;
      });
      if (cancelled) return;
      setSamplingRate(rate);

      if (!(await transition())) return;
      setPickAppSubPhase("replay-confirm");
      const replayEnabled = await new Promise<boolean>((resolve) => {
        replayConfirmResolver.current = resolve;
      });
      if (cancelled) return;
      setSessionReplayEnabled(replayEnabled);

      let masking: ReplayMasking = "balanced";
      if (replayEnabled) {
        if (!(await transition())) return;
        setPickAppSubPhase("masking-picker");
        masking = await new Promise<ReplayMasking>((resolve) => {
          maskingResolver.current = resolve;
        });
        if (cancelled) return;
        setReplayMasking(masking);
      }

      advance({
        status: "ok",
        app_resolution: resolution,
        session_replay: replayEnabled,
        ...(replayEnabled ? { replay_masking: masking } : {}),
        sampling_rate: Math.round(rate * 100),
      });
    }

    async function runInstrument() {
      if (frontendSkippedRef.current) {
        advance({ status: "skipped" });
        setDone(true);
        return;
      }

      setInstrumentProgress(0);
      const progress = startFakeProgress(setInstrumentProgress, () => cancelled, INSTRUMENT_PROGRESS_TARGET_MS);

      const target = targetRef.current!;
      // version/environment are detected silently — no separate step or
      // question for them (see readPkgVersion/detectEnvironmentExpr).
      // Session persistence stays off, matching the SDK's own default —
      // not worth a dedicated step either.
      const instrumentation: FaroInstrumentation = {
        ...instrumentationBaseRef.current!,
        version: readPkgVersion(process.cwd()),
        environmentExpr: detectEnvironmentExpr(target),
        sessionPersistent: false,
        sessionReplay: sessionReplayEnabled,
        replayMasking,
        samplingRate,
      };
      const replayPackages = sessionReplayEnabled ? [REPLAY_FARO_PACKAGE] : [];
      let packageInstall: "ok" | "failed" = "ok";
      let instrumentationComplete = false;
      let routerWired: boolean | undefined;
      let layoutWired: boolean | undefined;
      // Only true for the outer catch below — a genuine, unhandled
      // exception (a file write throwing, the agent itself erroring), as
      // opposed to a graceful partial result (a missing layoutFile, a
      // failed-but-caught package install) that still finished this step
      // without crashing it. Only that real crash skips "next-steps" —
      // same as SetupApp.tsx's own "create", which throws (skipping its
      // next-steps menu the same way) only on a genuine per-check failure,
      // never for a merely partial/incomplete result.
      let crashed = false;

      try {
        if (target.kind === "javascript") {
          insertFaroSnippet(process.cwd(), target, instrumentation);
          await installFaroPackages(process.cwd(), [...JAVASCRIPT_FARO_PACKAGES, ...replayPackages]);
          if (cancelled) {
            progress.stop();
            return;
          }
          setFrontendFile(target.file);
          instrumentationComplete = true;
        } else if (target.kind === "react") {
          // Run separately from installFaroPackages, not bundled into one
          // Promise.all — a failed install would otherwise reject the
          // whole thing and discard a perfectly good instrumentation
          // result. Same pattern for the nextjs branch below.
          const result = await instrumentReact(process.cwd(), initialStackUrl, target.file, instrumentation);
          if (cancelled) {
            progress.stop();
            return;
          }

          let installError: string | undefined;
          try {
            await installFaroPackages(process.cwd(), [...REACT_FARO_PACKAGES, ...replayPackages]);
          } catch (err) {
            installError = err instanceof Error ? err.message : String(err);
            packageInstall = "failed";
          }
          if (cancelled) {
            progress.stop();
            return;
          }

          instrumentationComplete = result.complete;
          routerWired = Boolean(result.routerFile);
          const base = result.routerFile ? `${result.entryFile}, router wrapped in ${result.routerFile}` : result.entryFile;
          setFrontendFile(installError ? `${base} (package install failed: ${installError})` : base);
        } else {
          const result = await instrumentNextjs(process.cwd(), initialStackUrl, instrumentation);
          if (cancelled) {
            progress.stop();
            return;
          }

          let installError: string | undefined;
          try {
            await installFaroPackages(process.cwd(), [...JAVASCRIPT_FARO_PACKAGES, ...replayPackages]);
          } catch (err) {
            installError = err instanceof Error ? err.message : String(err);
            packageInstall = "failed";
          }
          if (cancelled) {
            progress.stop();
            return;
          }

          instrumentationComplete = result.complete;
          layoutWired = Boolean(result.layoutFile);
          if (result.layoutFile) {
            setFrontendFile(
              installError
                ? `${result.componentFile}, wired into ${result.layoutFile} (package install failed: ${installError})`
                : `${result.componentFile}, wired into ${result.layoutFile}`
            );
          } else if (result.componentFile) {
            setFrontendError(`created ${result.componentFile}, but couldn't wire it into the layout automatically — add <FrontendObservability /> yourself`);
          } else {
            setFrontendError(result.detail ?? "the agent couldn't complete the Next.js instrumentation");
          }
        }
      } catch (err) {
        if (cancelled) {
          progress.stop();
          return;
        }
        crashed = true;
        packageInstall = "failed";
        setFrontendError(err instanceof Error ? err.message : String(err));
      }
      if (cancelled) return;
      await progress.finish();
      if (cancelled) return;
      setupOutcome.current = instrumentationComplete && packageInstall === "ok" ? "ok" : "incomplete";
      const instrumentProps: StepProperties = {
        status: setupOutcome.current === "ok" ? "ok" : "failed",
        instrumentation: instrumentationComplete ? "complete" : "partial",
        target_kind: target.kind,
        package_install: packageInstall,
        ...(routerWired !== undefined ? { router_wired: routerWired } : {}),
        ...(layoutWired !== undefined ? { layout_wired: layoutWired } : {}),
      };
      if (crashed) {
        // Diverges from advance() on purpose — a genuine crash has
        // nothing to recommend next, so this records the step and
        // finishes directly rather than moving into "next-steps".
        recordStep("frontend", initialStackUrl, "instrument", instrumentProps);
        setCompleted((prev) => new Set(prev).add("instrument"));
        setDone(true);
      } else {
        // A partial-but-not-crashed result still moves on into
        // "next-steps" — same shape as SetupApp.tsx's "create", which
        // reaches its own next-steps menu regardless of how many checks
        // actually got created.
        advance(instrumentProps);
      }
    }

    async function run() {
      try {
        if (currentStep === "gcx") await runGcx();
        else if (currentStep === "auth") await runAuth();
        else if (currentStep === "pick-app") await runPickApp();
        else if (currentStep === "instrument") await runInstrument();
      } catch (err) {
        if (cancelled) return;
        setFailureSummary(err instanceof Error ? err.message : String(err));
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, started]);

  useEffect(() => {
    if (done) {
      exit(
        undefined,
        setupOutcome.current,
        pendingSmUrl.current
          ? () => {
              // A clean handoff, not a jump cut mid-scrollback — this run's
              // own summary has already been recordRun()'d and read by the
              // time this fires, so there's nothing left here worth keeping
              // on screen once the other wizard takes over.
              console.clear();
              return runSetupUI(undefined, pendingSmUrl.current!, initialStackUrl, false, "chained");
            }
          : undefined
      );
    }
  }, [done, exit, initialStackUrl]);
  useEffect(() => {
    if (failureSummary) exit(new Error(failureSummary));
  }, [failureSummary, exit]);
  // Reacts to nextStepsLog itself rather than being called explicitly by
  // runSyntheticMonitoringPick — so a pick that finishes without an
  // explicit finishNextSteps() call (the "unavailable"/"already_monitored"
  // outcomes, which just return to "menu") still ends the wizard once
  // there's nothing left to offer. Same shape as SetupApp.tsx's own
  // auto-finish effect.
  useEffect(() => {
    if (currentStep === "next-steps" && nextStepsSubPhase === "menu" && availableNextStepOptions(nextStepsLog).length === 0) {
      finishNextSteps();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextStepsLog, currentStep, nextStepsSubPhase]);

  // Shared by the fixed "current" row and the dynamic next-steps row below
  // — same shape as SetupApp.tsx's own liveIcon.
  function liveIcon() {
    return isWaiting ? (
      <Text color={accent}>●</Text>
    ) : (
      <Text color={accent}>
        <Spinner type="dots" />
      </Text>
    );
  }

  function StepsList() {
    return (
      <Box flexDirection="column">
        {STEP_ORDER.filter(
          (step) => step !== "next-steps" && !(origin === "chained" && (step === "gcx" || step === "auth"))
        ).map((step) => {
          // instrumentProgress is guaranteed 100 by the time this step is
          // marked completed (advance() only runs after progress.finish()
          // resolves) — keep showing it rather than dropping the number
          // the moment the checkmark appears.
          const suffix = step === "instrument" && !frontendSkippedRef.current ? `${instrumentProgress}%` : undefined;
          let row;
          if (completed.has(step)) {
            row = (
              <Text>
                {" "}
                <Text color={ok}>✓</Text> {STEP_LABELS[step]}
                {suffix && <Text color={muted}> — {suffix}</Text>}
              </Text>
            );
          } else if (step === currentStep) {
            row = (
              <Text>
                {" "}
                {liveIcon()} <Text bold>{STEP_LABELS[step]}</Text>
                {suffix && <Text color={muted}> — {suffix}</Text>}
              </Text>
            );
          } else {
            row = (
              <Text color={muted}>
                {" "}· {STEP_LABELS[step]}
              </Text>
            );
          }

          return (
            <Box key={step} flexDirection="column">
              {row}
              {step === "auth" && completed.has(step) && auth.error && (
                <Text color={muted}> Skipping auto-lookup ({auth.error})</Text>
              )}
              {/* Standalone line, separate from the config summary below —
                  shown as soon as the app is resolved (picked or created),
                  stays up through the rest of this step and beyond. */}
              {step === "pick-app" && appName && !frontendSkippedRef.current && <Text color={muted}>{"     "}app: {appName}</Text>}
              {/* Live, not just on completion — grows one line at a time
                  as each question gets answered (sampling decided, then
                  replay, then masking), same idea as "instrument"'s live
                  percentage below. One key: value option per line, same
                  as the "app:" line above. */}
              {step === "pick-app" &&
                currentStep === "pick-app" &&
                !frontendSkippedRef.current &&
                (pickAppSubPhase === "replay-confirm" || pickAppSubPhase === "masking-picker") && (
                  <>
                    <Text color={muted}>{"     "}sampling: {Math.round(samplingRate * 100)}%</Text>
                    {pickAppSubPhase === "masking-picker" && <Text color={muted}>{"     "}replay: enabled</Text>}
                  </>
                )}
              {step === "pick-app" && completed.has(step) && !frontendSkippedRef.current && (
                <>
                  <Text color={muted}>{"     "}sampling: {Math.round(samplingRate * 100)}%</Text>
                  <Text color={muted}>{"     "}replay: {sessionReplayEnabled ? "enabled" : "disabled"}</Text>
                  {sessionReplayEnabled && <Text color={muted}>{"     "}replay_masking: {replayMasking}</Text>}
                </>
              )}
              {step === "instrument" && completed.has(step) && frontendFile && (
                <Text color={muted}>{"     "}Instrumented {frontendFile}</Text>
              )}
              {step === "instrument" && completed.has(step) && frontendError && (
                <Text color={muted}>{"     "}Skipped Frontend Observability setup ({frontendError})</Text>
              )}
            </Box>
          );
        })}
        {nextStepsLog.map((entry, i) => (
          <Box key={`next-steps-log-${i}`} flexDirection="column">
            <Text>
              {" "}
              <Text color={ok}>✓</Text> {entry.label}
            </Text>
            {entry.detail && <Text color={muted}>{"     "}{entry.detail}</Text>}
          </Box>
        ))}
        {currentStep === "next-steps" && nextStepsSubPhase !== "menu" && (
          <Text>
            {" "}
            {liveIcon()} <Text bold>{SM_LABEL}</Text>
          </Text>
        )}
      </Box>
    );
  }

  function PickAppBody() {
    // No body here — the step list's own spinner next to "Pick Frontend
    // Observability app" already shows something's happening; a second
    // "Looking up…" line just flashes in and out with nothing to add.
    if (pickAppSubPhase === "checking") return null;
    if (pickAppSubPhase === "picking-app")
      return (
        <Box flexDirection="column">
          <Text>Which Frontend Observability app do you want to use?</Text>
          {faroApps.map((app, i) => (
            <Text key={app.id || app.name}>
              {i === appPickerCursor ? (
                <Text color={accent} bold>
                  {"› "}
                  {app.name}
                </Text>
              ) : (
                <Text>{`  ${app.name}`}</Text>
              )}
              {app.collectEndpointURL && <Text color={muted}> — {faroAppHost(app.collectEndpointURL)}</Text>}
            </Text>
          ))}
          <Text>
            {appPickerCursor === faroApps.length ? (
              <Text color={accent} bold>
                › Create a new app
              </Text>
            ) : (
              <Text color={muted}>{"  Create a new app"}</Text>
            )}
          </Text>
          <Box marginTop={1}>
            <Text color={muted}>
              press{" "}
              <Text color={accent} bold>
                ⏎ enter
              </Text>{" "}
              to choose · ↑↓ move
            </Text>
          </Box>
        </Box>
      );
    if (pickAppSubPhase === "create-app-confirm")
      return (
        <Box flexDirection="column">
          <Text>No existing app found. Create one? This'll open your browser. Come back here with its collector URL once it's created.</Text>
          <EnterHint suffix="or n to skip" />
        </Box>
      );
    if (pickAppSubPhase === "collector-url-input")
      return (
        <Box flexDirection="column">
          <Box>
            <Text>Faro collector URL: </Text>
            <TextInput
              value={collectorUrlInput}
              onChange={setCollectorUrlInput}
              onSubmit={(v) => collectorUrlResolver.current?.(v.trim())}
            />
          </Box>
        </Box>
      );
    if (pickAppSubPhase === "replay-confirm")
      return (
        <Box flexDirection="column">
          <Text>Enable Session Replay? Records user sessions; consent may be required.</Text>
          <Text color={muted}>
            Privacy details: <Text color={url}>{SESSION_REPLAY_DATA_PRIVACY_URL}</Text>
          </Text>
          <Text color={muted}>
            press{" "}
            <Text color={accent} bold>
              ⏎ enter
            </Text>{" "}
            to enable, or{" "}
            <Text color={accent} bold>
              n
            </Text>{" "}
            to skip
          </Text>
        </Box>
      );
    if (pickAppSubPhase === "masking-picker")
      return (
        <Box flexDirection="column">
          <Text>Privacy masking for Session Replay:</Text>
          {MASKING_OPTIONS.map((option, i) => (
            <Text key={option.key}>
              {i === maskingCursor ? (
                <Text color={accent} bold>
                  {"› "}
                  {option.label}
                </Text>
              ) : (
                <Text>{`  ${option.label}`}</Text>
              )}
              <Text color={muted}> — {option.description}</Text>
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color={muted}>
              press{" "}
              <Text color={accent} bold>
                ⏎ enter
              </Text>{" "}
              to choose · ↑↓ move
            </Text>
          </Box>
        </Box>
      );
    if (pickAppSubPhase === "sampling-input")
      return (
        <Box flexDirection="column">
          <Box>
            <Text>Session sampling rate (%): </Text>
            <TextInput value={samplingInput} onChange={setSamplingInput} onSubmit={(v) => samplingResolver.current?.(parseSamplingRateInput(v))} />
          </Box>
          <EnterHint />
        </Box>
      );
    return null;
  }

  function NextStepsBody() {
    if (nextStepsSubPhase === "target-input")
      return (
        <Box flexDirection="column">
          {smSuggestionReason && (
            <Text color={muted}>Suggested from your Frontend Observability app — {smSuggestionReason}. Edit or press enter to accept.</Text>
          )}
          <Box>
            <Text>App URL: </Text>
            <TextInput value={smUrlInput} onChange={setSmUrlInput} onSubmit={(v) => smUrlResolver.current?.(v.trim())} />
          </Box>
        </Box>
      );
    // "suggesting"/"checking"/"handing-off" — their own live row is in
    // StepsList instead (right under the checklist — see the dynamic row
    // there), the same spot the permanent checkmark entry lands in once
    // it's done. Nothing shows here for that whole stretch.
    if (nextStepsSubPhase !== "menu") return null;
    return (
      <Box flexDirection="column">
        <Box flexDirection="column">
          <Text bold>Next actions</Text>
          <SelectMenu items={availableNextStepOptions(nextStepsLog)} accentColor={accent ?? "white"} onSelect={handleNextStepChoice} />
        </Box>
        <Box marginTop={1}>
          <Text color={muted}>
            press{" "}
            <Text color={accent} bold>
              ⏎ enter
            </Text>{" "}
            to trigger an action · ↑↓ move · q to finish
          </Text>
        </Box>
      </Box>
    );
  }

  if (!started) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Header stackUrl={initialStackUrl} />
        <Text>
          Let's set up Frontend Observability for this project.
        </Text>
        <EnterHint />
      </Box>
    );
  }

  if (done) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Header stackUrl={initialStackUrl} />
        {StepsList()}
        <Box marginTop={1} flexDirection="column">
          <Text bold>{frontendFile ? "Cool, we're done!" : frontendError ? "Setup incomplete." : "Nothing to do."}</Text>
          {frontendFile && appUrl && (
            <Text color={muted}>
              Once changes are live, data will show up here: <Text color={url}>{appUrl}</Text>
            </Text>
          )}
          {frontendFile && sessionReplayEnabled && (
            <Text color={muted}>Session Replay is beta and needs to be separately enabled on this stack, or it'll record nothing.</Text>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Header stackUrl={initialStackUrl} />
      {StepsList()}
      <Box
        marginTop={
          failureSummary ||
          (currentStep === "gcx" && gcx.subPhase === "gcx-install-confirm") ||
          (currentStep === "auth" && (auth.subPhase === "browser-confirm" || auth.subPhase === "authenticating")) ||
          (currentStep === "pick-app" && pickAppSubPhase !== "checking" && pickAppSubPhase !== "advancing") ||
          currentStep === "next-steps"
            ? 1
            : 0
        }
        flexDirection="column"
      >
        {failureSummary ? (
          <Text color={bad} bold>
            Setup incomplete. {failureSummary}
          </Text>
        ) : (
          <>
            {currentStep === "gcx" && gcx.body}
            {currentStep === "auth" && auth.body}
            {currentStep === "pick-app" && PickAppBody()}
            {currentStep === "next-steps" && NextStepsBody()}
          </>
        )}
      </Box>
      {failureSummary && (
        <Box marginTop={1}>
          <Text color={muted}>Resolve the issue, then run `npx @grafana/cloud-setup frontend` again.</Text>
        </Box>
      )}
    </Box>
  );
}

export async function runFrontendUI(
  initialStackUrl: string,
  forceGcxInstall: boolean,
  initialAppName?: string,
  origin: "direct" | "chained" = "direct"
): Promise<void> {
  await requireInteractiveTerminal("frontend", initialStackUrl);
  // exitOnCtrlC disabled — see the matching comment in SetupApp.tsx's
  // runSetupUI: Ink's own default Ctrl+C handling otherwise wins the race
  // against useHardExit's useInput callback and kills the process before
  // our "Cancelled." message ever prints.
  const app = render(
    <FrontendApp
      initialStackUrl={initialStackUrl}
      forceGcxInstall={forceGcxInstall}
      initialAppName={initialAppName}
      origin={origin}
    />,
    { exitOnCtrlC: false }
  );
  await app.waitUntilExit();
}
