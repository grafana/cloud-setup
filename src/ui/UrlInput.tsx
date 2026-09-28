import { useState } from "react";
import { Box, Text } from "ink";
import { COLORS, ICONS } from "../theme.js";
import { validateSetupUrl, type UrlKind } from "../urls.js";
import { EditableTextInput } from "./EditableTextInput.js";

const prompts = {
  target: {
    label: "Target URL",
    question: "What's the URL of the service you want to monitor?",
    hint: "You can enter a full URL (e.g. https://example.com) or just the domain (e.g. example.com)",
  },
  stack: {
    label: "Stack",
    question: "Which Grafana Cloud stack should we use?",
    hint: "You can enter a full URL (e.g. https://my-team.grafana.net) or just the slug (e.g. my-team)",
  },
  collector: {
    label: "Faro collector URL",
    question: "What's the Faro collector URL from your app's setup page?",
    hint: "You can omit https://, but include the full collector path and app key.",
  },
};

// Only submit valid, normalized URLs. Invalid input stays editable here,
// so callers don't need to manage validation errors or retry prompts.
export function UrlInput({
  kind,
  initialValue = "",
  onSubmit,
}: {
  kind: UrlKind;
  initialValue?: string;
  onSubmit: (url: string) => void;
}) {
  const [error, setError] = useState(() => (initialValue ? validateSetupUrl(initialValue, kind).error : undefined));
  const { label, question, hint } = prompts[kind];
  return (
    <Box flexDirection="column">
      {error && (
        <Text color={COLORS.BAD}>
          {ICONS.FAIL} {error}
        </Text>
      )}
      <Text>{question}</Text>
      <Text color={COLORS.MUTED}>{hint}</Text>
      <Box>
        <Text>{label}: </Text>
        <EditableTextInput
          initialValue={initialValue}
          onSubmit={(raw) => {
            const result = validateSetupUrl(raw, kind);
            if (result.error !== undefined) setError(result.error);
            else onSubmit(result.url);
          }}
        />
      </Box>
    </Box>
  );
}
