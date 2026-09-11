import { setTimeout as sleep } from "node:timers/promises";
import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ensureAssistantAuth } from "../../harness/index.js";
import { EnterHint, MIN_SPINNER_MS } from "../shared.js";

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

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") permissionResolver.current?.(true);
      else if (input.toLowerCase() === "n") permissionResolver.current?.(false);
    },
    { isActive: isActive && subPhase === "browser-confirm" }
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
    try {
      await Promise.all([ensureAssistantAuth(stackUrl), sleep(MIN_SPINNER_MS)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const body =
    subPhase === "browser-confirm" ? (
      <Box flexDirection="column">
        <Text>{confirmText}</Text>
        <EnterHint suffix="or n to skip" />
      </Box>
    ) : null;

  return { subPhase, error, isWaiting: AUTH_WAITING_SUBPHASES.includes(subPhase), body, run };
}
