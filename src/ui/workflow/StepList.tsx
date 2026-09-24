import type { ReactNode } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { COLORS, ICONS } from "../../theme.js";
import type { WorkflowState } from "./controller.js";

export function StepList<Step extends string>({
  labels,
  state,
  detail,
  hidden,
  suffix,
}: {
  labels: Record<Step, string>;
  state: WorkflowState<Step>;
  detail?: (step: Step) => ReactNode;
  // A step that isn't a real do-once task (e.g. a repeatable post-creation
  // menu) has no meaningful pending/done state of its own to show as a row
  // — whatever it produces shows up as its own standalone row instead.
  hidden?: readonly Step[];
  // Rendered inline on the row's own line, right after the label (e.g. a
  // live percent) — always muted, so it reads as secondary to the label
  // rather than competing with it, and only while the row is active: once
  // a step finishes, whatever it produced is a result, not a live status,
  // and belongs in `detail` (its own line below the row) instead — the
  // same reason a live "45%" doesn't stay glued to a checkmark forever.
  suffix?: (step: Step) => ReactNode;
}) {
  return (
    <Box flexDirection="column">
      {(Object.keys(labels) as Step[])
        .filter((step) => !hidden?.includes(step))
        .map((step) => {
          const status = state.results[step]?.status;
          // A step already in `completed` never reactivates, even if a later
          // pass (e.g. a repeated "Find additional synthetic checks" run)
          // sends currentStep back through it — that pass's own progress
          // shows on its own row instead, never by flipping this one back to
          // a spinner.
          const active =
            !state.done && !state.failureSummary && step === state.currentStep && !state.completed.has(step);
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
          const suffixContent = active ? suffix?.(step) : undefined;
          return (
            <Box key={step} flexDirection="column">
              <Text>
                {" "}
                <Text color={color}>{icon}</Text> <Text bold={active}>{labels[step]}</Text>
                {suffixContent != null && suffixContent !== "" && <Text color={COLORS.MUTED}> {suffixContent}</Text>}
              </Text>
              {detail?.(step)}
            </Box>
          );
        })}
    </Box>
  );
}
