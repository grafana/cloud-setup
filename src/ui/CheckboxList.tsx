import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { muted } from "./shared.js";

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

// A long description used to be padded out to the longest description
// among *all* items, then followed by its interval — on any row with a
// shorter description that padding pushed the interval far to the right,
// away from the check name it describes. Not padding the description (and
// not wrapping it into a fixed column either — each row just takes the
// width its own text needs) keeps the interval right after the text it
// belongs to, on every row.
const PREFIX_WIDTH = 2; // "› " or "  "
const CHECKBOX_WIDTH = 4; // "[x] " or "[ ] "
const COLUMN_GUTTER = 2;

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
  const labelColWidth = PREFIX_WIDTH + CHECKBOX_WIDTH + labelWidth;

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const focused = i === cursor;
        return (
          <Box key={item.key} flexDirection="row">
            <Box width={labelColWidth} flexShrink={0}>
              <Text color={focused ? accentColor : undefined} bold={focused}>
                {focused ? "› " : "  "}[{selected.has(item.key) ? "x" : " "}] {item.label}
              </Text>
            </Box>
            <Text color={focused ? undefined : muted}>
              {" ".repeat(COLUMN_GUTTER)}
              {item.description}
              {item.meta ? ` ${item.meta}` : ""}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
