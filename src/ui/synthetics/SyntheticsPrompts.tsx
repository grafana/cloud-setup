import { Box, Text } from "ink";
import { alertsSummary, presetsFor } from "../../products/syntheticMonitoring/checkAlerts.js";
import { COLORS, ICONS } from "../../theme.js";
import { CheckboxList } from "../CheckboxList.js";
import { SelectMenu } from "../SelectMenu.js";
import { EnterHint, Link, Working } from "../shared.js";
import { PromptInput } from "../workflow/PromptInput.js";
import type { WorkflowController } from "../workflow/controller.js";
import { ChecksSummary } from "./CheckResults.js";
import {
  availableActions,
  canGoBack,
  unhandledCandidates,
  type SyntheticsInputs,
  type SyntheticsOptions,
  type SyntheticsState,
} from "./model.js";

function formatFrequency(ms: number) {
  const seconds = ms / 1000;
  return seconds % 60 === 0
    ? `every ${seconds / 60} minute${seconds === 60 ? "" : "s"}`
    : `every ${seconds} second${seconds === 1 ? "" : "s"}`;
}
export function SyntheticsPrompts({
  state,
  options,
  controller,
}: {
  state: SyntheticsState;
  options: SyntheticsOptions;
  controller: WorkflowController<SyntheticsState, SyntheticsInputs>;
}) {
  let body;
  switch (state.prompt) {
    case "selection": {
      const candidates = unhandledCandidates(state);
      body = (
        <Box flexDirection="column">
          <Text>
            {state.analyzeMode === "fast"
              ? "These are the synthetic checks we suggest creating"
              : "These are the additional synthetic checks we suggest creating"}
          </Text>
          {candidates.length ? (
            <CheckboxList
              items={candidates.map((candidate) => ({
                key: candidate.key,
                label: candidate.title,
                description: candidate.description,
                meta: `(${formatFrequency(candidate.frequencyMs)})`,
              }))}
              initialSelected={new Set(state.selectedKeys)}
              accentColor={COLORS.ACCENT}
              onSubmit={(keys) => controller.answer("selection", keys)}
            />
          ) : (
            <Text>No new checks to select.</Text>
          )}
          <Box marginTop={1}>
            <EnterHint suffix={`to continue · space toggle · ${ICONS.ARROWS} move`} />
          </Box>
        </Box>
      );
      break;
    }
    case "browser":
      body = (
        <Box flexDirection="column">
          <Text>
            Open a real browser to look for additional synthetic checks on <Link>{options.targetUrl}</Link>?
          </Text>
          <EnterHint suffix="or n to skip" />
        </Box>
      );
      break;
    case "baseUrl":
      body = (
        <Box flexDirection="column">
          {state.connectError && <Text color={COLORS.BAD}>{state.connectError}</Text>}
          <PromptInput label="Synthetic Monitoring API URL" onSubmit={(value) => controller.answer("baseUrl", value)} />
        </Box>
      );
      break;
    case "token":
      body = (
        <Box flexDirection="column">
          {state.tokenError && <Text color={COLORS.BAD}>{state.tokenError}</Text>}
          <Text>Enter your Grafana Cloud access token</Text>
          <Text color={COLORS.MUTED}>
            Generate one here:{" "}
            <Link>{options.stackUrl.replace(/\/$/, "")}/a/grafana-synthetic-monitoring-app/config/access-tokens</Link>
          </Text>
          <PromptInput label="Token" mask="*" onSubmit={(value) => controller.answer("token", value)} />
        </Box>
      );
      break;
    case "alerting":
      body = (
        <Box flexDirection="column">
          <Text>
            Alert on{" "}
            {alertsSummary(
              presetsFor(state.items.filter((item) => item.id !== undefined).map((item) => item.candidate)),
            )}
            ?
          </Text>
          <EnterHint suffix="or n to skip" />
        </Box>
      );
      break;
    case "email":
      body = (
        <Box flexDirection="column">
          {state.emailError && <Text color={COLORS.BAD}>{state.emailError}</Text>}
          <Text>Where should these alerts go? Separate several addresses with a comma</Text>
          {state.reusingAddresses && (
            <Text color={COLORS.MUTED}>Changing this also moves alerts from every check on this stack.</Text>
          )}
          <PromptInput
            label="Email"
            initialValue={state.emailInput}
            onSubmit={(value) => controller.answer("email", value)}
          />
        </Box>
      );
      break;
    case "nextAction":
      body = (
        <Box flexDirection="column">
          <ChecksSummary items={state.records} stackUrl={options.stackUrl} />
          <Box marginTop={1} flexDirection="column">
            <Text bold>Next actions</Text>
            <SelectMenu
              items={availableActions(state)}
              accentColor={COLORS.ACCENT}
              onSelect={(key) => controller.answer("nextAction", key as SyntheticsInputs["nextAction"])}
            />
          </Box>
          <Box marginTop={1}>
            <EnterHint suffix={`to trigger an action · ${ICONS.ARROWS} move · q to finish`} />
          </Box>
        </Box>
      );
      break;
    default:
      body =
        state.currentStep === "create" && state.createPhase === "validating" ? (
          <Working label="Validating access token…" />
        ) : null;
  }
  return (
    <Box flexDirection="column">
      {body}
      {canGoBack(state) && <Text color={COLORS.MUTED}>Esc to return to check selection</Text>}
    </Box>
  );
}
