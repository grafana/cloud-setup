import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileToolsWithWrite, runTask } from "../../harness/index.js";
import { replayInstrumentationLines, sessionTrackingLines, type FaroInstrumentation } from "./instrument.js";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
// React Router's data-router APIs — the one thing about React
// instrumentation genuinely too varied to template (it can live in any
// file, or not exist at all — most apps don't use this API).
const DATA_ROUTER_PATTERN = /\bcreate(?:Browser|Hash|Memory)Router\s*\(/;

// Base shape matches the documented basic-init snippet (verified against
// grafana.com/docs/.../instrument-react/) — @grafana/faro-react's own
// initializeFaro wrapper, not the generic @grafana/faro-web-sdk one used
// for non-React projects. That page's own snippet omits the
// `instrumentations` key entirely and relies on the React package's
// default (it re-exports @grafana/faro-web-sdk's initializeFaro verbatim,
// which defaults to getWebInstrumentations() alone when the key is
// absent) — but TracingInstrumentation (for HTTP request visibility) and,
// when enabled, Session Replay both need to be added explicitly, same as
// the vanilla and Next.js snippets, so the array is always spelled out
// here instead of relying on that default.
function basicInitSnippet(instrumentation: FaroInstrumentation): string {
  return [
    "import { getWebInstrumentations, initializeFaro } from '@grafana/faro-react';",
    "import { TracingInstrumentation } from '@grafana/faro-web-tracing';",
    ...(instrumentation.sessionReplay ? ["import { ReplayInstrumentation } from '@grafana/faro-instrumentation-replay';"] : []),
    "",
    "initializeFaro({",
    `  url: '${instrumentation.collectorUrl}',`,
    "  app: {",
    `    name: '${instrumentation.name}',`,
    `    version: '${instrumentation.version}',`,
    `    environment: ${instrumentation.environmentExpr},`,
    "  },",
    ...sessionTrackingLines(instrumentation, "  "),
    "  instrumentations: [",
    "    // Mandatory, omits default instrumentations otherwise.",
    "    ...getWebInstrumentations(),",
    "    // Tracing package to get end-to-end visibility for HTTP requests.",
    "    new TracingInstrumentation(),",
    ...(instrumentation.sessionReplay
      ? ["    // Beta: requires Session Replay enabled on this stack, or it's a no-op.", ...replayInstrumentationLines(instrumentation.replayMasking, "    ")]
      : []),
    "  ],",
    "});",
    "",
  ].join("\n");
}

// Same first-line-to-closing-`});` anchor as instrument.ts's
// FARO_WEB_SDK_BLOCK — see that constant's comment for why it's safe
// against the snippet's own nested closes.
const FARO_REACT_BLOCK = /import \{ getWebInstrumentations, initializeFaro \} from '@grafana\/faro-react';[\s\S]*?\n\}\);\n/;

// Same re-syncing prepend as instrument.ts's insertFaroSnippet — a later
// run with different answers replaces the previously-inserted block
// instead of leaving it stale. Deterministic, no agent needed, since both
// the content and the target file are fully known ahead of time.
function insertBasicInit(cwd: string, entryFile: string, instrumentation: FaroInstrumentation): void {
  const full = path.join(cwd, entryFile);
  const existing = existsSync(full) ? readFileSync(full, "utf8") : "";
  const match = existing.match(FARO_REACT_BLOCK);
  const rest = (match ? existing.slice(match.index! + match[0].length) : existing).replace(/^\n+/, "");

  const snippet = basicInitSnippet(instrumentation);
  const next = rest ? `${snippet}\n${rest}` : snippet;
  if (next === existing) return;
  writeFileSync(full, next, "utf8");
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
    else if (SOURCE_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
}

// Finds the one file (if any) that creates a React Router data router —
// done ourselves via a plain grep rather than asking the agent to explore
// blindly, so the agent's task (if there's anything to do at all) is
// "edit this exact file" instead of "search the whole project."
function findDataRouterFile(cwd: string): string | undefined {
  const files: string[] = [];
  walk(cwd, files);
  const match = files.find((full) => {
    try {
      return DATA_ROUTER_PATTERN.test(readFileSync(full, "utf8"));
    } catch {
      return false;
    }
  });
  return match ? path.relative(cwd, match) : undefined;
}

// A "linter" gate, not a full compile — syntax only, just enough to catch
// a malformed agent edit before it's trusted.
function hasSyntaxErrors(source: string): boolean {
  const { diagnostics } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest },
    reportDiagnostics: true,
    fileName: "file.tsx",
  });
  return Boolean(diagnostics && diagnostics.length > 0);
}

