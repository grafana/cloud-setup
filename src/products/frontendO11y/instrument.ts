import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Same open-a-browser mechanics as harness/auth.ts's OAuth flow — kept
// separate rather than shared since this one just needs the plugin's app
// page, not anything OAuth-specific.
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", '""', url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

// Opens the Frontend Observability app list/creation page on the stack —
// used when no existing app matches this project, since this tool can't
// create one itself (see FaroClient.findExisting's doc comment).
export function openFrontendO11ySetupPage(stackUrl: string): void {
  openBrowser(`${stackUrl.replace(/\/$/, "")}/a/grafana-kowalski-app`);
}

// Decoupled from FaroClient's FaroApp shape on purpose — `collectorUrl` is
// the exact `url:` value the snippet needs (collectEndpointURL + "/" +
// appKey already combined), whether it came from listing an existing app
// via the API or from the user pasting it after creating one manually.
export interface FaroInstrumentation {
  name: string;
  collectorUrl: string;
}

// Four real shapes, verified against grafana.com/docs/.../get-started/:
// - "javascript": any bundler-based JS/TS project that isn't React or
//   Next.js (Vue, Svelte, Angular, plain TS, ...) — @grafana/faro-web-sdk,
//   handled entirely deterministically (a fixed snippet into a findable
//   entry file — Vite's src/main.* convention is shared across nearly all
//   of these, not React-specific despite the similar-looking file name).
// - "react": needs a different package (@grafana/faro-react) *and* a
//   second, genuinely exploratory step — wrapping a react-router data
//   router if the project happens to create one, which can live in any
//   file — see reactInstrument.ts.
// - "nextjs": needs a new component file *and* wiring it into the
//   project's actual root layout — see nextjsInstrument.ts.
// Both of the agent-assisted ones go through the Assistant with a
// syntax-validation gate before anything is trusted; "javascript" never
// needs that since the whole edit is fixed and known ahead of time.
export type FrontendTarget =
  | { kind: "javascript"; file: string }
  | { kind: "react"; file: string }
  | { kind: "nextjs" }
  | { kind: "unsupported" };

function readPkg(cwd: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// The Faro app's display name, e.g. in the Grafana Cloud UI — falls back
// to the folder name (the caller's job) when package.json has none.
export function readPkgName(cwd: string): string | undefined {
  const name = readPkg(cwd)?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function hasDep(pkg: Record<string, unknown> | undefined, name: string): boolean {
  if (!pkg) return false;
  const deps = { ...(pkg.dependencies as Record<string, string>), ...(pkg.devDependencies as Record<string, string>) };
  return deps[name] !== undefined;
}

// Vite's src/main.*/src/index.* convention — shared by React, Vue,
// Svelte, and plain TS/JS templates alike, so this is really a general
// bundler-entry heuristic, not a React-specific one.
const JS_ENTRY_CANDIDATES = [
  "src/main.tsx",
  "src/main.ts",
  "src/main.jsx",
  "src/main.js",
  "src/index.tsx",
  "src/index.ts",
  "src/index.jsx",
  "src/index.js",
];

function findEntryFile(cwd: string): string | undefined {
  return JS_ENTRY_CANDIDATES.find((rel) => existsSync(path.join(cwd, rel)));
}

export function detectFrontendTarget(cwd: string): FrontendTarget {
  const pkg = readPkg(cwd);
  if (!pkg) return { kind: "unsupported" };

  if (hasDep(pkg, "next")) return { kind: "nextjs" };

  const entry = findEntryFile(cwd);
  if (!entry) return { kind: "unsupported" };

  return hasDep(pkg, "react") ? { kind: "react", file: entry } : { kind: "javascript", file: entry };
}

// Matches the documented vanilla-JS/TS snippet exactly (verified against
// the Frontend Observability setup page) — no fields beyond what's
// actually shown there (no invented sampling/session config).
function webSdkSnippet(instrumentation: FaroInstrumentation): string {
  return [
    "import { getWebInstrumentations, initializeFaro } from '@grafana/faro-web-sdk';",
    "import { TracingInstrumentation } from '@grafana/faro-web-tracing';",
    "",
    "initializeFaro({",
    `  url: '${instrumentation.collectorUrl}',`,
    "  app: {",
    `    name: '${instrumentation.name}',`,
    "    version: '1.0.0',",
    "    environment: 'production',",
    "  },",
    "  instrumentations: [",
    "    // Mandatory, omits default instrumentations otherwise.",
    "    ...getWebInstrumentations(),",
    "    // Tracing package to get end-to-end visibility for HTTP requests.",
    "    new TracingInstrumentation(),",
    "  ],",
    "});",
    "",
  ].join("\n");
}

// Prepends the init snippet so it runs before the file's existing code —
// "load as early as possible" only works if it's first. Idempotent: a
// second run leaves an already-instrumented file alone rather than
// duplicating the call. "javascript" only — React goes through
// reactInstrument.ts (different package, plus optional router wrapping),
// Next.js through nextjsInstrument.ts.
export function insertFaroSnippet(cwd: string, target: FrontendTarget, instrumentation: FaroInstrumentation): boolean {
  if (target.kind !== "javascript") return false;
  const full = path.join(cwd, target.file);
  const existing = existsSync(full) ? readFileSync(full, "utf8") : "";
  if (existing.includes("@grafana/faro-web-sdk")) return false;

  const snippet = webSdkSnippet(instrumentation);
  writeFileSync(full, existing ? `${snippet}\n${existing}` : snippet, "utf8");
  return true;
}

// Different projects need different packages — verified per framework
// against grafana.com/docs/.../get-started/ (React's @grafana/faro-react
// is its own package, not web-sdk + web-tracing).
export const JAVASCRIPT_FARO_PACKAGES = ["@grafana/faro-web-sdk", "@grafana/faro-web-tracing"];
export const REACT_FARO_PACKAGES = ["@grafana/faro-react"];

function detectPackageManager(cwd: string): "npm" | "yarn" | "pnpm" {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

export async function installFaroPackages(cwd: string, packages: string[]): Promise<void> {
  const pm = detectPackageManager(cwd);
  const args = pm === "yarn" ? ["add", ...packages] : ["install", ...packages];
  await execFileAsync(pm, args, { cwd, timeout: 120000 });
}
