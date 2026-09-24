import { Box, Text } from "ink";
import { COLORS, ICONS } from "../../theme.js";
import { Link } from "../shared.js";
import { StepList } from "../workflow/StepList.js";
import { CheckResults } from "./CheckResults.js";
import { SYNTHETICS_STEPS, type SyntheticsState } from "./model.js";

export function SyntheticsProgress({ state }: { state: SyntheticsState }) {
  const firstPass = state.analyzeMode === "fast" ? state.items : state.records.filter((item) => item.pass === "fast");
  return (
    <Box flexDirection="column">
      <StepList
        labels={SYNTHETICS_STEPS}
        state={state}
        detail={(step) => (
          <>
            {step === "gcx" && state.gcx.error && <Text color={COLORS.MUTED}> {state.gcx.error}</Text>}
            {step === "auth" && state.auth.error && (
              <Text color={COLORS.MUTED}>
                {" "}
                Skipping AI-powered suggestions. You'll be asked for a Synthetic Monitoring access token later (
                {state.auth.error})
              </Text>
            )}
            {step === "create" && <CheckResults items={firstPass} />}
            {step === "alerting" &&
              state.alertingDetail.map((line, index) => (
                <Text key={index} color={COLORS.MUTED}>
                  {" "}
                  {line.text}
                  {line.href && (
                    <>
                      {" "}
                      <Link>{line.href}</Link>
                    </>
                  )}
                </Text>
              ))}
          </>
        )}
      />
      {state.nextStepsLog.map((entry) => (
        <Box key={entry.key} flexDirection="column">
          <Text>
            {" "}
            {entry.status === "failed" && <Text color={COLORS.BAD}>{ICONS.FAIL} </Text>}
            {entry.label}
          </Text>
          {entry.detail && <Text color={COLORS.MUTED}> {entry.detail}</Text>}
          {entry.items && <CheckResults items={entry.items} />}
        </Box>
      ))}
      {state.analyzeMode === "browser-discovery" && state.currentStep !== "next-steps" && (
        <Box flexDirection="column">
          <Text>
            {" "}
            Find additional synthetic checks{state.currentStep === "analyze" ? `: ${state.analyzeProgress}%` : ""}
          </Text>
          <CheckResults items={state.items} />
        </Box>
      )}
      {state.exporting && <Text> Exporting checks as Terraform…</Text>}
    </Box>
  );
}
