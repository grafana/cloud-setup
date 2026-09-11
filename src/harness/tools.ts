import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "./a2a.js";

const MAX_FILE_BYTES = 20_000;
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

function listDir(cwd: string, input: Record<string, unknown>): string {
  const full = resolveSafe(cwd, String(input.path ?? "."));
  return readdirSync(full)
    .map((name) => (statSync(path.join(full, name)).isDirectory() ? `${name}/` : name))
    .join("\n");
}

function readFile(cwd: string, input: Record<string, unknown>): string {
  const full = resolveSafe(cwd, String(input.path));
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
  const pattern = String(input.pattern ?? "");
  if (!pattern) throw new Error("grep requires a non-empty pattern");
  const regex = new RegExp(pattern);

  const root = resolveSafe(cwd, String(input.path ?? "."));
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