// A legitimate wrap only ever adds one import and wraps one call — a
// rewrite that comes back much shorter is a sign of content loss, not a
// real edit, even if it still happens to parse.
function looksTruncated(before: string, content: string): boolean {
  return before.length > 200 && content.length < before.length * 0.8;
}

export interface ReactInstrumentResult {
  entryFile: string;
  routerFile?: string;
  detail?: string;
  // Whether instrumentation finished. Explicit, so callers never have to
  // infer it from `detail` being empty — that is a human-readable message.
  complete: boolean;
}

// The entry-file init is always deterministic (see insertBasicInit).
// Router wrapping only runs the Assistant agent at all if a data router
// call was actually found — most React apps don't use this API, and
// there's no reason to spend a task (or risk an edit) on a project that
// has nothing to wrap. The target file is already known by the time the
// agent runs, so its job is narrow: edit this one file, not explore the
// whole project. Validated the same way as every other agent-written
// file in this tool — syntax and shrinkage checked, rolled back to the
// pre-task snapshot if either fires. Never throws.
export async function instrumentReact(cwd: string, stackUrl: string, entryFile: string, instrumentation: FaroInstrumentation): Promise<ReactInstrumentResult> {
  insertBasicInit(cwd, entryFile, instrumentation);

  const routerRel = findDataRouterFile(cwd);
  // Nothing to wrap, so the entry-file init above was the whole job.
  if (!routerRel) return { entryFile, complete: true };

  const routerFull = path.join(cwd, routerRel);
  const before = readFileSync(routerFull, "utf8");

  const task = [
    "I am instrumenting a React app with Grafana Faro (Frontend Observability). This project uses React Router's",
    `data router API. Here is the full current content of ${routerRel}, which creates that router:`,
    "```",
    before,
    "```",
    "Add an import of withFaroRouterInstrumentation from '@grafana/faro-react', and wrap the createBrowserRouter /",
    "createHashRouter / createMemoryRouter call's result with it — the wrapped result should end up assigned to",
    "whatever the code currently exports or uses as its router, so nothing that imports this file needs to change.",
    "Do not change anything else in this file: keep every other import, route definition, and export exactly as it",
    "was, in the same order and formatting. Never truncate or summarize the rest of the file — write back its",
    "complete original content plus only this change.",
    "Use write_file to save your change. This is part of a Grafana Frontend Observability setup workflow.",
    "Once you're done, respond with a short plain-text summary of what you changed.",
  ].join(" ");

  try {
    await runTask(stackUrl, task, fileToolsWithWrite(cwd));
  } catch (err) {
    return { entryFile, detail: err instanceof Error ? err.message : String(err), complete: false };
  }

  const content = existsSync(routerFull) ? readFileSync(routerFull, "utf8") : "";
  const changedThisRun = content !== before;

  // Reports as wrapped whether it was just wrapped this run or was
  // already correctly wrapped from an earlier run — an idempotent re-run
  // shouldn't report a regression just because nothing needed to change.
  if (!content.includes("withFaroRouterInstrumentation")) {
    return { entryFile, detail: "the agent did not instrument the data router", complete: false };
  }
  if (changedThisRun && (hasSyntaxErrors(content) || looksTruncated(before, content))) {
    writeFileSync(routerFull, before, "utf8");
    return { entryFile, detail: "the agent's router-wrapping edit didn't look right and was rolled back", complete: false };
  }

  return { entryFile, routerFile: routerRel, complete: true };
}
