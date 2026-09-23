import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { muted } from "./shared.js";

export interface SelectMenuItem {
  key: string;
  label: string;
}

interface Props {
  items: SelectMenuItem[];
  // Undefined under NO_COLOR; bold still marks the focused row.
  accentColor: string | undefined;
  onSelect: (key: string) => void;
}

// Single-selection sibling to CheckboxList — arrow keys move a cursor,
// Enter invokes onSelect for the highlighted item. No checkboxes, no
// multi-select, no footer (same as CheckboxList, the parent owns hints).
export function SelectMenu({ items, accentColor, onSelect }: Props) {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) setCursor((c) => (c - 1 + items.length) % items.length);
    else if (key.downArrow) setCursor((c) => (c + 1) % items.length);
    else if (key.return) {
      const item = items[cursor];
      if (item) onSelect(item.key);
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const focused = i === cursor;
        return (
          <Text key={item.key} color={focused ? accentColor : muted} bold={focused}>
            {focused ? "› " : "  "}
            {item.label}
          </Text>
        );
      })}
    </Box>
  );
}
