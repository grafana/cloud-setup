import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface CheckboxItem {
  key: string;
  label: string;
  description: string;
  meta?: string;
}

interface Props {
  items: CheckboxItem[];
  initialSelected: Set<string>;
  accentColor: string;
  onSubmit: (selectedKeys: string[]) => void;
  onSelectionChange?: (selectedKeys: string[]) => void;
}

// Deliberately bare on footer — the parent (which has the rest of the step
// chrome) renders the keybind footer, so this stays reusable across steps
// that want different surrounding layout.
export function CheckboxList({ items, initialSelected, accentColor, onSubmit, onSelectionChange }: Props) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c - 1 + items.length) % items.length);
    } else if (key.downArrow) {
      setCursor((c) => (c + 1) % items.length);
    } else if (input === " ") {
      const k = items[cursor]?.key;
      if (k !== undefined) {
        const next = new Set(selected);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        setSelected(next);
        onSelectionChange?.(Array.from(next));
      }
    } else if (key.return) {
      onSubmit(Array.from(selected));
    }
  });

  const labelWidth = Math.max(...items.map((item) => item.label.length));
  const hasMeta = items.some((item) => item.meta);
  const descWidth = hasMeta ? Math.max(...items.map((item) => item.description.length)) : 0;

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={item.key}>
          <Text color={i === cursor ? accentColor : undefined} bold={i === cursor}>
            {i === cursor ? "› " : "  "}[{selected.has(item.key) ? "x" : " "}] {item.label.padEnd(labelWidth)}
          </Text>
          {item.description && <Text color="gray">   {hasMeta ? item.description.padEnd(descWidth) : item.description}</Text>}
          {item.meta && <Text color="gray">   {item.meta}</Text>}
        </Text>
      ))}
    </Box>
  );
}
