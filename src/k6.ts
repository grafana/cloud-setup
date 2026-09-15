import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Confirms both that k6 is on PATH *and* that it's recent enough to have
// the `x mcp` subcommand — a plain `k6 version` check isn't enough, since
// an older k6 binary exits 0 for --version but has no `x` command group
// at all.
export function isK6McpSupported(): boolean {
  const result = spawnSync("k6", ["x", "mcp", "--help"], { stdio: "ignore", timeout: 5000 });
  return result.status === 0;
}

export const K6_INSTALL_DOCS_URL = "https://grafana.com/docs/k6/latest/set-up/install-k6/";

// The one command attemptInstallK6 actually runs — exported so the UI can
// show it to the user up front, same as gcx.ts's GCX_INSTALL_COMMAND.
export const K6_INSTALL_COMMAND = "brew install k6";

function hasHomebrew(): boolean {
  const result = spawnSync("brew", ["--version"], { stdio: "ignore", timeout: 5000 });
  return result.status === 0;
}

// Unlike gcx (which has one official curl|sh installer for every
// platform), k6 has no single unattended install method — this only ever
// attempts Homebrew on macOS, since that's the one case with a safe,
// well-known, idempotent single command. Every other platform (Linux,
// Windows, or macOS without Homebrew) returns false without attempting
// anything; the caller falls back to printing K6_INSTALL_DOCS_URL. Never
// throws — a failed install is reported as `false`, same as "did not
// attempt."
export async function attemptInstallK6(): Promise<boolean> {
  if (process.platform !== "darwin" || !hasHomebrew()) return false;
  try {
    await execFileAsync("brew", ["install", "k6"], { timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}
