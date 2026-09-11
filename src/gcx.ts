import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isGcxInstalled(): boolean {
  const result = spawnSync("gcx", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

// The official quick-install method from grafana/gcx's own README: downloads
// the latest release, verifies its SHA-256 checksum, installs to
// ~/.local/bin. Fixed, non-interpolated command — safe to run via `sh -c`.
export const GCX_INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/grafana/gcx/main/scripts/install.sh | sh";

export async function installGcx(): Promise<void> {
  await execFileAsync("sh", ["-c", GCX_INSTALL_COMMAND], { timeout: 60000 });
}
