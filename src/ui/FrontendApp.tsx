import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import React, { useEffect, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { tryFaroClient } from "../products/frontendO11y/faroAuth.js";
import {
  detectFrontendTarget,
  insertFaroSnippet,
  installFaroPackages,
  openFrontendO11ySetupPage,
  readPkgName,
  JAVASCRIPT_FARO_PACKAGES,
  REACT_FARO_PACKAGES,
} from "../products/frontendO11y/instrument.js";
import type { FaroInstrumentation } from "../products/frontendO11y/instrument.js";
import { instrumentNextjs } from "../products/frontendO11y/nextjs.js";
import { instrumentReact } from "../products/frontendO11y/react.js";
import { accent, bad, ContinueHint, Header, MIN_SPINNER_MS, muted, ok, Working } from "./shared.js";
import { useGcxStep } from "./steps/useGcxStep.js";
import { useAuthStep } from "./steps/useAuthStep.js";

// The standalone `frontend-o11y` subcommand — just the pieces of the main
// wizard that Frontend O11y actually needs (gcx, sign-in), without any of
// the Synthetic Monitoring-specific steps (no target URL, no SM skill
// install — that's not relevant here). See SetupApp.tsx for the full
// wizard this is trimmed from.
type StepId = "gcx" | "auth" | "frontend";
const STEP_ORDER: StepId[] = ["gcx", "auth", "frontend"];
const STEP_LABELS: Record<StepId, string> = {
  gcx: "Install Grafana Cloud CLI (gcx)",
  auth: "Authenticate with OAuth",
  frontend: "Instrument Frontend O11y",
};

// "checking": list existing Faro apps and reuse one whose name matches
// this project — creating a new one isn't possible through this OAuth
// session (verified live: Frontend Observability's plugin-proxy route
// only accepts a real Service Account token for writes, unlike Synthetic
// Monitoring's datasource-proxy route). When no match is found, opens the
// Frontend Observability app page for the user to create one there
// instead, then asks for its collector URL.
type FrontendSubPhase = "frontend-confirm" | "checking" | "collector-url-input" | "instrumenting";
const FRONTEND_WAITING_SUBPHASES: FrontendSubPhase[] = ["frontend-confirm", "collector-url-input"];

interface Props {
  initialStackUrl: string;
  forceGcxInstall: boolean;
}

export function FrontendApp({ initialStackUrl, forceGcxInstall }: Props) {
  const { exit } = useApp();

  const [started, setStarted] = useState(false);
  const [currentStep, setCurrentStep] = useState<StepId>("gcx");
  const [completed, setCompleted] = useState<Set<StepId>>(new Set());
  const [done, setDone] = useState(false);
  const [failureSummary, setFailureSummary] = useState<string>();

  const [frontendSubPhase, setFrontendSubPhase] = useState<FrontendSubPhase>("frontend-confirm");
  const [frontendFile, setFrontendFile] = useState<string>();
  const [frontendError, setFrontendError] = useState<string>();
  const [collectorUrlInput, setCollectorUrlInput] = useState("");

  // gcx/auth steps — shared with SetupApp via src/ui/steps.
  const gcx = useGcxStep(forceGcxInstall, currentStep === "gcx");
  const auth = useAuthStep(
    "Sign in to Grafana Cloud to look up an existing Frontend O11y app automatically? This will open a browser.",
    currentStep === "auth"
  );

  const frontendPermissionResolver = useRef<((allow: boolean) => void) | undefined>(undefined);
  const collectorUrlResolver = useRef<((url: string) => void) | undefined>(undefined);

  const isWaiting =
    (currentStep === "gcx" && gcx.isWaiting) ||
    (currentStep === "auth" && auth.isWaiting) ||
    (currentStep === "frontend" && FRONTEND_WAITING_SUBPHASES.includes(frontendSubPhase));

  function advance() {
    setCompleted((prev) => new Set(prev).add(currentStep));
    const idx = STEP_ORDER.indexOf(currentStep);
    const next = STEP_ORDER[idx + 1];
    if (next) setCurrentStep(next);
  }

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") setStarted(true);
      else if (input.toLowerCase() === "n") exit();
    },
    { isActive: !started }
  );

  // Quit is disabled while free text is being typed (a URL could
  // legitimately contain the letter q) — Ctrl+C still works there.
  const quittingBlocked = currentStep === "frontend" && frontendSubPhase === "collector-url-input";
  useInput(
    (input) => {
      if (input.toLowerCase() === "q") exit();
    },
    { isActive: !quittingBlocked }
  );

  useInput(
    (input, key) => {
      if (currentStep === "frontend" && frontendSubPhase === "frontend-confirm") {
        if (key.return || input.toLowerCase() === "y") frontendPermissionResolver.current?.(true);
        else if (input.toLowerCase() === "n") frontendPermissionResolver.current?.(false);
      }
    },
    { isActive: currentStep === "frontend" && frontendSubPhase === "frontend-confirm" }
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

    async function runFrontend() {
      setFrontendError(undefined);
      setFrontendFile(undefined);

      const target = detectFrontendTarget(process.cwd());
      if (target.kind === "unsupported") {
        throw new Error(
          "This project doesn't match a shape this tool can instrument automatically (Next.js, or a JS/TS project — React or otherwise — with a findable src/main or src/index entry file)."
        );
      }

      setFrontendSubPhase("frontend-confirm");
      const allow = await new Promise<boolean>((resolve) => {
        frontendPermissionResolver.current = resolve;
      });
      if (cancelled) return;

      if (allow) {
        try {
          const appName = readPkgName(process.cwd()) ?? path.basename(process.cwd());

          setFrontendSubPhase("checking");
          const [faro] = await Promise.all([tryFaroClient(initialStackUrl), sleep(MIN_SPINNER_MS)]);
          if (cancelled) return;
          const existing = await faro?.findExisting(appName);

          let instrumentation: FaroInstrumentation;
          if (existing) {
            instrumentation = { name: existing.name, collectorUrl: `${existing.collectEndpointURL}/${existing.appKey}` };
          } else {
            openFrontendO11ySetupPage(initialStackUrl);
            setFrontendSubPhase("collector-url-input");
            const pastedUrl = await new Promise<string>((resolve) => {
              collectorUrlResolver.current = resolve;
            });
            if (cancelled) return;
            instrumentation = { name: appName, collectorUrl: pastedUrl };
          }

          setFrontendSubPhase("instrumenting");
          if (target.kind === "javascript") {
            insertFaroSnippet(process.cwd(), target, instrumentation);
            await Promise.all([installFaroPackages(process.cwd(), JAVASCRIPT_FARO_PACKAGES), sleep(MIN_SPINNER_MS)]);
            if (cancelled) return;
            setFrontendFile(target.file);
          } else if (target.kind === "react") {
            // Run separately from installFaroPackages (not bundled into
            // one Promise.all) — a failed install would otherwise reject
            // the whole thing and discard a perfectly good instrumentation
            // result. Same pattern for the nextjs branch below.
            const [result] = await Promise.all([
              instrumentReact(process.cwd(), initialStackUrl, target.file, instrumentation),
              sleep(MIN_SPINNER_MS),
            ]);
            if (cancelled) return;

            let installError: string | undefined;
            try {
              await installFaroPackages(process.cwd(), REACT_FARO_PACKAGES);
            } catch (err) {
              installError = err instanceof Error ? err.message : String(err);
            }
            if (cancelled) return;

            const base = result.routerFile ? `${result.entryFile}, router wrapped in ${result.routerFile}` : result.entryFile;
            setFrontendFile(installError ? `${base} (package install failed: ${installError})` : base);
          } else {
            const [result] = await Promise.all([instrumentNextjs(process.cwd(), initialStackUrl, instrumentation), sleep(MIN_SPINNER_MS)]);
            if (cancelled) return;

            let installError: string | undefined;
            try {
              await installFaroPackages(process.cwd(), JAVASCRIPT_FARO_PACKAGES);
            } catch (err) {
              installError = err instanceof Error ? err.message : String(err);
            }
            if (cancelled) return;

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
          if (cancelled) return;
          setFrontendError(err instanceof Error ? err.message : String(err));
        }
      }
      if (cancelled) return;
      advance();
      setDone(true);
    }

    async function run() {
      try {
        if (currentStep === "gcx") await runGcx();
        else if (currentStep === "auth") await runAuth();
        else if (currentStep === "frontend") await runFrontend();
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
          let row;
          if (completed.has(step)) {
            row = (
              <Text>
                {" "}
                <Text color={ok}>✓</Text> {STEP_LABELS[step]}
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
              {step === "frontend" && completed.has(step) && frontendFile && <Text>{"     "}Instrumented {frontendFile}</Text>}
              {step === "frontend" && completed.has(step) && frontendError && (
                <Text color={muted}>{"     "}Skipped Frontend O11y setup ({frontendError})</Text>
              )}
            </Box>
          );
        })}
      </Box>
    );
  }

  function FrontendBody() {
    if (frontendSubPhase === "frontend-confirm")
      return (
        <Box flexDirection="column">
          <Text>Instrument this project with Frontend O11y?</Text>
          <ContinueHint />
        </Box>
      );
    if (frontendSubPhase === "checking") return <Working label="Looking for an existing Frontend O11y app…" />;
    if (frontendSubPhase === "collector-url-input")
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
    if (frontendSubPhase === "instrumenting") return <Working label="Instrumenting your project…" />;
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
          <Text color={muted}>
            press{" "}
            <Text color={accent} bold>
              ⏎ enter
            </Text>{" "}
            to continue
          </Text>
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
          <Text bold>{frontendFile ? "Cool, we're done!" : "Nothing to do."}</Text>
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
          currentStep === "frontend"
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
            {currentStep === "frontend" && FrontendBody()}
          </>
        )}
      </Box>
      {failureSummary && (
        <Box marginTop={1}>
          <Text color={muted}>Resolve the issue, then run `npx @grafana/setup-cli frontend-o11y` again.</Text>
        </Box>
      )}
    </Box>
  );
}

export async function runFrontendUI(initialStackUrl: string, forceGcxInstall: boolean): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("synthetics requires an interactive terminal.");
  }
  const app = render(<FrontendApp initialStackUrl={initialStackUrl} forceGcxInstall={forceGcxInstall} />);
  await app.waitUntilExit();
}
