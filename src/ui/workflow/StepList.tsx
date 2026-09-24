import type { ReactNode } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { COLORS, ICONS } from "../../theme.js";
import type { WorkflowState } from "./controller.js";

export function StepList<Step extends string>({
  labels,
  state,
  detail,
}: {
  labels: Record<Step, string>;
  state: WorkflowState<Step>;
  detail?: (step: Step) => ReactNode;
}) {
  return (
    <Box flexDirection="column">
      {(Object.keys(labels) as Step[]).map((step) => {
        const status = state.results[step]?.status;
        const active = !state.done && !state.failureSummary && step === state.currentStep;
        const icon = active ? (
          state.prompt ? (
            ICONS.WAITING
          ) : (
            <Spinner type="dots" />
          )
        ) : status === "ok" ? (
          ICONS.OK
        ) : status === "failed" ? (
          ICONS.FAIL
        ) : status ? (
          ICONS.SKIPPED
        ) : (
          ICONS.PENDING
        );
        const color = active
          ? COLORS.ACCENT
          : status === "ok"
            ? COLORS.OK
            : status === "failed"
              ? COLORS.BAD
              : COLORS.MUTED;
        return (
          <Box key={step} flexDirection="column">
            <Text>
              {" "}
              <Text color={color}>{icon}</Text> <Text bold={active}>{labels[step]}</Text>
            </Text>
            {detail?.(step)}
          </Box>
        );
      })}
    </Box>
  );
}
