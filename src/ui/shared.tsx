import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useEffect, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { detectFramework } from "../framework.js";
import { recordRun, waitForTelemetry, type Command, type Outcome } from "../telemetry.js";

export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 6;

// Every automatic spinner/loading-bar phase stays visible at least this
// long, even when the real work behind it finishes faster.
export const MIN_SPINNER_MS = 3000;

export const NO_COLOR = Boolean(process.env.NO_COLOR);
export const accent = NO_COLOR ? undefined : "#FFA500";
export const ok = NO_COLOR ? undefined : "green";
export const bad = NO_COLOR ? undefined : "red";
// A URL the user might actually open — same color everywhere one shows
// up (target URL, "view checks", "generate a token", app dashboard),
// rather than relying on bold or <angle brackets> to make it stand out.
export const url = NO_COLOR ? undefined : "blue";
// A plain ANSI "gray" (bright-black, code 90) reads as near-invisible on a
// dark/charcoal terminal background — verified live. This hex sits at a
// medium gray instead, legible as "secondary" text on both dark and light
// backgrounds without competing with the default foreground.
export const muted = NO_COLOR ? undefined : "#999999";
export const ANIMATE = Boolean(process.stdout.isTTY) && !NO_COLOR;

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
function readPackageVersion(): string {
  try {
    const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
export const PACKAGE_VERSION = readPackageVersion();

export function checkNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    throw new Error(`Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ is required (found ${process.versions.node}).`);
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
// here. Undefined is a clean, silent exit (the "done" screen already
// showed its own success message).
export function useHardExit(
  command: Command,
  stackUrl: string,
): (errorOrMessage?: Error | string, setupOutcome?: Outcome) => void {
  const { exit } = useApp();
  const startedAt = useRef(Date.now());
  const exiting = useRef(false);

  function hardExit(errorOrMessage?: Error | string, setupOutcome?: Outcome): void {
    // Registering a SIGINT listener means nothing else will kill the process,
    // so a second Ctrl+C has to exit here or it would look ignored.
    if (exiting.current) {
      process.exit(errorOrMessage instanceof Error ? 1 : 0);
    }
    exiting.current = true;
    const error = errorOrMessage instanceof Error ? errorOrMessage : undefined;
    // exit() first, while Ink still owns the terminal — it restores the
    // cursor and raw mode; printing before that would just get clobbered
    // by Ink's own rendering.
    exit(error);
    if (typeof errorOrMessage === "string") console.log(errorOrMessage);

    const outcome: Outcome = error ? "error" : errorOrMessage !== undefined ? "canceled" : (setupOutcome ?? "ok");
    recordRun(command, stackUrl, outcome, Date.now() - startedAt.current);

    // setImmediate, not a same-tick process.exit() — Ink's own unmount
    // cleanup and the console.log above both write to the terminal, and
    // need a turn of the event loop to actually flush before the process
    // dies, or they can get silently dropped.
    void waitForTelemetry().finally(() => {
      setImmediate(() => process.exit(error ? 1 : 0));
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

// The one "press ⏎ enter to continue" phrasing, shared by the intro
// screens, every y/n confirm (with the "or n to skip" suffix), and the
// select step's footer — spelling out the actual key rather than a bare
// "(Y/n)" reads more like an instruction than a notation to decode.
export function EnterHint({ suffix }: { suffix?: string } = {}) {
  return (
    <Text color={muted}>
      press{" "}
      <Text color={accent} bold>
        ⏎ enter
      </Text>{" "}
      to continue{suffix ? `, ${suffix}` : ""}
    </Text>
  );
}

export function Working({ label }: { label: string }) {
  return (
    <Text>
      {ANIMATE ? (
        <Text color={accent}>
          <Spinner type="dots" />
        </Text>
      ) : (
        "…"
      )}{" "}
      {label}
    </Text>
  );
}

export interface FakeProgress {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  finish: () => Promise<void>;
}

// Purely decorative — for steps with no real progress signal to show (one
// opaque await, or a mix of local work and a confirm question), this fakes
// one, paced against a wall-clock target rather than random step sizes so
// it reads as roughly "on schedule" instead of jittery. Real work almost
// always finishes before that target — finish() is the deliberate "speed
// up" for when it does, sprinting the number up to 100 instead of letting
// it jump there.
export function startFakeProgress(
  onProgress: (percent: number) => void,
  isCancelled: () => boolean,
  targetMs: number,
): FakeProgress {
  const startedAt = Date.now();
  // Time spent paused doesn't count toward elapsed — otherwise resuming
  // after, say, a slow answer to a confirm question would jump the number
  // ahead to "catch up" to real elapsed time, which is exactly the jump
  // this is meant to avoid.
  let pausedMs = 0;
  let pauseStartedAt: number | undefined;
  let percent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function tick() {
    if (stopped || pauseStartedAt !== undefined || isCancelled()) return;
    const elapsed = Date.now() - startedAt - pausedMs;
    // Small jitter so it doesn't read as a perfectly straight line, but
    // never lets it fall behind its own previous value.
    const paced = (elapsed / targetMs) * 100 + (Math.random() * 4 - 2);
    percent = Math.max(percent, Math.min(99, Math.round(paced)));
    onProgress(percent);
    timer = setTimeout(tick, 250 + Math.random() * 250);
  }
  tick();

  function pause() {
    if (stopped || pauseStartedAt !== undefined) return;
    pauseStartedAt = Date.now();
    if (timer) clearTimeout(timer);
  }

  function resume() {
    if (stopped || pauseStartedAt === undefined) return;
    pausedMs += Date.now() - pauseStartedAt;
    pauseStartedAt = undefined;
    tick();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  }

  function finish(): Promise<void> {
    stop();
    return new Promise((resolve) => {
      function burst() {
        if (isCancelled()) {
          resolve();
          return;
        }
        percent = Math.min(100, percent + Math.max(2, Math.round((100 - percent) * 0.35)));
        onProgress(percent);
        if (percent >= 100) {
          resolve();
          return;
        }
        setTimeout(burst, 40 + Math.random() * 40);
      }
      burst();
    });
  }

  return { pause, resume, stop, finish };
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Text>
      <Text color={muted}>{label.padEnd(14)}</Text>
      {value}
    </Text>
  );
}

export function Header({ stackUrl }: { stackUrl: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text>🦕 @grafana/cloud-setup</Text>
        <Text color={muted}> {PACKAGE_VERSION}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Field label="Folder" value={formatFolder(process.cwd())} />
        <Field label="Detected" value={detectFramework(process.cwd())} />
        <Field label="Stack" value={formatStackUrl(stackUrl)} />
      </Box>
    </Box>
  );
}
