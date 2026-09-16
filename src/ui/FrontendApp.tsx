import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import React, { useEffect, useRef, useState } from "react";
import { Box, render, Text, useInput } from "ink";
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
import type { FaroInstrumentation, FrontendTarget } from "../products/frontendO11y/instrument.js";
import { instrumentNextjs } from "../products/frontendO11y/nextjs.js";
import { instrumentReact } from "../products/frontendO11y/react.js";
import { accent, bad, EnterHint, Header, MIN_SPINNER_MS, muted, ok, startFakeProgress, useHardExit } from "./shared.js";
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
  "pick-app": "Pick Frontend Observability app",
  instrument: "Instrument project with Faro SDK",
};

// No real progress signal across "instrument" either (a fixed file edit,
// or an agent-assisted React/Next.js edit) — same fake-progress treatment
// as "Analyze target" in SetupApp.tsx (see shared.tsx's startFakeProgress),
// just a shorter target since this step is typically much quicker.
const INSTRUMENT_PROGRESS_TARGET_MS = 20_000;

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
// existing Faro apps — creating a new one isn't possible through this
// OAuth session (verified live: Frontend Observability's plugin-proxy
// route only accepts a real Service Account token for writes, unlike
// Synthetic Monitoring's datasource-proxy route). If --app named one
// that exists, or exactly one app exists overall, it's used directly
// with no extra step. With more than one and no --app, "picking-app"
// shows a picker (with a "create a new app" option at the end). If none
// exist at all (or the named one doesn't), opens the Frontend
// Observability app page for the user to create one there instead, then
// asks for its collector URL.
type PickAppSubPhase = "checking" | "picking-app" | "collector-url-input";
const PICK_APP_WAITING_SUBPHASES: PickAppSubPhase[] = ["picking-app", "collector-url-input"];

interface Props {
  initialStackUrl: string;
  forceGcxInstall: boolean;
  initialAppName?: string;
  sessionReplay: boolean;
}

