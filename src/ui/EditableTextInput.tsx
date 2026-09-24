import { useRef, useState } from "react";
import { Text, useInput } from "ink";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const characters = (value: string): string[] => Array.from(segmenter.segment(value), ({ segment }) => segment);
const isWord = (character: string): boolean => /[\p{L}\p{N}_]/u.test(character);

function wordLeft(value: string[], cursor: number): number {
  while (cursor > 0 && !isWord(value[cursor - 1]!)) cursor--;
  while (cursor > 0 && isWord(value[cursor - 1]!)) cursor--;
  return cursor;
}

function wordRight(value: string[], cursor: number): number {
  while (cursor < value.length && !isWord(value[cursor]!)) cursor++;
  while (cursor < value.length && isWord(value[cursor]!)) cursor++;
  return cursor;
}

// Uncontrolled input: initialValue is read on mount. The enclosing URL form
// remounts this component when switching fields.
export function EditableTextInput({
  initialValue,
  onSubmit,
}: {
  initialValue: string;
  onSubmit: (value: string) => void;
}) {
  const [state, setState] = useState(() => {
    const value = characters(initialValue);
    return { value, cursor: value.length };
  });
  // Ink can deliver several keypresses before React renders again. Read and
  // update this snapshot synchronously so repeats and submission see all edits.
  const current = useRef(state);

  useInput((input, key) => {
    if (key.eventType === "release" || key.super || key.hyper) return;
    const previous = current.current;
    const { value, cursor } = previous;
    if (key.return) {
      onSubmit(value.join(""));
      return;
    }

    let next = previous;
    const move = (position: number) => {
      next = { value, cursor: Math.max(0, Math.min(value.length, position)) };
    };
    const replace = (start: number, end: number, inserted: string[] = []) => {
      next = { value: [...value.slice(0, start), ...inserted, ...value.slice(end)], cursor: start + inserted.length };
    };

    if (key.home || (key.ctrl && input === "a")) move(0);
    else if (key.end || (key.ctrl && input === "e")) move(value.length);
    else if ((key.leftArrow && (key.meta || key.ctrl)) || (key.meta && input === "b")) {
      move(wordLeft(value, cursor));
    } else if ((key.rightArrow && (key.meta || key.ctrl)) || (key.meta && input === "f")) {
      move(wordRight(value, cursor));
    } else if (key.leftArrow || (key.ctrl && input === "b")) move(cursor - 1);
    else if (key.rightArrow || (key.ctrl && input === "f")) move(cursor + 1);
    else if (key.ctrl && input === "u") replace(0, cursor);
    else if (key.ctrl && input === "k") replace(cursor, value.length);
    else if ((key.ctrl && input === "w") || (key.backspace && key.meta)) replace(wordLeft(value, cursor), cursor);
    else if (key.meta && input === "d") replace(cursor, wordRight(value, cursor));
    else if (key.backspace) replace(Math.max(0, cursor - 1), cursor);
    else if (key.delete || (key.ctrl && input === "d")) replace(cursor, Math.min(value.length, cursor + 1));
    else if (!key.ctrl && !key.meta && input && !/\p{Cc}/u.test(input)) replace(cursor, cursor, characters(input));

    if (next !== previous) {
      current.current = next;
      setState(next);
    }
  });

  return (
    <Text>
      {state.value.slice(0, state.cursor).join("")}
      <Text inverse>{state.value[state.cursor] ?? " "}</Text>
      {state.value.slice(state.cursor + 1).join("")}
    </Text>
  );
}
