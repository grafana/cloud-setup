import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Minimal ANSI styling for the CLI's own console output (--help, usage
// errors) — deliberately plain, like gh's or k6's own help text. Color is
// reserved for the one thing worth calling out: an actual error.
const NO_COLOR = Boolean(process.env.NO_COLOR);

export function bad(text: string): string {
  return NO_COLOR ? text : `\x1b[31m${text}\x1b[0m`;
}

// Read from package.json rather than hardcoded, so the two can't drift.
function readPackageVersion(): string {
  try {
    const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
export const PACKAGE_VERSION = readPackageVersion();

// The one title line every help/error screen opens with — same 🦕 mark as
// the interactive wizard's own Header (ui/shared.tsx), so the plain-text
// CLI output and the Ink UI read as the same tool. Everything else here
// stays plain on purpose; this is the one deliberate brand touch.
export function titleLine(): string {
  return `🦕 @grafana/cloud-setup ${PACKAGE_VERSION}`;
}
