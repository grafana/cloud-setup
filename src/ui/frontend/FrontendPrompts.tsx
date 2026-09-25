import { Box, Text } from "ink";
import type { ReplayMasking } from "../../products/frontendO11y/instrument.js";
import { COLORS } from "../../theme.js";
import { SelectMenu } from "../SelectMenu.js";
import { EnterHint, Link } from "../shared.js";
import { PromptInput } from "../workflow/PromptInput.js";
import type { WorkflowController } from "../workflow/controller.js";
import type { FrontendInputs, FrontendState } from "./model.js";

function collectorHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function FrontendPrompts({
  state,
  controller,
}: {
  state: FrontendState;
  controller: WorkflowController<FrontendState, FrontendInputs>;
}) {
  switch (state.prompt) {
    case "app":
      return (
        <Box flexDirection="column">
          <Text>Which Frontend Observability app do you want to use?</Text>
          <SelectMenu
            accentColor={COLORS.ACCENT}
            items={[
              ...state.apps.map((app, index) => ({
                key: String(index),
                label: `${app.name}${app.collectEndpointURL ? ` (${collectorHost(app.collectEndpointURL)})` : ""}`,
              })),
              { key: "new", label: "Create a new app" },
            ]}
            onSelect={(key) => controller.answer("app", state.apps[Number(key)])}
          />
          {/* Same marginTop={1} gap the synthetics wizard's own SelectMenu/
          CheckboxList prompts use before their hint — a plain y/n confirm
          doesn't get one, but a menu to navigate does. */}
          <Box marginTop={1}>
            <EnterHint />
          </Box>
        </Box>
      );
    case "createApp":
      return (
        <Box flexDirection="column">
          <Text>
            No existing app found. Create one? If automatic creation fails, this opens your browser. Come back with its
            collector URL once it is created.
          </Text>
          <EnterHint suffix="or n to skip" />
        </Box>
      );
    case "collectorUrl":
      return <PromptInput label="Faro collector URL" onSubmit={(value) => controller.answer("collectorUrl", value)} />;
    case "sampling":
      return (
        <PromptInput
          label="Session sampling rate (%)"
          initialValue="100"
          onSubmit={(value) => controller.answer("sampling", value)}
        />
      );
    case "replay":
      return (
        <Box flexDirection="column">
          <Text>Enable Session Replay? Records user sessions, consent may be required.</Text>
          <Text color={COLORS.MUTED}>
            Privacy details:{" "}
            <Link>
              https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/session-replay/data-privacy/
            </Link>
          </Text>
          <EnterHint suffix="or n to skip" />
        </Box>
      );
    case "masking":
      return (
        <Box flexDirection="column">
          <Text>Privacy masking for Session Replay:</Text>
          <SelectMenu
            accentColor={COLORS.ACCENT}
            items={[
              { key: "strict", label: "Strict: mask all text, inputs and images" },
              { key: "balanced", label: "Balanced: all inputs" },
              { key: "open", label: "Open: sensitive inputs only" },
            ]}
            onSelect={(key) => controller.answer("masking", key as ReplayMasking)}
          />
          {/* Same marginTop={1} gap as the "app" prompt above. */}
          <Box marginTop={1}>
            <EnterHint />
          </Box>
        </Box>
      );
    default:
      return null;
  }
}
