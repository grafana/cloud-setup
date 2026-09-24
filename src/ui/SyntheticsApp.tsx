import { Box, render, Text } from "ink";
import { COLORS } from "../theme.js";
import { SetupUrls } from "./SetupUrls.js";
import { EnterHint, Header, Link, requireInteractiveTerminal, type HardExit } from "./shared.js";
import { CommonStepBody } from "./workflow/CommonStepBody.js";
import { useWorkflow } from "./workflow/useWorkflow.js";
import { useWorkflowInput } from "./workflow/useWorkflowInput.js";
import { createSyntheticsController } from "./synthetics/controller.js";
import { unhandledCandidates } from "./synthetics/model.js";
import { ChecksSummary } from "./synthetics/CheckResults.js";
import { SyntheticsPrompts } from "./synthetics/SyntheticsPrompts.js";
import { SyntheticsProgress } from "./synthetics/SyntheticsProgress.js";

interface Props {
  initialBaseUrl?: string;
  initialTargetUrl: string;
  initialStackUrl: string;
  forceGcxInstall: boolean;
  exit: HardExit;
}

export function SyntheticsApp({ initialBaseUrl, initialTargetUrl, initialStackUrl, forceGcxInstall, exit }: Props) {
  const options = {
    baseUrl: initialBaseUrl,
    targetUrl: initialTargetUrl,
    stackUrl: initialStackUrl,
    forceGcxInstall,
    cwd: process.cwd(),
  };
  const { controller, state } = useWorkflow(() => createSyntheticsController(options), exit);
  useWorkflowInput(
    controller,
    state,
    exit,
    ["baseUrl", "token", "email"],
    (input, key) => {
      if (state.prompt === "selection" && !unhandledCandidates(state).length && key.return)
        controller.answer("selection", []);
      const yes = key.return || input.toLowerCase() === "y";
      if (!yes && input.toLowerCase() !== "n") return;
      if (state.prompt === "browser") controller.answer("browser", yes);
      if (state.prompt === "alerting") controller.answer("alerting", yes);
    },
    () => {
      if (state.prompt === "nextAction") controller.answer("nextAction", "finish");
      else exit("Cancelled.");
    },
  );
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Header stackUrl={initialStackUrl} />
      {!state.started ? (
        <>
          <Text>
            Let's set up synthetic checks for <Link>{initialTargetUrl}</Link>
          </Text>
          <EnterHint />
        </>
      ) : (
        <>
          <SyntheticsProgress state={state} />
          {/* Always 1, not state.prompt ? 1 : 0 — controller.answer()
          clears prompt synchronously, one render before the resumed step's
          own update (e.g. auth's subPhase) catches up. A body that doesn't
          depend on prompt (like CommonStepBody's auth text) would render
          unchanged but suddenly hugging the row above for that one frame. */}
          <Box marginTop={1} flexDirection="column">
            {state.failureSummary ? (
              <>
                <Text color={COLORS.BAD}>Setup incomplete. {state.failureSummary}</Text>
                <Text color={COLORS.MUTED}>Resolve the issue, then run `npx @grafana/cloud-setup` again.</Text>
              </>
            ) : state.done ? (
              <ChecksSummary items={state.records} stackUrl={initialStackUrl} />
            ) : (
              <>
                <CommonStepBody {...state} />
                <SyntheticsPrompts key={state.prompt} state={state} options={options} controller={controller} />
              </>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}

export async function runSyntheticsUI(
  initialBaseUrl: string | undefined,
  initialTargetUrl: string | undefined,
  initialStackUrl: string | undefined,
  forceGcxInstall: boolean,
): Promise<void> {
  await requireInteractiveTerminal("synthetics", initialStackUrl ?? "");
  // exitOnCtrlC disabled — Ink's own default Ctrl+C handling runs before
  // useHardExit's useInput callback ever gets a turn (both listen on the
  // same stdin stream, and Ink's own listener wins the race), so it kills
  // the process first and our "Cancelled." message never prints. Letting
  // useHardExit be the only Ctrl+C handler avoids that race entirely.
  const app = render(
    <SetupUrls command="synthetics" initialTargetUrl={initialTargetUrl} initialStackUrl={initialStackUrl}>
      {({ targetUrl, stackUrl, exit }) => (
        <SyntheticsApp
          initialBaseUrl={initialBaseUrl}
          initialTargetUrl={targetUrl}
          initialStackUrl={stackUrl}
          forceGcxInstall={forceGcxInstall}
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
