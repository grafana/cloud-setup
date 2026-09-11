import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { Box, Text } from "ink";
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
        <Field label="Stack" value={stackUrl} />
      </Box>
    </Box>
  );
}
