import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function readJson(filePath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

interface JsFrameworkSignature {
  name: string;
  deps: string[];
  configFiles?: string[];
}

// Meta-frameworks first — a Next.js app also depends on `react`, so it must
// be checked before the plain "React" entry, or it'd be reported as that
// instead. Config files are a fallback for setups that don't declare the
// dep directly (installed globally, pulled in transitively, etc.).
const JS_FRAMEWORKS: JsFrameworkSignature[] = [
  { name: "Next.js", deps: ["next"], configFiles: ["next.config.js", "next.config.mjs", "next.config.ts"] },
  { name: "Nuxt", deps: ["nuxt", "nuxt3"], configFiles: ["nuxt.config.js", "nuxt.config.ts"] },
  {
    name: "Remix",
    deps: ["@remix-run/react", "@remix-run/node", "@remix-run/dev"],
    configFiles: ["remix.config.js"],
  },
  { name: "Gatsby", deps: ["gatsby"], configFiles: ["gatsby-config.js", "gatsby-config.ts"] },
  { name: "Astro", deps: ["astro"], configFiles: ["astro.config.mjs", "astro.config.ts"] },
  { name: "SvelteKit", deps: ["@sveltejs/kit"], configFiles: ["svelte.config.js"] },
  { name: "Angular", deps: ["@angular/core"], configFiles: ["angular.json"] },
  { name: "NestJS", deps: ["@nestjs/core"] },
  { name: "Vue", deps: ["vue"] },
  { name: "Svelte", deps: ["svelte"] },
  { name: "Solid", deps: ["solid-js"] },
  { name: "Preact", deps: ["preact"] },
  { name: "React Native", deps: ["react-native"] },
  { name: "Express", deps: ["express"] },
  { name: "Fastify", deps: ["fastify"] },
  { name: "React", deps: ["react"] },
];

function detectJs(cwd: string): string | undefined {
  const pkg = readJson(path.join(cwd, "package.json"));
  if (!pkg) return undefined;
  const deps = { ...(pkg.dependencies as Record<string, string>), ...(pkg.devDependencies as Record<string, string>) };

  for (const fw of JS_FRAMEWORKS) {
    const matchesDep = fw.deps.some((d) => deps[d] !== undefined);
    const matchesConfigFile = fw.configFiles?.some((f) => existsSync(path.join(cwd, f))) ?? false;
    if (matchesDep || matchesConfigFile) return `${fw.name} project`;
  }
  return "Node.js project";
}

function detectPython(cwd: string): string | undefined {
  const pyproject = readText(path.join(cwd, "pyproject.toml"));
  const requirements = readText(path.join(cwd, "requirements.txt"));
  const hasPipfile = existsSync(path.join(cwd, "Pipfile"));
  if (pyproject === undefined && requirements === undefined && !hasPipfile) return undefined;

  const combined = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
  if (existsSync(path.join(cwd, "manage.py")) || combined.includes("django")) return "Django project";
  if (combined.includes("fastapi")) return "FastAPI project";
  if (combined.includes("flask")) return "Flask project";
  return "Python project";
}

function detectGo(cwd: string): string | undefined {
  return existsSync(path.join(cwd, "go.mod")) ? "Go project" : undefined;
}

function detectRuby(cwd: string): string | undefined {
  const gemfile = readText(path.join(cwd, "Gemfile"));
  if (gemfile === undefined) return undefined;
  if (gemfile.toLowerCase().includes("rails") || existsSync(path.join(cwd, "config", "application.rb"))) {
    return "Rails project";
  }
  return "Ruby project";
}

// Static, zero-dependency detection across a project directory's manifest
// files. Scoped to JS/TS, Python, Go, and Ruby for now; each ecosystem gets
// its own detector since the manifest format (and what "framework" even
// means) differs per language. JS goes first since it's the one this tool
// cares about most precisely.
export function detectFramework(cwd: string): string {
  return detectJs(cwd) ?? detectPython(cwd) ?? detectGo(cwd) ?? detectRuby(cwd) ?? "Unknown project";
}
