import { useRef } from "react";
import { Box, Text } from "ink";
import { EnterHint, Header, muted } from "../shared.js";

// Shared by both wizards' cross-product handoff confirmations (SetupApp.tsx's
// "Configure Frontend Observability now?" and FrontendApp.tsx's "Set up
// Synthetic Monitoring now?"). Unlike a plain next-step action, accepting one
// of these ends the run outright, so it gets its own dedicated, decluttered
// screen — replacing the whole checklist view (rather than nesting this in
// the usual body) lets Ink's own re-render erase down to just this, the same
// way it erases back up to the full checklist once answered — instead of
// firing the instant it's picked. `resolve` is exposed separately from `ask`
// so a step-level 'q' handler can treat "quit" the same as "no" here: unlike
// every other y/n in these wizards (where 'q' falls through to a full
// process exit), backing out of a run-ending confirmation is exactly what
// 'n' already means, so 'q' should behave the same way here rather than
// hard-exiting.
export interface ConfirmScreen {
  ask(): Promise<boolean>;
  resolve(allow: boolean): void;
  render(stackUrl: string, question: string, note: string): React.ReactNode;
}

export function useConfirmScreen(): ConfirmScreen {
  const resolver = useRef<((allow: boolean) => void) | undefined>(undefined);

  function ask(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }

  function resolve(allow: boolean): void {
    resolver.current?.(allow);
  }

  function render(stackUrl: string, question: string, note: string) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Header stackUrl={stackUrl} />
        <Text>{question}</Text>
        <Text color={muted}>{note}</Text>
        <EnterHint suffix="or n to go back" />
      </Box>
    );
  }

  return { ask, resolve, render };
}
