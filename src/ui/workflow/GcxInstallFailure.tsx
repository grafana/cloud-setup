import { Text } from "ink";
import { GCX_INSTALL_COMMAND } from "../../gcx.js";
import { COLORS } from "../../theme.js";
import { StepDetail } from "./StepDetail.js";

export function GcxInstallFailure({ error }: { error: string }) {
  return (
    <>
      <StepDetail>
        <Text color={COLORS.MUTED}>{error}</Text>
      </StepDetail>
      <StepDetail>
        <Text color={COLORS.MUTED}>Retry later: {GCX_INSTALL_COMMAND}</Text>
      </StepDetail>
    </>
  );
}
