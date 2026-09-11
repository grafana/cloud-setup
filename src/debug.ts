import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Global, process-lifetime state set once from --debug in cli.ts. A module
// singleton (rather than threading a flag through every function call) is
// the right tradeoff here — this is diagnostic output for a one-shot CLI
// run, not application state.
let debugFile: string | undefined;

// Returns the log file's path (so the caller can print it once, before the
// Ink UI takes over stdout) or undefined if debug logging is off. A fresh
// file per run — writing to stdout/stderr instead would interleave with
// Ink's own re-renders and corrupt the terminal (same issue noted in
// gcx.ts for a different reason), so this never touches either stream.
export function setDebugEnabled(value: boolean): string | undefined {
  debugFile = value ? path.join(os.tmpdir(), `synthetics-debug-${Date.now()}.log`) : undefined;
  return debugFile;
}

export function debugLog(label: string, data: unknown): void {
  if (!debugFile) return;
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  appendFileSync(debugFile, `\n--- [debug] ${label} ---\n${text}\n`);
}
