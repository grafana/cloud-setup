import { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { EnterHint } from "../shared.js";

export function PromptInput({
  label,
  initialValue = "",
  mask,
  onSubmit,
}: {
  label: string;
  initialValue?: string;
  mask?: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <Box flexDirection="column">
      <Box>
        <Text>{label}: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} mask={mask} />
      </Box>
      <EnterHint />
    </Box>
  );
}
