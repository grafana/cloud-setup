import { setTimeout as sleep } from "node:timers/promises";
import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ensureAssistantAuth } from "../../harness/index.js";
import { EnterHint, MIN_SPINNER_MS, muted } from "../shared.js";

export type AuthSubPhase = "browser-confirm" | "authenticating";
export const AUTH_WAITING_SUBPHASES: AuthSubPhase[] = ["browser-confirm"];

export interface AuthStep {
  subPhase: AuthSubPhase;
  error: string | undefined;
  isWaiting: boolean;
  body: React.ReactNode;
  run(stackUrl: string, isCancelled: () => boolean): Promise<void>;
}

// Shared "auth" step: ask once, up front, whether it's OK to open a browser
// to sign in to Grafana Assistant. A declined, timed out, or failed sign-in
// just means whatever comes after skips its AI-assisted half — `error` is
// still surfaced (never swallowed) so a real failure stays diagnosable, but
// it's never treated as fatal here.
export function useAuthStep(confirmText: string, isActive: boolean): AuthStep {
  const [subPhase, setSubPhase] = useState<AuthSubPhase>("browser-confirm");
  const [error, setError] = useState<string>();
  const permissionResolver = useRef<((allow: boolean) => void) | undefined>(undefined);
  // Lets the "authenticating" wait be cancelled well before the 5-minute
  // callback timeout — e.g. the browser never opened, or the user just
  // changed their mind. Only ever set while a login attempt is actually
  // in flight; see ensureAssistantAuth's `signal` param.
  const abortController = useRef<AbortController | undefined>(undefined);

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") permissionResolver.current?.(true);
      else if (input.toLowerCase() === "n") permissionResolver.current?.(false);
    },
    { isActive: isActive && subPhase === "browser-confirm" }
  );
  useInput(
    (input, key) => {
      if (key.escape || input.toLowerCase() === "n") abortController.current?.abort();
    },
    { isActive: isActive && subPhase === "authenticating" }
  );

  async function run(stackUrl: string, isCancelled: () => boolean): Promise<void> {
    setSubPhase("browser-confirm");
    setError(undefined);
    const allow = await new Promise<boolean>((resolve) => {
      permissionResolver.current = resolve;
    });
    if (isCancelled()) return;

    if (!allow) {
      setError("declined");
      return;
    }

    setSubPhase("authenticating");
    const controller = new AbortController();
    abortController.current = controller;
    try {
      await Promise.all([ensureAssistantAuth(stackUrl, controller.signal), sleep(MIN_SPINNER_MS)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      abortController.current = undefined;
    }
  }

  const body =
    subPhase === "browser-confirm" ? (
      <Box flexDirection="column">
        <Text>{confirmText}</Text>
        <EnterHint suffix="or n to skip" />
      </Box>
    ) : subPhase === "authenticating" ? (
      <Text color={muted}>Waiting for sign-in in the browser — press n or Esc to cancel and continue without it.</Text>
    ) : null;

  return { subPhase, error, isWaiting: AUTH_WAITING_SUBPHASES.includes(subPhase), body, run };
}
