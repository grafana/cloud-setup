import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useEffect, useRef, type ReactNode } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { detectFramework } from "../framework.js";
import { ANIMATE, COLORS, ICONS } from "../theme.js";
import { recordRun, waitForTelemetry, type Command, type Outcome } from "../telemetry.js";

// Every automatic spinner/loading-bar phase stays visible at least this
// long, even when the real work behind it finishes faster.
export const MIN_SPINNER_MS = 3000;

function formatFolder(cwd: string): string {
  const home = os.homedir();
  return cwd === home || cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
}

// Display-only — every actual request still uses the real stackUrl passed
// in by the caller, this just declutters what's shown in the header.
function formatStackUrl(stackUrl: string): string {
  return stackUrl.replace(/^https?:\/\//, "");
}

// Resolved lazily (not top-level constants) — cli.ts may chdir into
// --folder after this module has already been imported, so capturing
// process.cwd() at import time would freeze in the wrong directory.

// Read from package.json rather than hardcoded, so the two can't drift.
interface PackageManifest {
  version?: string;
  engines?: { node?: string };
}

function readPackageJson(): PackageManifest {
  try {
    const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageManifest;
  } catch {
    return {};
  }
}

const PACKAGE_JSON = readPackageJson();

export const PACKAGE_VERSION = PACKAGE_JSON.version ?? "0.0.0";

// engines.node is a range like ">=22.6.0". An unreadable manifest yields 0.0,
// which lets every version through rather than guessing a floor.
function parseNodeFloor(range: string | undefined): { major: number; minor: number } {
  const match = /(\d+)\.(\d+)/.exec(range ?? "");
  if (!match) return { major: 0, minor: 0 };
  return { major: Number(match[1]), minor: Number(match[2]) };
}

const MIN_NODE = parseNodeFloor(PACKAGE_JSON.engines?.node);

export function checkNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)) {
    throw new Error(`Node ${MIN_NODE.major}.${MIN_NODE.minor}+ is required (found ${process.versions.node}).`);
  }
}

// Ink needs a TTY on stdin for keyboard input, so a non-interactive run cannot
// work at all. Reported before throwing, because otherwise the runs that never
// got started are the one failure mode that leaves no trace.
export async function requireInteractiveTerminal(command: Command, stackUrl: string): Promise<void> {
  if (process.stdin.isTTY) return;
  recordRun(command, stackUrl, "no_tty", 0);
  await waitForTelemetry();
  throw new Error(`${command} requires an interactive terminal.`);
}

// Ink's own exit() only unmounts the React tree — it restores the
// terminal (cursor, raw mode) but doesn't actually end the Node process.
// Anything still in flight when the user quits (the OAuth callback
// server, an open SSE fetch, a spawned npm/gcx install) then keeps the
// event loop alive, so the CLI never returns control to the shell — it
// just sits there looking frozen, which is exactly the "weird state"
// after a single Ctrl+C. Forcing a real process.exit() right after
// covers every quit path; the Ctrl+C handler here is always active
// (unlike the 'q' quit key, which free-text input screens disable) so it
// works no matter what's on screen.
// A string cancels silently-but-visibly (prints the message, exit code 0)
// — used for a user-initiated quit (Ctrl+C, 'q', declining the initial
// prompt). An Error is a real failure (exit code 1); its message was
// already rendered by the failing screen itself, so it isn't repeated
// here. Undefined uses the supplied outcome: incomplete/error exits with
// code 1, and a completed or deliberately skipped setup exits with code 0.
export type HardExit = (errorOrMessage?: Error | string, setupOutcome?: Outcome) => void;

