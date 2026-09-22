import { setDebugEnabled } from "../debug.js";
import { runFrontendUI } from "../ui/FrontendApp.js";
import { applyFolder, printCliError, type Command } from "./shared.js";

const USAGE_LINE = "npx @grafana/cloud-setup frontend --stack <stack-url> [--app <name>] [--folder <path>] [--force-gcx-install] [--debug]";
const SHORT_USAGE_LINE = "npx @grafana/cloud-setup frontend --stack <url>";
const EXAMPLE = ["npx @grafana/cloud-setup frontend \\", "  --stack https://my-team.grafana.net"];

async function run(rest: string[]): Promise<void> {
  let stackUrl: string | undefined;
  let appName: string | undefined;
  let folder: string | undefined;
  let forceGcxInstall = false;
  let debug = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--stack") stackUrl = rest[++i];
    else if (rest[i] === "--app") appName = rest[++i];
    else if (rest[i] === "--folder") folder = rest[++i];
    else if (rest[i] === "--force-gcx-install") forceGcxInstall = true;
    else if (rest[i] === "--debug") debug = true;
  }
  if (!stackUrl) printCliError(frontendO11yCommand, "Missing required argument: --stack");
  if (!/^https?:\/\//.test(stackUrl)) stackUrl = `https://${stackUrl}`;
  applyFolder(folder, frontendO11yCommand);
  const debugFile = setDebugEnabled(debug);
  if (debugFile) console.log(`Debug log: ${debugFile}`);
  await runFrontendUI(stackUrl, forceGcxInstall, appName, "direct");
}

export const frontendO11yCommand: Command = {
  name: "frontend",
  usageLine: USAGE_LINE,
  shortUsageLine: SHORT_USAGE_LINE,
  example: EXAMPLE,
  summary: "Instrument local app with Frontend Observability",
  flags: [
    { flag: "--stack <url>", description: "Grafana Cloud stack URL, e.g. https://my-team.grafana.net (required)" },
    { flag: "--app <name>", description: "Frontend Observability app to attach to (skips the picker if it exists)" },
    { flag: "--folder <path>", description: "Project directory to set up (default: .)" },
    { flag: "--force-gcx-install", description: "Install the Grafana Cloud CLI (gcx) without asking, if it's missing" },
    { flag: "--debug", description: "Log raw Assistant tool calls/responses to a temp file, for troubleshooting" },
  ],
  run,
};
