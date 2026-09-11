import { existsSync, statSync } from "node:fs";
import path from "node:path";

export interface Command {
  name: string;
  usageLine: string;
  summary: string;
  run(rest: string[]): Promise<void>;
}

// Everything downstream (framework detection, skill install, npm install,
// snippet insertion, ...) already just reads process.cwd() rather than
// threading a project-path parameter through every function — chdir once,
// up front, so --folder redirects all of that with no other changes.
// Must run before a command's UI renders anything, since Header
// (ui/shared.tsx) reads process.cwd() too.
export function applyFolder(rawFolder: string | undefined, usage: string): void {
  const folder = path.resolve(rawFolder ?? ".");
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    usageError(`--folder "${rawFolder}" is not a directory.`, usage);
  }
  process.chdir(folder);
}

export function usageError(message: string, usage: string): never {
  console.error([`Error: ${message}`, "", "Usage:", `  ${usage}`].join("\n"));
  process.exit(1);
}
