import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { bad, titleLine } from "../cliStyle.js";
import { ICONS } from "../theme.js";

export interface CommandFlag {
  flag: string;
  description: string;
}

export interface Command {
  name: string;
  usageLine: string; // full usage, every optional flag in [...] — shown in `<command> --help`
  shortUsageLine: string; // minimum invocation, shown alongside a usage error
  example: string[]; // a realistic invocation, one line per array entry
  summary: string; // one-line summary shown in the global help's Commands list
  flags: CommandFlag[]; // shown in `<command> --help`
  run(rest: string[]): Promise<void>;
}

export function parseCommandOptions(
  rest: string[],
  command: Command,
): {
  strings: Record<string, string | undefined>;
  booleans: Set<string>;
} {
  const options: Record<string, { type: "string" | "boolean" }> = Object.fromEntries(
    command.flags.map(({ flag }) => [
      flag.split(" ")[0]!.slice(2),
      { type: flag.includes(" <") ? "string" : "boolean" },
    ]),
  );
  // A URL flag without a value is equivalent to omitting it: the wizard
  // will ask. Never consume the following flag as if it were a URL.
  const args = rest.map((arg, i) =>
    options[arg.slice(2)]?.type === "string" &&
    (arg === "--url" || arg === "--stack") &&
    (rest[i + 1] === undefined || rest[i + 1]!.startsWith("-"))
      ? `${arg}=`
      : arg,
  );
  try {
    const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
    const strings: Record<string, string | undefined> = {};
    const booleans = new Set<string>();
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string") strings[key] = value;
      else if (value) booleans.add(key);
    }
    return { strings, booleans };
  } catch (err) {
    printCliError(command, err instanceof Error ? err.message : String(err));
  }
}

// The one error screen for any usage problem (an unknown flag, an
// invalid --folder, ...) — always points at the short/required usage and
// a realistic example rather than the full flag list, which lives in
// `<command> --help` instead.
export function printCliError(command: Command, message: string): never {
  console.error(
    [
      titleLine(),
      "",
      bad(`${ICONS.FAIL} ${message}`),
      "",
      "USAGE",
      `  ${command.shortUsageLine}`,
      "",
      "EXAMPLE",
      ...command.example.map((line) => `  ${line}`),
      "",
      `Run npx @grafana/cloud-setup ${command.name} --help for all options.`,
    ].join("\n"),
  );
  process.exit(1);
}

// Everything downstream (framework detection, skill install, npm install,
// snippet insertion, ...) already just reads process.cwd() rather than
// threading a project-path parameter through every function — chdir once,
// up front, so --folder redirects all of that with no other changes.
// Must run before a command's UI renders anything, since Header
// (ui/shared.tsx) reads process.cwd() too.
export function applyFolder(rawFolder: string | undefined, command: Command): void {
  const folder = path.resolve(rawFolder ?? ".");
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    printCliError(command, `--folder "${rawFolder}" is not a directory.`);
  }
  process.chdir(folder);
}

// `<command> --help`/`-h` — the full flag reference, pointed to by
// printCliError's hint line.
export function printCommandHelp(command: Command): void {
  const flagWidth = Math.max(...command.flags.map((f) => f.flag.length));
  console.log(
    [
      titleLine(),
      "",
      "USAGE",
      `  ${command.usageLine}`,
      "",
      "EXAMPLE",
      ...command.example.map((line) => `  ${line}`),
      "",
      "FLAGS",
      ...command.flags.map((f) => `  ${f.flag.padEnd(flagWidth)}    ${f.description}`),
    ].join("\n"),
  );
}
