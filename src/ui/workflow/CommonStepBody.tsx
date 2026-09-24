import { Box, Text } from "ink";
import { GCX_INSTALL_COMMAND } from "../../gcx.js";
import { COLORS } from "../../theme.js";
import { EnterHint } from "../shared.js";
import type { CommonState } from "./commonSteps.js";

export function CommonStepBody({ currentStep, gcx, auth }: CommonState & { currentStep: string }) {
  if (currentStep === "gcx" && gcx.subPhase === "gcx-install-confirm")
    return (
      <Box flexDirection="column">
        <Text>
          {gcx.reinstalling ? "Reinstall the Grafana Cloud CLI (gcx)?" : "gcx isn't installed. Install it now?"}
        </Text>
        <Text color={COLORS.MUTED}>{GCX_INSTALL_COMMAND}</Text>
        <EnterHint suffix="or n to skip" />
      </Box>
    );
  if (currentStep !== "auth") return null;
  if (auth.subPhase === "browser-confirm")
    return (
      <Box flexDirection="column">
        <Text>Sign in to Grafana Cloud using your browser?</Text>
        <EnterHint suffix="or n to skip" />
      </Box>
    );
  return (
    <Text color={COLORS.MUTED}>
      Waiting for sign-in in the browser. Press n or Esc to cancel and continue without it.
    </Text>
  );
}
