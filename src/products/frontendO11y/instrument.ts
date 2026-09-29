import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { updateFaroSnippet } from "./snippet.js";

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

// Opens the Frontend Observability "create a new app" page directly —
// used when no existing app matches this project, since this tool can't
// create one itself (see FaroClient.findExisting's doc comment).
export function openFrontendO11ySetupPage(stackUrl: string): void {
  openBrowser(`${stackUrl.replace(/\/$/, "")}/a/grafana-kowalski-app/apps/new`);
}

// Decoupled from FaroClient's FaroApp shape on purpose — `collectorUrl` is
// the exact `url:` value the snippet needs (collectEndpointURL + "/" +
// appKey already combined), whether it came from listing an existing app
// via the API or from the user pasting it after creating one manually.
// version/environmentExpr/sessionPersistent come from the "Configure"
// step — see readPkgVersion, detectEnvironmentExpr, and the sessionTracking
// block below. Verified against Grafana's own faro-setup Claude Code
// skill (github.com/grafana/faro-web-sdk ai/grafana-cloud/faro-setup),
// which generates exactly this shape rather than the hardcoded
// version:'1.0.0'/environment:'production' this tool used before.
export interface FaroInstrumentation {
  name: string;
  collectorUrl: string;
  version: string;
  // A raw JS expression, not a string literal — e.g. `process.env.NODE_ENV`
  // — so the environment resolves correctly at the app's own runtime
  // rather than being baked in as a fixed guess at setup time.
  environmentExpr: string;
  sessionPersistent: boolean;
  // Opt-in only (--session-replay, or the interactive prompt): Session
  // Replay is still a beta add-on that Grafana has to manually enable
  // per-stack (a form submission, no API), so wiring it in by default
  // would often silently record nothing — see grafana.com/docs/.../session-replay/.
  sessionReplay: boolean;
  // Only meaningful when sessionReplay is true — which privacy-masking
  // preset the generated ReplayInstrumentation() call uses.
  replayMasking: ReplayMasking;
  // Fraction of sessions tracked, (0, 1]. 1 (100%) matches the SDK's own
  // default, so it's only ever emitted into the snippet when lower.
  samplingRate: number;
}

// The three presets Grafana's Session Replay setup wizard offers — Strict
// blocks all media and relies on blocking rather than masking, Balanced
// masks text content, Open only masks password/email inputs by default.
export type ReplayMasking = "strict" | "balanced" | "open";

const REPLAY_MASKING_OPTIONS: Record<ReplayMasking, string[]> = {
  strict: [
    "blockSelector: '.grafana-block, img, picture, svg, video, audio, canvas, iframe, object, embed',",
    "ignoreSelector: '.grafana-ignore'",
  ],
  balanced: [
    "maskTextSelector: '.grafana-mask, [contenteditable]',",
    "blockSelector: '.grafana-block',",
    "ignoreSelector: '.grafana-ignore'",
  ],
  open: [
    "maskAllInputs: false,",
    "maskInputOptions: {",
    "  password: true,",
    "  email: true",
    "},",
    "maskTextSelector: '.grafana-mask',",
    "blockSelector: '.grafana-block',",
    "ignoreSelector: '.grafana-ignore'",
  ],
};

// Shared by the vanilla, React, and Next.js snippet generators — `indent`
// is whatever column the `new ReplayInstrumentation(...)` call itself sits
// at in that generator's instrumentations array, since it differs per
// framework's snippet shape.
export function replayInstrumentationLines(masking: ReplayMasking, indent: string): string[] {
  return [
    `${indent}new ReplayInstrumentation({`,
    ...REPLAY_MASKING_OPTIONS[masking].map((line) => `${indent}  ${line}`),
    `${indent}}),`,
  ];
}

