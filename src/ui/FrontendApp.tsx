import { Box, render, Text } from "ink";
import { COLORS } from "../theme.js";
import { SetupUrls } from "./SetupUrls.js";
import { EnterHint, FeedbackLink, Header, Link, requireInteractiveTerminal, type HardExit } from "./shared.js";
import { CommonStepBody } from "./workflow/CommonStepBody.js";
import { GcxInstallFailure } from "./workflow/GcxInstallFailure.js";
import { StepList } from "./workflow/StepList.js";
import { useWorkflow } from "./workflow/useWorkflow.js";
import { useWorkflowInput } from "./workflow/useWorkflowInput.js";
import { createFrontendController } from "./frontend/controller.js";
import { FRONTEND_STEPS } from "./frontend/model.js";
import { FrontendPrompts } from "./frontend/FrontendPrompts.js";

interface Props {
  initialStackUrl: string;
  forceGcxInstall: boolean;
  initialAppName?: string;
  exit: HardExit;
}

export function FrontendApp({ initialStackUrl, forceGcxInstall, initialAppName, exit }: Props) {
  const { controller, state } = useWorkflow(
    () =>
      createFrontendController({
        stackUrl: initialStackUrl,
        forceGcxInstall,
        appName: initialAppName,
        cwd: process.cwd(),
      }),
    exit,
  );
  useWorkflowInput(controller, state, exit, ["collectorUrl", "sampling"], (input, key) => {
    const yes = key.return || input.toLowerCase() === "y";
    if (!yes && input.toLowerCase() !== "n") return;
    if (state.prompt === "createApp") controller.answer("createApp", yes);
    if (state.prompt === "replay") controller.answer("replay", yes);
  });
  const config = state.instrumentation;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Header stackUrl={initialStackUrl} />
      {!state.started ? (
        <>
          <Text>Let's set up Frontend Observability for this project.</Text>
          <EnterHint />
        </>
      ) : (
        <>
          <StepList
            labels={FRONTEND_STEPS}
            state={state}
            // Same line as the row's own label, same muted color as the
            // analogous "Find additional synthetic checks 45%" progress in
            // the synthetics wizard — a live percent while active. StepList
            // only renders this while the row is active, so it can't linger
            // once the step finishes — the file it touched is a result by
            // then, not a live status, and moves to `detail` below.
            suffix={(step) => (step === "instrument" && config ? `${state.progress}%` : undefined)}
            detail={(step) => (
              <>
                {step === "gcx" && state.gcx.error && <GcxInstallFailure error={state.gcx.error} />}
                {step === "auth" && state.auth.error && (
                  <Text color={COLORS.MUTED}> Skipping auto-lookup ({state.auth.error})</Text>
                )}
                {/* Result lines use the same five-space indent as other step details. */}
                {step === "pick-app" && config && (
                  <Text color={COLORS.MUTED}>
                    {"     "}
                    App: {config.name}
                    {state.samplingKnown && (
                      <>
                        {"\n     "}Sampling: {Math.round((config.samplingRate ?? 1) * 100)}%
                      </>
                    )}
                    {state.replayKnown && (
                      <>
                        {"\n     "}Replay:{" "}
                        {config.sessionReplay
                          ? `enabled${state.replayMaskingKnown ? ` (${config.replayMasking})` : ""}`
                          : "disabled"}
                      </>
                    )}
                  </Text>
                )}
                {/* One file per line rather than joined on one — a
                Next.js run can touch two (component + layout), and
                cramming both onto one line runs long fast. */}
                {step === "instrument" &&
                  state.instrumentedFiles?.map(({ file, created }) => (
                    <Text key={file} color={COLORS.MUTED}>
                      {"     "}
                      {created ? "Created" : "Edited"} {file}
                    </Text>
                  ))}
              </>
            )}
          />
          {/* Always 1, not state.prompt ? 1 : 0 — controller.answer()
          clears prompt synchronously, one render before the resumed step's
          own update (e.g. auth's subPhase) catches up. A body that doesn't
          depend on prompt (like CommonStepBody's auth text) would render
          unchanged but suddenly hugging the row above for that one frame. */}
          <Box marginTop={1} flexDirection="column">
            {state.failureSummary ? (
              <>
                <Text color={COLORS.BAD}>Setup incomplete. {state.failureSummary}</Text>
                <Text color={COLORS.MUTED}>Resolve the issue, then run `npx @grafana/cloud-setup frontend` again.</Text>
              </>
            ) : state.done ? (
              <>
                <Text bold>
                  {state.outcome !== "ok" ? "Setup incomplete." : config ? "Cool, we're done!" : "Setup skipped."}
                </Text>
                {state.outcome !== "ok" && (
                  <>
                    {state.error && <Text color={COLORS.MUTED}>{state.error}</Text>}
                    <Text color={COLORS.MUTED}>
                      Resolve the issue, then run `npx @grafana/cloud-setup frontend` again.
                    </Text>
                  </>
                )}
                {state.outcome === "ok" && state.appUrl && (
                  <Text color={COLORS.MUTED}>
                    Once changes are live, data will show up here: <Link>{state.appUrl}</Link>
                  </Text>
                )}
                {state.outcome === "ok" && config?.sessionReplay && (
                  <Text color={COLORS.MUTED}>
                    Session Replay is in public preview and needs to be separately enabled on this stack, or it'll
                    record nothing:{" "}
                    <Link>
                      https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/session-replay/#overview
                    </Link>
                  </Text>
                )}
              </>
            ) : (
              <>
                <CommonStepBody {...state} />
                <FrontendPrompts key={state.prompt} state={state} controller={controller} />
              </>
            )}
            {(state.failureSummary || state.done) && <FeedbackLink />}
          </Box>
        </>
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
  // exitOnCtrlC disabled — see the matching comment in SyntheticsApp.tsx's
  // runSyntheticsUI: Ink's own default Ctrl+C handling otherwise wins the race
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
  // Ink rejects this promise for an error exit, but that error's message is
  // already on screen (the "Setup incomplete" text) and hardExit already
  // owns the real process.exit(code) below — letting the rejection reach
  // main()'s own catch would just print the same message a second time.
  await app.waitUntilExit().catch(() => {});
}
