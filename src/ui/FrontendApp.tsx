import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { debugLog } from "../debug.js";
import { useEffect, useRef, useState } from "react";
import { Box, render, Text, useInput } from "ink";
import { COLORS, ICONS } from "../theme.js";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { tryFaroClient, type FaroApp } from "../products/frontendO11y/faroAuth.js";
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
import { SetupUrls } from "./SetupUrls.js";
import {
  EnterHint,
  Header,
  Link,
  MIN_SPINNER_MS,
  requireInteractiveTerminal,
  startFakeProgress,
  type HardExit,
} from "./shared.js";
import { recordStep, type Outcome, type StepProperties, type StepStatus } from "../telemetry.js";
import { useGcxStep } from "./steps/useGcxStep.js";
import { useAuthStep } from "./steps/useAuthStep.js";

// The standalone `frontend` subcommand — just the pieces of the main
// wizard that Frontend Observability actually needs (gcx, sign-in),
// without any of the Synthetic Monitoring-specific steps (no target URL,
// no SM skill install — that's not relevant here). See SetupApp.tsx for
// the full wizard this is trimmed from.
type StepId = "gcx" | "auth" | "pick-app" | "instrument";
const STEP_ORDER: StepId[] = ["gcx", "auth", "pick-app", "instrument"];
const STEP_LABELS: Record<StepId, string> = {
  gcx: "Install Grafana Cloud CLI (gcx)",
  auth: "Authenticate with OAuth",
  "pick-app": "Pick and configure app",
  instrument: "Instrument project with Faro SDK",
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

interface Props {
  initialStackUrl: string;
  forceGcxInstall: boolean;
  initialAppName?: string;
  exit: HardExit;
}

export function FrontendApp({ initialStackUrl, forceGcxInstall, initialAppName, exit }: Props) {
  const [started, setStarted] = useState(false);
  const [currentStep, setCurrentStep] = useState<StepId>("gcx");
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

  const [sessionReplayEnabled, setSessionReplayEnabled] = useState(false);
  const [replayMasking, setReplayMasking] = useState<ReplayMasking>("balanced");
  const [maskingCursor, setMaskingCursor] = useState(0);
  const [samplingInput, setSamplingInput] = useState("100");
  const [samplingRate, setSamplingRate] = useState(1);

  // gcx/auth steps — shared with SetupApp via src/ui/steps.
  const gcx = useGcxStep(forceGcxInstall, currentStep === "gcx");
  const auth = useAuthStep("Sign in to Grafana Cloud using your browser?", currentStep === "auth");

  // undefined means "none of these — create a new app instead" (the
  // picker's trailing option), not "still waiting".
  const appPickerResolver = useRef<((app: FaroApp | undefined) => void) | undefined>(undefined);
  const createAppConfirmResolver = useRef<((allow: boolean) => void) | undefined>(undefined);
  const collectorUrlResolver = useRef<((url: string) => void) | undefined>(undefined);
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
    (currentStep === "pick-app" && PICK_APP_WAITING_SUBPHASES.includes(pickAppSubPhase));

  function advance(properties: StepProperties) {
    recordStep("frontend", initialStackUrl, currentStep, properties);
    setCompleted((prev) => new Set(prev).add(currentStep));
    const idx = STEP_ORDER.indexOf(currentStep);
    const next = STEP_ORDER[idx + 1];
    if (next) setCurrentStep(next);
  }

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") setStarted(true);
      else if (input.toLowerCase() === "n") exit("Cancelled.");
    },
    { isActive: !started },
  );

  // Quit is disabled while free text is being typed (a URL, or the
  // sampling rate, could legitimately contain the letter q) — Ctrl+C
  // still works there.
  const quittingBlocked =
    currentStep === "pick-app" && (pickAppSubPhase === "collector-url-input" || pickAppSubPhase === "sampling-input");
  useInput(
    (input) => {
      if (input.toLowerCase() === "q") exit("Cancelled.");
    },
    { isActive: !quittingBlocked },
  );

  // The last row (index === faroApps.length) is "create a new app
  // instead" — resolving with undefined there falls through to the
  // manual collector-URL flow below, same as if no apps existed at all.
  useInput(
    (_input, key) => {
      if (currentStep !== "pick-app" || pickAppSubPhase !== "picking-app") return;
      const total = faroApps.length + 1;
      if (key.upArrow) setAppPickerCursor((c) => (c - 1 + total) % total);
      else if (key.downArrow) setAppPickerCursor((c) => (c + 1) % total);
      else if (key.return) {
        appPickerResolver.current?.(appPickerCursor < faroApps.length ? faroApps[appPickerCursor] : undefined);
      }
    },
    { isActive: currentStep === "pick-app" && pickAppSubPhase === "picking-app" },
  );

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") createAppConfirmResolver.current?.(true);
      else if (input.toLowerCase() === "n") createAppConfirmResolver.current?.(false);
    },
    { isActive: currentStep === "pick-app" && pickAppSubPhase === "create-app-confirm" },
  );

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") replayConfirmResolver.current?.(true);
      else if (input.toLowerCase() === "n") replayConfirmResolver.current?.(false);
    },
    { isActive: currentStep === "pick-app" && pickAppSubPhase === "replay-confirm" },
  );

  useInput(
    (_input, key) => {
      if (key.upArrow) setMaskingCursor((c) => (c - 1 + MASKING_OPTIONS.length) % MASKING_OPTIONS.length);
      else if (key.downArrow) setMaskingCursor((c) => (c + 1) % MASKING_OPTIONS.length);
      else if (key.return) maskingResolver.current?.(MASKING_OPTIONS[maskingCursor]!.key);
    },
    { isActive: currentStep === "pick-app" && pickAppSubPhase === "masking-picker" },
  );

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
          "This project doesn't match a shape this tool can instrument automatically (Next.js, or a JS/TS project — React or otherwise — with a findable src/main or src/index entry file).",
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
          instrumentationBaseRef.current = {
            name: chosen.name,
            collectorUrl: `${chosen.collectEndpointURL}/${chosen.appKey}`,
          };
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
              instrumentationBaseRef.current = {
                name: created.name,
                collectorUrl: `${created.collectEndpointURL}/${created.appKey}`,
              };
              setAppUrl(
                created.id ? `${base}/a/grafana-kowalski-app/apps/${created.id}` : `${base}/a/grafana-kowalski-app`,
              );
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
          const base = result.routerFile
            ? `${result.entryFile}, router wrapped in ${result.routerFile}`
            : result.entryFile;
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
                : `${result.componentFile}, wired into ${result.layoutFile}`,
            );
          } else if (result.componentFile) {
            setFrontendError(
              `created ${result.componentFile}, but couldn't wire it into the layout automatically — add <FrontendObservability /> yourself`,
            );
          } else {
            setFrontendError(result.detail ?? "the agent couldn't complete the Next.js instrumentation");
          }
        }
      } catch (err) {
        if (cancelled) {
          progress.stop();
          return;
        }
        packageInstall = "failed";
        setFrontendError(err instanceof Error ? err.message : String(err));
      }
      if (cancelled) return;
      await progress.finish();
      if (cancelled) return;
      setupOutcome.current = instrumentationComplete && packageInstall === "ok" ? "ok" : "incomplete";
      advance({
        status: setupOutcome.current === "ok" ? "ok" : "failed",
        instrumentation: instrumentationComplete ? "complete" : "partial",
        target_kind: target.kind,
        package_install: packageInstall,
        ...(routerWired !== undefined ? { router_wired: routerWired } : {}),
        ...(layoutWired !== undefined ? { layout_wired: layoutWired } : {}),
      });
      setDone(true);
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

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, started]);

  useEffect(() => {
    if (done) exit(undefined, setupOutcome.current);
  }, [done, exit]);
  useEffect(() => {
    if (failureSummary) exit(new Error(failureSummary));
  }, [failureSummary, exit]);

  function StepsList() {
    return (
      <Box flexDirection="column">
        {STEP_ORDER.map((step) => {
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
                <Text color={COLORS.OK}>{ICONS.OK}</Text> {STEP_LABELS[step]}
                {suffix && <Text color={COLORS.MUTED}> — {suffix}</Text>}
              </Text>
            );
          } else if (step === currentStep) {
            const icon = isWaiting ? (
              <Text color={COLORS.ACCENT}>{ICONS.WAITING}</Text>
            ) : (
              <Text color={COLORS.ACCENT}>
                <Spinner type="dots" />
              </Text>
            );
            row = (
              <Text>
                {" "}
                {icon} <Text bold>{STEP_LABELS[step]}</Text>
                {suffix && <Text color={COLORS.MUTED}> — {suffix}</Text>}
              </Text>
            );
          } else {
            row = <Text color={COLORS.MUTED}> · {STEP_LABELS[step]}</Text>;
          }

          return (
            <Box key={step} flexDirection="column">
              {row}
              {step === "auth" && completed.has(step) && auth.error && (
                <Text color={COLORS.MUTED}> Skipping auto-lookup ({auth.error})</Text>
              )}
              {/* Standalone line, separate from the config summary below —
                  shown as soon as the app is resolved (picked or created),
                  stays up through the rest of this step and beyond. */}
              {step === "pick-app" && appName && !frontendSkippedRef.current && (
                <Text color={COLORS.MUTED}>
                  {"     "}app: {appName}
                </Text>
              )}
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
                    <Text color={COLORS.MUTED}>
                      {"     "}sampling: {Math.round(samplingRate * 100)}%
                    </Text>
                    {pickAppSubPhase === "masking-picker" && <Text color={COLORS.MUTED}>{"     "}replay: enabled</Text>}
                  </>
                )}
              {step === "pick-app" && completed.has(step) && !frontendSkippedRef.current && (
                <>
                  <Text color={COLORS.MUTED}>
                    {"     "}sampling: {Math.round(samplingRate * 100)}%
                  </Text>
                  <Text color={COLORS.MUTED}>
                    {"     "}replay: {sessionReplayEnabled ? "enabled" : "disabled"}
                  </Text>
                  {sessionReplayEnabled && (
                    <Text color={COLORS.MUTED}>
                      {"     "}replay_masking: {replayMasking}
                    </Text>
                  )}
                </>
              )}
              {step === "instrument" && completed.has(step) && frontendFile && (
                <Text color={COLORS.MUTED}>
                  {"     "}Instrumented {frontendFile}
                </Text>
              )}
              {step === "instrument" && completed.has(step) && frontendError && (
                <Text color={COLORS.MUTED}>
                  {"     "}Skipped Frontend Observability setup ({frontendError})
                </Text>
              )}
            </Box>
          );
        })}
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
                <Text color={COLORS.ACCENT} bold>
                  {`${ICONS.CURSOR} `}
                  {app.name}
                </Text>
              ) : (
                <Text>{`  ${app.name}`}</Text>
              )}
              {app.collectEndpointURL && <Text color={COLORS.MUTED}> — {faroAppHost(app.collectEndpointURL)}</Text>}
            </Text>
          ))}
          <Text>
            {appPickerCursor === faroApps.length ? (
              <Text color={COLORS.ACCENT} bold>
                {ICONS.CURSOR} Create a new app
              </Text>
            ) : (
              <Text color={COLORS.MUTED}>{"  Create a new app"}</Text>
            )}
          </Text>
          <Box marginTop={1}>
            <Text color={COLORS.MUTED}>
              press{" "}
              <Text color={COLORS.ACCENT} bold>
                {ICONS.ENTER} enter
              </Text>{" "}
              to choose · {ICONS.ARROWS} move
            </Text>
          </Box>
        </Box>
      );
    if (pickAppSubPhase === "create-app-confirm")
      return (
        <Box flexDirection="column">
          <Text>
            No existing app found. Create one? This'll open your browser. Come back here with its collector URL once
            it's created.
          </Text>
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
          <Text color={COLORS.MUTED}>
            Privacy details: <Link>{SESSION_REPLAY_DATA_PRIVACY_URL}</Link>
          </Text>
          <Text color={COLORS.MUTED}>
            press{" "}
            <Text color={COLORS.ACCENT} bold>
              {ICONS.ENTER} enter
            </Text>{" "}
            to enable, or{" "}
            <Text color={COLORS.ACCENT} bold>
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
                <Text color={COLORS.ACCENT} bold>
                  {`${ICONS.CURSOR} `}
                  {option.label}
                </Text>
              ) : (
                <Text>{`  ${option.label}`}</Text>
              )}
              <Text color={COLORS.MUTED}> — {option.description}</Text>
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color={COLORS.MUTED}>
              press{" "}
              <Text color={COLORS.ACCENT} bold>
                {ICONS.ENTER} enter
              </Text>{" "}
              to choose · {ICONS.ARROWS} move
            </Text>
          </Box>
        </Box>
      );
    if (pickAppSubPhase === "sampling-input")
      return (
        <Box flexDirection="column">
          <Box>
            <Text>Session sampling rate (%): </Text>
            <TextInput
              value={samplingInput}
              onChange={setSamplingInput}
              onSubmit={(v) => samplingResolver.current?.(parseSamplingRateInput(v))}
            />
          </Box>
          <EnterHint />
        </Box>
      );
    return null;
  }

  if (!started) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Header stackUrl={initialStackUrl} />
        <Text>Let's set up Frontend Observability for this project.</Text>
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
          <Text bold>
            {frontendFile ? "Cool, we're done!" : frontendError ? "Setup incomplete." : "Nothing to do."}
          </Text>
          {frontendFile && appUrl && (
            <Text color={COLORS.MUTED}>
              Once changes are live, data will show up here: <Link>{appUrl}</Link>
            </Text>
          )}
          {frontendFile && sessionReplayEnabled && (
            <Text color={COLORS.MUTED}>
              Session Replay is beta and needs to be separately enabled on this stack, or it'll record nothing.
            </Text>
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
          (currentStep === "pick-app" && pickAppSubPhase !== "checking" && pickAppSubPhase !== "advancing")
            ? 1
            : 0
        }
        flexDirection="column"
      >
        {failureSummary ? (
          <Text color={COLORS.BAD} bold>
            Setup incomplete. {failureSummary}
          </Text>
        ) : (
          <>
            {currentStep === "gcx" && gcx.body}
            {currentStep === "auth" && auth.body}
            {currentStep === "pick-app" && PickAppBody()}
          </>
        )}
      </Box>
      {failureSummary && (
        <Box marginTop={1}>
          <Text color={COLORS.MUTED}>Resolve the issue, then run `npx @grafana/cloud-setup frontend` again.</Text>
        </Box>
      )}
    </Box>
  );
}

export async function runFrontendUI(
  initialStackUrl: string | undefined,
  forceGcxInstall: boolean,
  initialAppName?: string,
): Promise<void> {
  await requireInteractiveTerminal("frontend", initialStackUrl ?? "");
  // exitOnCtrlC disabled — see the matching comment in SetupApp.tsx's
  // runSetupUI: Ink's own default Ctrl+C handling otherwise wins the race
  // against useHardExit's useInput callback and kills the process before
  // our "Cancelled." message ever prints.
  const app = render(
    <SetupUrls command="frontend" initialStackUrl={initialStackUrl}>
      {({ stackUrl, exit }) => (
        <FrontendApp
          initialStackUrl={stackUrl}
          forceGcxInstall={forceGcxInstall}
          initialAppName={initialAppName}
          exit={exit}
        />
      )}
    </SetupUrls>,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
}
