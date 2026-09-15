import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileToolsWithWrite, runTask } from "../../harness/index.js";
import type { FaroInstrumentation } from "./instrument.js";

// Root layout candidates (App Router and Pages Router, with or without
// src/) — existing ones get snapshotted before the agent runs, so a
// broken edit can be rolled back rather than left half-wired.
const LAYOUT_CANDIDATES = [
  "src/app/layout.tsx",
  "src/app/layout.js",
  "app/layout.tsx",
  "app/layout.js",
  "src/pages/_app.tsx",
  "src/pages/_app.js",
  "pages/_app.tsx",
  "pages/_app.js",
];

// Where the agent is told to put the new component — checked afterward
// since the agent (not us) decides which one actually applies (tsx vs
// jsx, with or without src/). Also snapshotted up front: if one of these
// paths already holds something unrelated (no Faro marker), that's a
// genuine name collision, not a re-run — never clobbered.
const COMPONENT_CANDIDATES = [
  "src/components/frontend-observability.tsx",
  "src/components/frontend-observability.jsx",
  "components/frontend-observability.tsx",
  "components/frontend-observability.jsx",
];

// A legitimate edit (one import + one rendered element) only ever grows a
// file. A rewrite that comes back much shorter than the original is a
// sign of a truncated read_file result being faithfully written back
// (see harness/tools.ts's MAX_FILE_BYTES) or some other content loss —
// treated as broken even if it still happens to parse.
const MIN_RETAINED_FRACTION = 0.8;

// Base shape matches the documented Next.js snippet (verified against
// grafana.com/docs/.../instrument-nextjs/) — a client component guarded
// against double-init, unlike the plain React quickstart's bare
// initializeFaro() call, since Next.js can mount the tree more than once.
// version/environment/session fields sourced the way Grafana's own
// faro-setup skill does — see FaroInstrumentation's doc comment.
function componentSource(instrumentation: FaroInstrumentation): string {
  return [
    "'use client';",
    "",
    "import { faro, getWebInstrumentations, initializeFaro } from '@grafana/faro-web-sdk';",
    "import { TracingInstrumentation } from '@grafana/faro-web-tracing';",
    ...(instrumentation.sessionReplay ? ["import { ReplayInstrumentation } from '@grafana/faro-instrumentation-replay';"] : []),
    "",
    "export default function FrontendObservability() {",
    "  if (faro.api) {",
    "    return null;",
    "  }",
    "",
    "  try {",
    "    initializeFaro({",
    `      url: '${instrumentation.collectorUrl}',`,
    "      app: {",
    `        name: '${instrumentation.name}',`,
    `        version: '${instrumentation.version}',`,
    `        environment: ${instrumentation.environmentExpr},`,
    "      },",
    ...(instrumentation.sessionPersistent ? ["      sessionTracking: {", "        persistent: true,", "      },"] : []),
    "      instrumentations: [",
    "        ...getWebInstrumentations(),",
    "        new TracingInstrumentation(),",
    ...(instrumentation.sessionReplay
      ? ["        // Beta: requires Session Replay enabled on this stack, or it's a no-op.", "        new ReplayInstrumentation(),"]
      : []),
    "      ],",
    "    });",
    "  } catch {",
    "    return null;",
    "  }",
    "  return null;",
    "}",
    "",
  ].join("\n");
}

// A "linter" gate, not a full compile — syntax only (no type info
// needed), just enough to catch a malformed agent edit before it's
// trusted. TypeScript's own parser handles .js/.jsx/.ts/.tsx uniformly
// when told to treat everything as TSX (the permissive superset).
function hasSyntaxErrors(source: string): boolean {
  const { diagnostics } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest },
    reportDiagnostics: true,
    fileName: "file.tsx",
  });
  return Boolean(diagnostics && diagnostics.length > 0);
}

// True if `content` looks like a suspicious shrinkage of `before` — see
// MIN_RETAINED_FRACTION.
function looksTruncated(before: string, content: string): boolean {
  return before.length > 200 && content.length < before.length * MIN_RETAINED_FRACTION;
}

function snapshotAll(cwd: string, candidates: string[]): Map<string, string> {
  const snapshots = new Map<string, string>();
  for (const rel of candidates) {
    const full = path.join(cwd, rel);
    if (existsSync(full)) snapshots.set(rel, readFileSync(full, "utf8"));
  }
  return snapshots;
}

// Restores a pre-existing file to its snapshot, or removes it if the
// agent created it from scratch (nothing to restore to) — never leaves
// broken or truncated content behind.
function revert(full: string, before: string | undefined): void {
  if (before !== undefined) writeFileSync(full, before, "utf8");
  else rmSync(full);
}

export interface NextjsInstrumentResult {
  componentFile?: string;
  layoutFile?: string;
  detail?: string;
}