// Also shared across the three generators. `indent` is the column the
// surrounding `app: {...}` / `instrumentations: [...]` keys sit at.
export function sessionTrackingLines(instrumentation: FaroInstrumentation, indent: string): string[] {
  const fields: string[] = [];
  if (instrumentation.sessionPersistent) fields.push(`${indent}  persistent: true,`);
  if (instrumentation.samplingRate !== 1) fields.push(`${indent}  samplingRate: ${instrumentation.samplingRate},`);
  if (fields.length === 0) return [];
  return [`${indent}sessionTracking: {`, ...fields, `${indent}},`];
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
  { kind: "javascript"; file: string } | { kind: "react"; file: string } | { kind: "nextjs" } | { kind: "unsupported" };

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

// Faro's own faro-setup skill reads this from package.json rather than
// asking or hardcoding "1.0.0" — falls back to that only when there's
// truly nothing to read.
export function readPkgVersion(cwd: string): string {
  const version = readPkg(cwd)?.version;
  return typeof version === "string" && version.length > 0 ? version : "1.0.0";
}

// A raw JS expression (not a string), matching Grafana's own faro-setup
// skill's per-framework choice: React always reads process.env.NODE_ENV
// (regardless of bundler); Next.js has it natively too. The generic
// "javascript" bucket covers Vite and other bundlers alike, so it
// nullish-coalesces both env styles rather than guessing one.
export function detectEnvironmentExpr(target: FrontendTarget): string {
  return target.kind === "javascript" ? "process.env.NODE_ENV ?? import.meta.env.MODE" : "process.env.NODE_ENV";
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

// Matches the documented vanilla-JS/TS snippet's shape (verified against
// the Frontend Observability setup page), with version/environment/session
// fields sourced the way Grafana's own faro-setup skill does rather than
// guessed — see FaroInstrumentation's doc comment.
function webSdkSnippet(instrumentation: FaroInstrumentation): string {
  return [
    "import { getWebInstrumentations, initializeFaro } from '@grafana/faro-web-sdk';",
    "import { TracingInstrumentation } from '@grafana/faro-web-tracing';",
    ...(instrumentation.sessionReplay
      ? ["import { ReplayInstrumentation } from '@grafana/faro-instrumentation-replay';"]
      : []),
    "",
    "initializeFaro({",
    `  url: ${JSON.stringify(instrumentation.collectorUrl)},`,
    "  app: {",
    `    name: ${JSON.stringify(instrumentation.name)},`,
    `    version: ${JSON.stringify(instrumentation.version)},`,
    `    environment: ${instrumentation.environmentExpr},`,
    "  },",
    ...sessionTrackingLines(instrumentation, "  "),
    "  instrumentations: [",
    "    // Mandatory, omits default instrumentations otherwise.",
    "    ...getWebInstrumentations(),",
    "    // Tracing package to get end-to-end visibility for HTTP requests.",
    "    new TracingInstrumentation(),",
    ...(instrumentation.sessionReplay
      ? [
          "    // Public preview: requires Session Replay enabled on this stack, or it's a no-op.",
          ...replayInstrumentationLines(instrumentation.replayMasking, "    "),
        ]
      : []),
    "  ],",
    "});",
    "",
  ].join("\n");
}

// Prepend on first setup, then update the initialization in place so later
// runs preserve application code around it. React shares the same updater
// with a different SDK package and optional router wrapping.
export function insertFaroSnippet(cwd: string, target: FrontendTarget, instrumentation: FaroInstrumentation): boolean {
  if (target.kind !== "javascript") return false;
  const full = path.join(cwd, target.file);
  const existing = existsSync(full) ? readFileSync(full, "utf8") : "";
  const next = updateFaroSnippet(existing, webSdkSnippet(instrumentation), target.file);
  if (next === existing) return false;
  writeFileSync(full, next, "utf8");
  return true;
}

// Different projects need different packages — verified per framework
// against grafana.com/docs/.../get-started/ (React's @grafana/faro-react
// is its own package, not web-sdk + web-tracing).
export const JAVASCRIPT_FARO_PACKAGES = ["@grafana/faro-web-sdk", "@grafana/faro-web-tracing"];
// faro-web-tracing is a separate package from faro-react itself — needed
// here too now that TracingInstrumentation is wired in by default.
export const REACT_FARO_PACKAGES = ["@grafana/faro-react", "@grafana/faro-web-tracing"];
// Its own package regardless of framework — verified against
// grafana.com/docs/.../session-replay/instrument/.
export const REPLAY_FARO_PACKAGE = "@grafana/faro-instrumentation-replay";

function detectPackageManager(cwd: string): "npm" | "yarn" | "pnpm" {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

export async function installFaroPackages(cwd: string, packages: string[]): Promise<void> {
  const pm = detectPackageManager(cwd);
  // npm only: verified live that @grafana/faro-react's peerOptional
  // react-router range (e.g. ^7||^8) can sit ahead of whatever react-router
  // major an app actually has installed (v6 is still extremely common) —
  // npm's strict ERESOLVE then blocks an install that works fine in
  // practice. --legacy-peer-deps only skips that check, it doesn't change
  // what gets installed. yarn classic already treats peer conflicts as
  // warnings, and pnpm doesn't hard-fail on them either, so neither needs
  // an equivalent flag.
  const args =
    pm === "yarn"
      ? ["add", ...packages]
      : pm === "npm"
        ? ["install", "--legacy-peer-deps", ...packages]
        : ["install", ...packages];
  await execFileAsync(pm, args, { cwd, timeout: 120000 });
}
