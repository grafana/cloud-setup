#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { SmApiError } from "./api.js";
import { readCredentials } from "./credentials.js";
import { setDebugEnabled } from "./debug.js";
import { runFrontendUI } from "./ui/FrontendApp.js";
import { runSetupUI } from "./ui/SetupApp.js";

const SETUP_USAGE_LINE =
  "npx @grafana/setup-cli synthetics --url <target-url> --stack <stack-url> [--folder <path>] [--base-url <url>] [--force-gcx-install] [--debug]";
const FRONTEND_USAGE_LINE = "npx @grafana/setup-cli frontend-o11y --stack <stack-url> [--folder <path>] [--force-gcx-install] [--debug]";

// Everything downstream (framework detection, skill install, npm install,
// snippet insertion, ...) already just reads process.cwd() rather than
// threading a project-path parameter through every function — chdir once,
// up front, so --folder redirects all of that with no other changes.
// Must run before runSetupUI/runFrontendUI render anything, since Header
// (ui/shared.tsx) reads process.cwd() too.
function applyFolder(rawFolder: string | undefined, usage: string): void {
  const folder = path.resolve(rawFolder ?? ".");
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    usageError(`--folder "${rawFolder}" is not a directory.`, usage);
  }
  process.chdir(folder);
}

function printHelp(): void {
  console.log(
    [
      "@grafana/setup-cli — Grafana Cloud's interactive setup wizard, powered by Assistant.",
      "Sets up Grafana products in your project.",
      "",
      "USAGE",
      `  ${SETUP_USAGE_LINE}`,
      `  ${FRONTEND_USAGE_LINE}`,
      "",
      "COMMANDS",
      "  synthetics             Set up Synthetic Monitoring checks for --url, then optionally Frontend O11y",
      "  frontend-o11y          Instrument this project with Frontend O11y only — no target URL needed",
      "",
      "FLAGS",
      "  --url <url>            Target URL to set up (required for synthetics)",
      "  --stack <url>          Grafana Cloud stack URL, e.g. https://my-team.grafana.net (required)",
      "  --folder <path>        Project directory to set up (default: .)",
      "  --base-url <url>       Synthetic Monitoring API URL (skips the prompt during setup)",
      "  --force-gcx-install    Install the Grafana Cloud CLI (gcx) without asking, if it's missing",
      "  --debug                Log raw Assistant tool calls/responses to a temp file, for troubleshooting",
      "  -h, --help             Show this help",
    ].join("\n")
  );
}

function usageError(message: string, usage: string): never {
  console.error([`Error: ${message}`, "", "Usage:", `  ${usage}`].join("\n"));
  process.exit(1);
}

async function runSetup(rest: string[]): Promise<void> {
  let baseUrl = process.env.SM_API_URL;
  let targetUrl: string | undefined;
  let stackUrl: string | undefined;
  let folder: string | undefined;
  let forceGcxInstall = false;
  let debug = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--base-url") baseUrl = rest[++i];
    else if (rest[i] === "--url") targetUrl = rest[++i];
    else if (rest[i] === "--stack") stackUrl = rest[++i];
    else if (rest[i] === "--folder") folder = rest[++i];
    else if (rest[i] === "--force-gcx-install") forceGcxInstall = true;
    else if (rest[i] === "--debug") debug = true;
  }
  if (!targetUrl || !stackUrl) usageError("--url and --stack are required.", SETUP_USAGE_LINE);
  if (!/^https?:\/\//.test(stackUrl)) stackUrl = `https://${stackUrl}`;
  applyFolder(folder, SETUP_USAGE_LINE);
  if (!baseUrl) {
    const stored = await readCredentials();
    baseUrl = stored?.baseUrl;
  }
  // Printed before runSetupUI hands the terminal to Ink — console.log is
  // safe here only because Ink hasn't started rendering yet.
  const debugFile = setDebugEnabled(debug);
  if (debugFile) console.log(`Debug log: ${debugFile}`);
  await runSetupUI(baseUrl, targetUrl, stackUrl, forceGcxInstall);
}

async function runFrontend(rest: string[]): Promise<void> {
  let stackUrl: string | undefined;
  let folder: string | undefined;
  let forceGcxInstall = false;
  let debug = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--stack") stackUrl = rest[++i];
    else if (rest[i] === "--folder") folder = rest[++i];
    else if (rest[i] === "--force-gcx-install") forceGcxInstall = true;
    else if (rest[i] === "--debug") debug = true;
  }
  if (!stackUrl) usageError("--stack is required.", FRONTEND_USAGE_LINE);
  if (!/^https?:\/\//.test(stackUrl)) stackUrl = `https://${stackUrl}`;
  applyFolder(folder, FRONTEND_USAGE_LINE);
  const debugFile = setDebugEnabled(debug);
  if (debugFile) console.log(`Debug log: ${debugFile}`);
  await runFrontendUI(stackUrl, forceGcxInstall);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  if (argv[0] === "synthetics") await runSetup(argv.slice(1));
  else if (argv[0] === "frontend-o11y") await runFrontend(argv.slice(1));
  else {
    console.error([`Error: unknown command "${argv[0]}".`, "", "Run with --help to see available commands."].join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof SmApiError) {
    console.error(err.body);
  }
  process.exit(1);
});
