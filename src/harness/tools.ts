import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "./a2a.js";

// Generous on purpose: fileToolsWithWrite callers (e.g. nextjsInstrument.ts)
// read a file, then write back the *whole* thing with a small addition —
// truncating here would make the agent faithfully write back a truncated
// file, silently deleting everything past this limit. 20_000 was fine for
// pure exploration but actively dangerous once write-back entered the
// picture.
const MAX_FILE_BYTES = 500_000;
const MAX_GREP_MATCHES = 50;
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo"]);

// The agent only ever proposes a path it made up itself, but that output is
// untrusted — every tool here stays inside cwd regardless of what's asked
// for (no absolute paths, no ../ escapes).
function resolveSafe(cwd: string, relPath: string): string {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path "${relPath}" escapes the project directory`);
  }
  return resolved;
}

// Arguments are model-supplied, so a field can be any JSON shape: String({})
// would yield "[object Object]" and reach resolveSafe as if it were a path.
function stringArg(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = input[key];
  if (typeof value === "string") return value;
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`"${key}" is required and must be a string`);
  }
  throw new Error(`"${key}" must be a string, got ${typeof value}`);
}

function listDir(cwd: string, input: Record<string, unknown>): string {
  const full = resolveSafe(cwd, stringArg(input, "path", "."));
  const entries = readdirSync(full).map((name) => (statSync(path.join(full, name)).isDirectory() ? `${name}/` : name));
  // An empty string result is indistinguishable from "no answer yet" to the
  // remote Assistant, which then re-issues the same list_dir call forever
  // instead of treating the directory as confirmed-empty (see grep's
  // "(no matches)" fallback below for the same pattern).
  return entries.length > 0 ? entries.join("\n") : "(empty directory)";
}

function readFile(cwd: string, input: Record<string, unknown>): string {
  const full = resolveSafe(cwd, stringArg(input, "path"));
  const content = readFileSync(full, "utf8");
  return content.length > MAX_FILE_BYTES ? `${content.slice(0, MAX_FILE_BYTES)}\n...(truncated)` : content;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || IGNORED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

function grep(cwd: string, input: Record<string, unknown>): string {
  const pattern = stringArg(input, "pattern", "");
  if (!pattern) throw new Error("grep requires a non-empty pattern");
  const regex = new RegExp(pattern);

  const root = resolveSafe(cwd, stringArg(input, "path", "."));
  const files: string[] = [];
  walk(root, files);

  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= MAX_GREP_MATCHES) break;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
      if (regex.test(lines[i]!)) {
        matches.push(`${path.relative(cwd, file)}:${i + 1}: ${lines[i]!.trim()}`);
      }
    }
  }
  return matches.length > 0 ? matches.join("\n") : "(no matches)";
}

function writeFile(cwd: string, input: Record<string, unknown>): string {
  const full = resolveSafe(cwd, stringArg(input, "path"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, stringArg(input, "content", ""), "utf8");
  return `Wrote ${path.relative(cwd, full)}`;
}

// Generic, product-agnostic local filesystem tools for a coding-agent
// harness — no Synthetic Monitoring (or any other product) knowledge here.
// A consumer registers whichever of these it needs alongside its own,
// product-specific tools.
export function fileTools(cwd: string): AgentTool[] {
  return [
    {
      name: "list_dir",
      description: "List files and directories at a path relative to the project root. Use '.' for the root.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: (input) => listDir(cwd, input),
    },
    {
      name: "read_file",
      description: "Read the contents of a file at a path relative to the project root.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: (input) => readFile(cwd, input),
    },
    {
      name: "grep",
      description:
        "Search for a regular expression across text files under a path relative to the project root (default: whole project). Returns matching lines as 'file:line: text'.",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
      execute: (input) => grep(cwd, input),
    },
  ];
}

// fileTools() plus write access — kept as an explicit, separate tool set
// rather than folded into fileTools() so read-only callers (e.g. the SM
// endpoint-proposal agent in products/syntheticMonitoring/authoring.ts)
// never get write access just by being in the same module. Only for tasks
// that genuinely need to edit the project themselves — currently Next.js
// and React instrumentation (see products/frontendO11y/{nextjs,react}.ts),
// which validate the result afterward rather than trusting it blindly.
export function fileToolsWithWrite(cwd: string): AgentTool[] {
  return [
    ...fileTools(cwd),
    {
      name: "write_file",
      description:
        "Write (create or overwrite) a file at a path relative to the project root. When editing an existing file, read_file it first and write back the complete content with only your intended change applied — never partial content.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      execute: (input) => writeFile(cwd, input),
    },
  ];
}