export function FrontendApp({ initialStackUrl, forceGcxInstall, initialAppName, sessionReplay }: Props) {
  const exit = useHardExit();

  const [started, setStarted] = useState(false);
  const [currentStep, setCurrentStep] = useState<StepId>("gcx");
  const [completed, setCompleted] = useState<Set<StepId>>(new Set());
  const [done, setDone] = useState(false);
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
  const [instrumentProgress, setInstrumentProgress] = useState(0);

  // gcx/auth steps — shared with SetupApp via src/ui/steps.
  const gcx = useGcxStep(forceGcxInstall, currentStep === "gcx");
  const auth = useAuthStep(
    "Sign in to Grafana Cloud to look up your Frontend Observability apps automatically? This will open a browser.",
    currentStep === "auth"
  );

  // undefined means "none of these — create a new app instead" (the
  // picker's trailing option), not "still waiting".
  const appPickerResolver = useRef<((app: FaroApp | undefined) => void) | undefined>(undefined);
  const collectorUrlResolver = useRef<((url: string) => void) | undefined>(undefined);

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

  function advance() {
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
    { isActive: !started }
  );

  // Quit is disabled while free text is being typed (a URL could
  // legitimately contain the letter q) — Ctrl+C still works there.
  const quittingBlocked = currentStep === "pick-app" && pickAppSubPhase === "collector-url-input";
  useInput(
    (input) => {
      if (input.toLowerCase() === "q") exit("Cancelled.");
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

  useEffect(() => {
    if (!started) return;
    let cancelled = false;

    async function runGcx() {
      await gcx.run(() => cancelled);
      if (cancelled) return;
      advance();
    }

    async function runAuth() {
      await auth.run(initialStackUrl, () => cancelled);
      if (cancelled) return;
      advance();
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
        } else {
          const apps = (await faro?.list()) ?? [];
          if (apps.length === 1) {
            chosen = apps[0];
          } else if (apps.length > 1) {
            setFaroApps(apps);
            setAppPickerCursor(0);
            setPickAppSubPhase("picking-app");
            chosen = await new Promise<FaroApp | undefined>((resolve) => {
              appPickerResolver.current = resolve;
            });
            if (cancelled) return;
          }
        }

        const base = initialStackUrl.replace(/\/$/, "");
        if (chosen) {
          instrumentationBaseRef.current = { name: chosen.name, collectorUrl: `${chosen.collectEndpointURL}/${chosen.appKey}` };
          setAppUrl(chosen.id ? `${base}/a/grafana-kowalski-app/apps/${chosen.id}` : `${base}/a/grafana-kowalski-app`);
        } else {
          const fallbackName = initialAppName ?? readPkgName(process.cwd()) ?? path.basename(process.cwd());
          openFrontendO11ySetupPage(initialStackUrl);
          setPickAppSubPhase("collector-url-input");
          const pastedUrl = await new Promise<string>((resolve) => {
            collectorUrlResolver.current = resolve;
          });
          if (cancelled) return;
          instrumentationBaseRef.current = { name: fallbackName, collectorUrl: pastedUrl };
          setAppUrl(`${base}/a/grafana-kowalski-app`);
        }
      } catch (err) {
        if (cancelled) return;
        frontendSkippedRef.current = true;
        setFrontendError(err instanceof Error ? err.message : String(err));
      }
      if (cancelled) return;
      advance();
    }

    async function runInstrument() {
      if (frontendSkippedRef.current) {
        advance();
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
        sessionReplay,
      };
      const replayPackages = sessionReplay ? [REPLAY_FARO_PACKAGE] : [];

      try {
        if (target.kind === "javascript") {
          insertFaroSnippet(process.cwd(), target, instrumentation);
          await installFaroPackages(process.cwd(), [...JAVASCRIPT_FARO_PACKAGES, ...replayPackages]);
          if (cancelled) {
            progress.stop();
            return;
          }
          setFrontendFile(target.file);
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
          }
          if (cancelled) {
            progress.stop();
            return;
          }

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
          }
          if (cancelled) {
            progress.stop();
            return;
          }

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
        setFrontendError(err instanceof Error ? err.message : String(err));
      }
      if (cancelled) return;
      await progress.finish();
      if (cancelled) return;
      advance();
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

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, started]);

  useEffect(() => {
    if (done) exit();
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
                <Text color={ok}>✓</Text> {STEP_LABELS[step]}
                {suffix && <Text color={muted}> — {suffix}</Text>}
              </Text>
            );
          } else if (step === currentStep) {
            const icon = isWaiting ? (
              <Text color={accent}>●</Text>
            ) : (
              <Text color={accent}>
                <Spinner type="dots" />
              </Text>
            );
            row = (
              <Text>
                {" "}
                {icon} <Text bold>{STEP_LABELS[step]}</Text>
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
              {step === "instrument" && completed.has(step) && frontendFile && <Text>{"     "}Instrumented {frontendFile}</Text>}
              {step === "instrument" && completed.has(step) && frontendError && (
                <Text color={muted}>{"     "}Skipped Frontend Observability setup ({frontendError})</Text>
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
          <Text>Which Frontend Observability app is this?</Text>
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
            <Text color={muted}>↑↓ move   ↵ choose</Text>
          </Box>
        </Box>
      );
    if (pickAppSubPhase === "collector-url-input")
      return (
        <Box flexDirection="column">
          <Text>A browser window just opened — create a new app there, then paste its collector URL here.</Text>
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
    return null;
  }

  if (!started) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Header stackUrl={initialStackUrl} />
        <Text>
          Let's set up <Text bold>Frontend Observability</Text> for this project.
        </Text>
        <Box marginTop={1}>
          <EnterHint />
        </Box>
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
              Once changes are live, data will show up here: <Text color="blue">{appUrl}</Text>
            </Text>
          )}
          {frontendFile && sessionReplay && (
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
          (currentStep === "auth" && auth.subPhase === "browser-confirm") ||
          (currentStep === "pick-app" && pickAppSubPhase !== "checking")
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
  sessionReplay = false
): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("synthetics requires an interactive terminal.");
  }
  // exitOnCtrlC disabled — see the matching comment in SetupApp.tsx's
  // runSetupUI: Ink's own default Ctrl+C handling otherwise wins the race
  // against useHardExit's useInput callback and kills the process before
  // our "Cancelled." message ever prints.
  const app = render(
    <FrontendApp
      initialStackUrl={initialStackUrl}
      forceGcxInstall={forceGcxInstall}
      initialAppName={initialAppName}
      sessionReplay={sessionReplay}
    />,
    { exitOnCtrlC: false }
  );
  await app.waitUntilExit();
}