export function useHardExit(command: Command, stackUrl: string): HardExit {
  const { exit } = useApp();
  const startedAt = useRef(Date.now());
  const exitCode = useRef<number | undefined>(undefined);
  // The URL can be supplied by the initial prompt after this hook mounts.
  // The SIGINT handler must use the current stack, just like keyboard exit.
  const currentStackUrl = useRef(stackUrl);
  currentStackUrl.current = stackUrl;

  function hardExit(errorOrMessage?: Error | string, setupOutcome?: Outcome): void {
    // Registering a SIGINT listener means nothing else will kill the process,
    // so a second Ctrl+C has to exit here or it would look ignored.
    if (exitCode.current !== undefined) {
      process.exit(exitCode.current);
    }
    const error = errorOrMessage instanceof Error ? errorOrMessage : undefined;
    const outcome: Outcome = error ? "error" : errorOrMessage !== undefined ? "canceled" : (setupOutcome ?? "ok");
    const code = outcome === "ok" || outcome === "canceled" ? 0 : 1;
    exitCode.current = code;
    // exit() first, while Ink still owns the terminal — it restores the
    // cursor and raw mode; printing before that would just get clobbered
    // by Ink's own rendering.
    // The screen already rendered failures. Passing an Error to Ink would
    // reject waitUntilExit(), causing cli.ts to print it again and exit early.
    exit();
    if (typeof errorOrMessage === "string") console.log(errorOrMessage);

    recordRun(command, currentStackUrl.current, outcome, Date.now() - startedAt.current);

    // setImmediate, not a same-tick process.exit() — Ink's own unmount
    // cleanup and the console.log above both write to the terminal, and
    // need a turn of the event loop to actually flush before the process
    // dies, or they can get silently dropped.
    void waitForTelemetry().finally(() => {
      setImmediate(() => process.exit(code));
    });
  }

  // Byte-level detection for platforms/terminals where raw mode actually
  // suppresses signal generation on Ctrl+C.
  useInput((input, key) => {
    if (key.ctrl && input === "c") hardExit("Cancelled.");
  });

  // Verified live: on this setup, raw mode does NOT suppress signal
  // generation — Ctrl+C still delivers a real SIGINT, and without an
  // explicit listener Node's default handler kills the process
  // immediately, before the useInput callback above ever runs. Once a
  // SIGINT listener is registered, Node no longer auto-exits — this one
  // *is* the exit, going through the same hardExit so cleanup and the
  // "Cancelled." message stay identical either way.
  useEffect(() => {
    function onSigint() {
      hardExit("Cancelled.");
    }
    process.on("SIGINT", onSigint);
    return () => {
      process.off("SIGINT", onSigint);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return hardExit;
}

// The one "press enter to continue" phrasing, shared by the intro
// screens, every y/n confirm (with the "or n to skip" suffix), and the
// select step's footer — spelling out the actual key rather than a bare
// "(Y/n)" reads more like an instruction than a notation to decode.
export function EnterHint({ suffix }: { suffix?: string } = {}) {
  return (
    <Text color={COLORS.MUTED}>
      press{" "}
      <Text color={COLORS.ACCENT} bold>
        {ICONS.ENTER} enter
      </Text>{" "}
      to continue{suffix ? `, ${suffix}` : ""}
    </Text>
  );
}

// Underlined as well as colored, because color alone cannot carry this.
// ANSI blue is whatever the theme says it is, and on the common dark
// palettes it lands between 1.6:1 and 3.4:1 against their own backgrounds.
// Underline also survives NO_COLOR, where a URL would otherwise be
// indistinguishable from the prose around it.
export function Link({ children }: { children: ReactNode }) {
  return (
    <Text color={COLORS.URL} underline>
      {children}
    </Text>
  );
}

export function Working({ label }: { label: string }) {
  return (
    <Text>
      {ANIMATE ? (
        <Text color={COLORS.ACCENT}>
          <Spinner type="dots" />
        </Text>
      ) : (
        "…"
      )}{" "}
      {label}
    </Text>
  );
}

export { startFakeProgress, type FakeProgress } from "./workflow/progress.js";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Text>
      <Text color={COLORS.MUTED}>{label.padEnd(14)}</Text>
      {value}
    </Text>
  );
}

export function Header({ stackUrl }: { stackUrl: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text>{ICONS.BRAND} @grafana/cloud-setup</Text>
        <Text color={COLORS.MUTED}> {PACKAGE_VERSION}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Field label="Folder" value={formatFolder(process.cwd())} />
        <Field label="Detected" value={detectFramework(process.cwd())} />
        <Field label="Stack" value={formatStackUrl(stackUrl)} />
      </Box>
    </Box>
  );
}
