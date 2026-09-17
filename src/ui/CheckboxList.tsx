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

// Descriptions are padded to the longest one actually present so the
// interval lines up in its own column — reasonable now that AI-discovered
// descriptions are capped at a short length (see MAX_AI_DESCRIPTION_LENGTH
// in discover.ts); when nothing bounded that length, one long outlier
// dragged every row's interval far to the right along with it.
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
  const hasMeta = items.some((item) => item.meta);
  const descWidth = hasMeta ? Math.max(...items.map((item) => item.description.length)) : 0;

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
            <Text color={muted}>
              {" ".repeat(COLUMN_GUTTER)}
              {hasMeta ? item.description.padEnd(descWidth) : item.description}
              {item.meta ? ` ${item.meta}` : ""}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
