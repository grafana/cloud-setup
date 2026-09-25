import { stripVTControlCharacters } from "node:util";
import type { ReactNode } from "react";
import { Box, Text, Transform } from "ink";

export function StepDetail({ children }: { children: ReactNode }) {
  return (
    <Box paddingLeft={5}>
      <WrappedText>{children}</WrappedText>
    </Box>
  );
}

export function WrappedText({ children }: { children: ReactNode }) {
  return (
    <Transform
      transform={(line) => {
        // Ink can carry a separator space onto the next line when a word
        // ends exactly at the edge. Remove it without removing styling.
        return stripVTControlCharacters(line).startsWith(" ") ? line.replace(/ +/, "") : line;
      }}
    >
      <Text>{children}</Text>
    </Transform>
  );
}
