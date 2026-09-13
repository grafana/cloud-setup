import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { detectFramework } from "../framework.js";

export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 6;

// Every automatic spinner/loading-bar phase stays visible at least this
// long, even when the real work behind it finishes faster.
export const MIN_SPINNER_MS = 3000;

export const NO_COLOR = Boolean(process.env.NO_COLOR);
export const accent = NO_COLOR ? undefined : "#FFA500";
export const ok = NO_COLOR ? undefined : "green";
export const bad = NO_COLOR ? undefined : "red";
// The target URL is effectively the session's main identifier — called
// out in its own color wherever it's mentioned, rather than relying on
// bold or <angle brackets> to make it stand out.
export const idColor = NO_COLOR ? undefined : "#C792EA";
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
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    throw new Error(`Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ is required (found ${process.versions.node}).`);
  }
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
export function useHardExit(): (errorOrMessage?: Error | string) => void {
  const { exit } = useApp();

  function hardExit(errorOrMessage?: Error | string): void {
    const error = errorOrMessage instanceof Error ? errorOrMessage : undefined;
    // exit() first, while Ink still owns the terminal — it restores the
    // cursor and raw mode; printing before that would just get clobbered
    // by Ink's own rendering.
    exit(error);
    if (typeof errorOrMessage === "string") console.log(errorOrMessage);
    // setImmediate, not a same-tick process.exit() — Ink's own unmount
    // cleanup and the console.log above both write to the terminal, and
    // need a turn of the event loop to actually flush before the process
    // dies, or they can get silently dropped.
    setImmediate(() => process.exit(error ? 1 : 0));
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
        <Text bold>🦕 @grafana/setup-cli</Text>
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
