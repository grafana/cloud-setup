import { useState } from "react";
import { Box, Text } from "ink";
import { COLORS, ICONS } from "../theme.js";
import type { UrlResult } from "../urls.js";
import { EditableTextInput } from "./EditableTextInput.js";

// Only submit valid, normalized URLs. Invalid input stays editable here,
// so callers don't need to manage validation errors or retry prompts.
export function UrlInput({
  label,
  question,
  hint,
  validate,
  initialValue = "",
  onSubmit,
}: {
  label: string;
  question: string;
  hint: string;
  validate: (value: string) => UrlResult;
  initialValue?: string;
  onSubmit: (url: string) => void;
}) {
  const [error, setError] = useState(() => (initialValue ? validate(initialValue).error : undefined));

  const handleSubmit = (raw: string) => {
    const result = validate(raw);
    if (result.error !== undefined) setError(result.error);
    else onSubmit(result.url);
  };

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
        <EditableTextInput initialValue={initialValue} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
