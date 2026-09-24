import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { ANIMATE, COLORS, ICONS } from "../../theme.js";
import { Link, Working } from "../shared.js";
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
        hidden={["next-steps"]}
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
            {/* The shared folder every detected agent reads the skill from
            (e.g. .agents/skills/synthetic-monitoring-checks) — a familiar,
            single, checkable location, rather than naming tools. Same
            "Wrote to ..." phrasing as the Terraform export result below. */}
            {step === "skills" && state.skillPath && (
              <Text color={COLORS.MUTED}>
                {"     "}Wrote to {state.skillPath}
              </Text>
            )}
            {step === "create" && <CheckResults items={firstPass} />}
            {/* Same 5-space indent CheckResults uses above — these are
            result lines for the alerting step, not a caveat/error aside
            like the gcx/auth ones above them. */}
            {step === "alerting" &&
              state.alertingDetail.map((line, index) => (
                <Text key={index} color={COLORS.MUTED}>
                  {"     "}
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
      {/* Each finished next-step action lands as its own standalone row,
      formatted exactly like a fixed step row (StepList) rather than nested
      under one — it's a completed item in the same list, not a detail of
      something else. */}
      {state.nextStepsLog.map((entry) => (
        <Box key={entry.key} flexDirection="column">
          <Text>
            {" "}
            <Text color={COLORS.OK}>{ICONS.OK}</Text> {entry.label}
          </Text>
          {/* Same 5-space indent CheckResults uses for its own result rows
          (create step, above) — this is a result line too, just without
          items to itemize, and should nest under its row the same way. */}
          {entry.detail && (
            <Text color={COLORS.MUTED}>
              {"     "}
              {entry.detail}
            </Text>
          )}
          {entry.items && <CheckResults items={entry.items} />}
        </Box>
      ))}
      {state.analyzeMode === "browser-discovery" && state.currentStep !== "next-steps" && (
        <Box flexDirection="column">
          <Text>
            {" "}
            {/* ICONS.WAITING (not the spinner) while a question is actually
            pending, same as StepList's own active row — the spinner alone
            would look like idle progress rather than something waiting on
            the user. */}
            {state.prompt ? (
              <Text color={COLORS.ACCENT}>{ICONS.WAITING}</Text>
            ) : ANIMATE ? (
              <Text color={COLORS.ACCENT}>
                <Spinner type="dots" />
              </Text>
            ) : (
              "…"
            )}{" "}
            <Text bold>Find additional synthetic checks</Text>
            {/* Muted, same as StepList's own inline suffix (e.g. Frontend's
            "Instrument project with Faro SDK 45%") — a live percent reads
            as secondary to the label, not part of it. A colon only ever
            separates a percent from extra context (FrontendApp's instrument
            step: "45%: src/main.tsx"), never a label from its own percent,
            so this is a plain space. */}
            {state.currentStep === "analyze" && <Text color={COLORS.MUTED}> {state.analyzeProgress}%</Text>}
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
    </Box>
  );
}
