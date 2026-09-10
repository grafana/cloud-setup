import { execFile, spawn, spawnSync } from "node:child_process";
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

// Fully silent — gcx opens the browser on its own (confirmed: it does, no
// stdio needed for that to work), we just wait for it to finish. --yes skips
// gcx's own optional follow-up prompt ("Also log in to Grafana Cloud for
// Cloud management features?") — we only need the primary instance login for
// gcx assistant, not Cloud resource management.
//
// Earlier version inherited stdio so gcx's own messages (browser-open
// fallback URL, verification code) showed through, but that produced a lot
// of gcx-specific noise (context details, CAP token notices, etc.) that
// doesn't belong in this tool's UI — and before that, inheriting stdio while
// Ink's own spinner kept re-rendering corrupted the terminal (two writers on
// one stdout). If gcx's browser auto-open ever fails silently, the user has
// no fallback URL — accepted tradeoff for a clean, on-brand setup flow.
export async function loginGcx(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gcx", ["login", "--oauth", "--yes"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gcx login exited with code ${code ?? "unknown"}`));
    });
  });
}
