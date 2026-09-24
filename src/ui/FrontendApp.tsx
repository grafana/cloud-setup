import { Box, render, Text } from "ink";
import { COLORS } from "../theme.js";
import { SetupUrls } from "./SetupUrls.js";
import { EnterHint, Header, Link, requireInteractiveTerminal, type HardExit } from "./shared.js";
import { CommonStepBody } from "./workflow/CommonStepBody.js";
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
            detail={(step) => (
              <>
                {step === "gcx" && state.gcx.error && <Text color={COLORS.MUTED}> {state.gcx.error}</Text>}
                {step === "auth" && state.auth.error && (
                  <Text color={COLORS.MUTED}> Skipping auto-lookup ({state.auth.error})</Text>
                )}
                {/* Result lines (what got picked, instrumentation progress),
                not a caveat — same 5-space indent CheckResults uses in the
                synthetics wizard, not the 1-space gcx/auth caveat offset
                above. */}
                {step === "pick-app" && config && (
                  <Text color={COLORS.MUTED}>
                    {"     "}
                    app: {config.name}
                    {"\n     "}sampling: {Math.round((config.samplingRate ?? 1) * 100)}%{"\n     "}replay:{" "}
                    {config.sessionReplay ? `enabled (${config.replayMasking})` : "disabled"}
                  </Text>
                )}
                {step === "instrument" && config && (
                  <Text color={COLORS.MUTED}>
                    {"     "}
                    {state.progress}%{state.instrumentedFile ? `: ${state.instrumentedFile}` : ""}
                  </Text>
                )}
              </>
            )}
          />
          <Box marginTop={state.prompt || state.done || state.failureSummary ? 1 : 0} flexDirection="column">
            {state.failureSummary ? (
              <Text color={COLORS.BAD}>Setup incomplete. {state.failureSummary}</Text>
            ) : state.done ? (
              <>
                <Text bold>{state.outcome === "ok" ? "Cool, we're done!" : "Setup incomplete."}</Text>
                {state.error && <Text color={COLORS.MUTED}>{state.error}</Text>}
                {state.outcome === "ok" && state.appUrl && (
                  <Text color={COLORS.MUTED}>
                    Once changes are live, data will show up here: <Link>{state.appUrl}</Link>
                  </Text>
                )}
                {state.outcome === "ok" && config?.sessionReplay && (
                  <Text color={COLORS.MUTED}>
                    Session Replay is beta and needs to be separately enabled on this stack, or it'll record nothing.
                  </Text>
                )}
              </>
            ) : (
              <>
                <CommonStepBody {...state} />
                <FrontendPrompts key={state.prompt} state={state} controller={controller} />
              </>
            )}
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
