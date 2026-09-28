import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { ANIMATE, COLORS, ICONS } from "../../theme.js";
import { Link, Working } from "../shared.js";
import { StepList } from "../workflow/StepList.js";
import { GcxInstallFailure } from "../workflow/GcxInstallFailure.js";
import { StepDetail } from "../workflow/StepDetail.js";
import { CheckResults } from "./CheckResults.js";
import { SYNTHETICS_STEPS, type SyntheticsState } from "./model.js";

export function SyntheticsProgress({ state }: { state: SyntheticsState }) {
  const firstPass = state.analyzeMode === "fast" ? state.items : state.records.filter((item) => item.pass === "fast");
  const additionalPass = state.analyzeMode === "browser-discovery" && state.currentStep !== "next-steps";
  return (
    <Box flexDirection="column">
      <StepList
        labels={SYNTHETICS_STEPS}
        state={state}
        hidden={state.failureSummary && state.currentStep === "next-steps" ? [] : ["next-steps"]}
        detail={(step) => (
          <>
            {step === "create" && <CheckResults items={firstPass} />}
            {step === "gcx" && state.gcx.error && <GcxInstallFailure error={state.gcx.error} />}
            {step === "auth" && state.auth.error && (
              <StepDetail>
                <Text color={COLORS.MUTED}>
                  Skipping AI-powered suggestions. You'll be asked for a Synthetic Monitoring access token later (
                  {state.auth.error})
                </Text>
              </StepDetail>
            )}
            {step === "alerting" &&
              state.alertingDetail.map((line, index) => (
                <StepDetail key={index}>
                  <Text color={COLORS.MUTED}>
                    {line.text}
                    {line.href && !line.error && (
                      <>
                        {" "}
                        <Link>{line.href}</Link>
                      </>
                    )}
                  </Text>
                </StepDetail>
              ))}
          </>
        )}
      />
      {/* Each finished next-step action lands as its own standalone row,
      formatted exactly like a fixed step row (StepList) rather than nested
      under one — it's a completed item in the same list, not a detail of
      something else. */}
      {state.nextStepsLog.map((entry) => (
        <Box key={entry.key} flexDirection="column">
          <Text>
            {" "}
            {entry.status === "failed" ? (
              <Text color={COLORS.BAD}>{ICONS.FAIL}</Text>
            ) : (
              <Text color={COLORS.OK}>{ICONS.OK}</Text>
            )}{" "}
            {entry.label}
          </Text>
          {entry.detail && (
            <StepDetail>
              <Text color={COLORS.MUTED}>{entry.detail}</Text>
            </StepDetail>
          )}
          {entry.items && <CheckResults items={entry.items} />}
        </Box>
      ))}
      {additionalPass && (
        <Box flexDirection="column">
          <Text>
            {" "}
            {/* ICONS.WAITING (not the spinner) while a question is actually
            pending, same as StepList's own active row — the spinner alone
            would look like idle progress rather than something waiting on
            the user. */}
            {state.failureSummary ? (
              <Text color={COLORS.BAD}>{ICONS.FAIL}</Text>
            ) : state.prompt ? (
              <Text color={COLORS.ACCENT}>{ICONS.WAITING}</Text>
            ) : ANIMATE ? (
              <Text color={COLORS.ACCENT}>
                <Spinner type="dots" />
              </Text>
            ) : (
              "…"
            )}{" "}
            <Text bold={!state.failureSummary}>Find additional synthetic checks</Text>
            {/* Muted, same as StepList's own inline suffix (e.g. Frontend's
            "Instrument project with Faro SDK 45%") — a live percent reads
            as secondary to the label, not part of it. A colon only ever
            separates a percent from extra context (FrontendApp's instrument
            step: "45%: src/main.tsx"), never a label from its own percent,
            so this is a plain space. */}
            {state.currentStep === "analyze" && !state.failureSummary && (
              <Text color={COLORS.MUTED}> {state.analyzeProgress}%</Text>
            )}
          </Text>
          <CheckResults items={state.items} />
        </Box>
      )}
      {state.exporting && (
        <Text>
          {" "}
          <Working label="Exporting checks as Terraform" />
        </Text>
      )}
      {state.configuringSkills && (
        <Text>
          {" "}
          <Working label="Configuring agent skills" />
        </Text>
      )}
    </Box>
  );
}
