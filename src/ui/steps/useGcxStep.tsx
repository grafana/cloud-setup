import { setTimeout as sleep } from "node:timers/promises";
import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { GCX_INSTALL_COMMAND, installGcx, isGcxInstalled } from "../../gcx.js";
import { checkNodeVersion, EnterHint, MIN_SPINNER_MS } from "../shared.js";
import { COLORS } from "../../theme.js";

export type GcxSubPhase = "checking-gcx" | "gcx-install-confirm" | "gcx-installing";
export const GCX_WAITING_SUBPHASES: GcxSubPhase[] = ["gcx-install-confirm"];

export interface GcxRunResult {
  alreadyInstalled: boolean;
  installDeclined: boolean;
}

export interface GcxStep {
  subPhase: GcxSubPhase;
  isWaiting: boolean;
  body: React.ReactNode;
  run(isCancelled: () => boolean): Promise<GcxRunResult>;
}

// Shared "gcx" step: check whether the Grafana Cloud CLI is installed and,
// if not (or --force-gcx-install), offer to install it. Nothing downstream
// in this tool actually calls gcx itself — it's just handy to have locally
// — so a failed or declined install is never fatal, only reported.
export function useGcxStep(forceGcxInstall: boolean, isActive: boolean): GcxStep {
  const [subPhase, setSubPhase] = useState<GcxSubPhase>("checking-gcx");
  const [reinstalling, setReinstalling] = useState(false);
  const installResolver = useRef<((install: boolean) => void) | undefined>(undefined);

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") installResolver.current?.(true);
      else if (input.toLowerCase() === "n") installResolver.current?.(false);
    },
    { isActive: isActive && subPhase === "gcx-install-confirm" },
  );

  async function run(isCancelled: () => boolean): Promise<GcxRunResult> {
    checkNodeVersion();
    setSubPhase("checking-gcx");
    const gcxAvailable = isGcxInstalled();
    await sleep(MIN_SPINNER_MS);
    if (isCancelled()) return { alreadyInstalled: gcxAvailable, installDeclined: false };

    let installDeclined = false;
    // The flag only surfaces this path when gcx is already there (so you
    // get offered a reinstall instead of nothing happening) — it never
    // skips the confirmation itself.
    if (forceGcxInstall || !gcxAvailable) {
      setReinstalling(gcxAvailable);
      setSubPhase("gcx-install-confirm");
      const shouldInstall = await new Promise<boolean>((resolve) => {
        installResolver.current = resolve;
      });
      if (isCancelled()) return { alreadyInstalled: gcxAvailable, installDeclined: false };
      installDeclined = !shouldInstall;
      if (shouldInstall) {
        setSubPhase("gcx-installing");
        try {
          await Promise.all([installGcx(), sleep(MIN_SPINNER_MS)]);
        } catch {
          // Not required for anything downstream — a failed or declined
          // install isn't fatal.
        }
      }
    }
    return { alreadyInstalled: gcxAvailable, installDeclined };
  }

  const body =
    subPhase === "gcx-install-confirm" ? (
      <Box flexDirection="column">
        <Text>{reinstalling ? "Reinstall the Grafana Cloud CLI (gcx)?" : "gcx isn't installed. Install it now?"}</Text>
        <Text color={COLORS.MUTED}>{GCX_INSTALL_COMMAND}</Text>
        <EnterHint suffix="or n to skip" />
      </Box>
    ) : null;

  return { subPhase, isWaiting: GCX_WAITING_SUBPHASES.includes(subPhase), body, run };
}