// Lets the Assistant agent own the whole thing — both the new component
// file and wiring it into whichever root layout this project actually
// has (App Router vs Pages Router, src/ or not, whatever else is already
// rendered there) — rather than this tool trying to template or pattern-
// match an existing layout's JSX itself. Real files only get trusted
// after the fact, and the component's content is never trusted at all:
// it's fixed and known ahead of time, so it's force-synced to the exact
// expected output afterward regardless of what the agent actually wrote
// (this also means a later run with a different Faro app/collector URL
// correctly updates it, rather than silently staying stale). Any layout
// the agent touched is re-checked for syntax errors and unexpected
// shrinkage and rolled back if either fires; only one layout is ever left
// wired even if the project has both an App Router and Pages Router
// layout and the agent wired more than one. Never throws — a failure
// just means less of the wiring happened, reported via the result, same
// as every other nice-to-have in this tool.
export async function instrumentNextjs(cwd: string, stackUrl: string, instrumentation: FaroInstrumentation): Promise<NextjsInstrumentResult> {
  const layoutSnapshots = snapshotAll(cwd, LAYOUT_CANDIDATES);
  const componentSnapshots = snapshotAll(cwd, COMPONENT_CANDIDATES);

  const task = [
    "I am instrumenting a Next.js app with Grafana Faro (Frontend Observability). Use your tools to explore this",
    "project first — check whether it keeps source under src/, and whether it uses the App Router (app/) or Pages",
    "Router (pages/).",
    "Step 1: create a new client component containing EXACTLY this content, verbatim, with no changes — save it as",
    "components/frontend-observability.tsx (or src/components/... if source lives under src/; use .jsx instead of",
    ".tsx only if the project has no tsconfig.json):",
    "```",
    componentSource(instrumentation),
    "```",
    "Step 2: find this project's root layout — app/layout.tsx for the App Router (checking the src/ variant too),",
    "or pages/_app.tsx for the Pages Router (checking the src/ variant too). If it's the App Router, that file",
    "always exists already; read its current content and write back the SAME content with two additions: an import",
    "of the component's default export (name it FrontendObservability) and <FrontendObservability /> rendered once",
    "as an actual element inside the returned JSX — inside <body> if there is one, otherwise as the first child of",
    "whatever the top-level returned element is. Do not change anything else in that file: every other import, prop,",
    "and child must stay exactly as it was, in the same order and formatting. Never truncate or summarize the rest",
    "of the file — write back its complete original content plus only these two additions.",
    "If it's the Pages Router and pages/_app.tsx (or src/pages/_app.tsx) does not exist yet, create one that",
    "preserves Next.js's default behavior exactly — it must render <Component {...pageProps} /> as well as",
    "<FrontendObservability />, using the project's actual AppProps type import (or plain JS if there's no",
    "tsconfig.json). Only do this for whichever router the project actually uses — do not create or touch files",
    "for the router type it doesn't use.",
    "Use write_file for both steps. This is part of a Grafana Frontend Observability setup workflow.",
    "Once you're done, respond with a short plain-text summary of exactly which file paths you created or modified.",
  ].join(" ");

  try {
    await runTask(stackUrl, task, fileToolsWithWrite(cwd));
  } catch (err) {
    return { detail: err instanceof Error ? err.message : String(err) };
  }

  // The component's content is fixed and known ahead of time — never
  // trust the agent's transcription of it. Whichever candidate path it
  // (or an earlier run) put it at, force it to the exact expected output,
  // unless that path already held something unrelated before this ran
  // (a real name collision, not a re-run).
  let componentFile: string | undefined;
  const expectedComponent = componentSource(instrumentation);
  for (const rel of COMPONENT_CANDIDATES) {
    const full = path.join(cwd, rel);
    if (!existsSync(full)) continue;

    const before = componentSnapshots.get(rel);
    if (before !== undefined && !before.includes("@grafana/faro-web-sdk")) {
      // Pre-existed with unrelated content — never touch it.
      continue;
    }
    if (before !== expectedComponent) writeFileSync(full, expectedComponent, "utf8");
    componentFile = rel;
    break;
  }

  if (!componentFile) {
    // Either the agent never created it, or the only candidate path
    // collided with an unrelated pre-existing file.
    const collided = COMPONENT_CANDIDATES.some((rel) => {
      const before = componentSnapshots.get(rel);
      return before !== undefined && !before.includes("@grafana/faro-web-sdk") && existsSync(path.join(cwd, rel));
    });
    return { detail: collided ? "a file already exists at the expected component path for something else" : undefined };
  }

  // Remove any OTHER component candidate the agent may have also created
  // (e.g. guessed both tsx and jsx) so there's only ever one.
  for (const rel of COMPONENT_CANDIDATES) {
    if (rel === componentFile) continue;
    const full = path.join(cwd, rel);
    if (existsSync(full) && componentSnapshots.get(rel) === undefined) rmSync(full);
  }

  let layoutFile: string | undefined;
  for (const rel of LAYOUT_CANDIDATES) {
    const full = path.join(cwd, rel);
    if (!existsSync(full)) continue;
    const content = readFileSync(full, "utf8");
    const before = layoutSnapshots.get(rel);
    const changedThisRun = content !== before;

    if (!content.includes("FrontendObservability")) continue;

    const broken = changedThisRun && (hasSyntaxErrors(content) || (before !== undefined && looksTruncated(before, content)));
    if (broken) {
      revert(full, before);
      continue;
    }

    if (layoutFile === undefined) {
      layoutFile = rel;
    } else if (changedThisRun) {
      // Already have a valid layout wired (e.g. App Router) — this is a
      // second one the agent also touched (e.g. a leftover Pages Router
      // file in a mid-migration project). Only one should stay wired.
      revert(full, before);
    }
  }

  return { componentFile, layoutFile };
}
