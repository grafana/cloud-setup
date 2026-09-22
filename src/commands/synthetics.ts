import { readCredentials } from "../products/syntheticMonitoring/credentials.js";
import { setDebugEnabled } from "../debug.js";
import { runSetupUI } from "../ui/SetupApp.js";
import { applyFolder, printCliError, type Command } from "./shared.js";

const USAGE_LINE =
  "npx @grafana/cloud-setup synthetics --url <target-url> --stack <stack-url> [--folder <path>] [--base-url <url>] [--force-gcx-install] [--debug]";
const SHORT_USAGE_LINE = "npx @grafana/cloud-setup synthetics --url <url> --stack <url>";
const EXAMPLE = [
  "npx @grafana/cloud-setup synthetics \\",
  "  --url https://example.com \\",
  "  --stack https://my-team.grafana.net",
];

async function run(rest: string[]): Promise<void> {
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
  if (!targetUrl && !stackUrl) printCliError(syntheticsCommand, "Missing required arguments: --url, --stack");
  else if (!targetUrl) printCliError(syntheticsCommand, "Missing required argument: --url");
  else if (!stackUrl) printCliError(syntheticsCommand, "Missing required argument: --stack");
  if (!/^https?:\/\//.test(stackUrl)) stackUrl = `https://${stackUrl}`;
  applyFolder(folder, syntheticsCommand);
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

export const syntheticsCommand: Command = {
  name: "synthetics",
  usageLine: USAGE_LINE,
  shortUsageLine: SHORT_USAGE_LINE,
  example: EXAMPLE,
  summary: "Set up Synthetic Monitoring checks and alerts",
  flags: [
    { flag: "--url <url>", description: "Target URL to check (required)" },
    { flag: "--stack <url>", description: "Grafana Cloud stack URL, e.g. https://my-team.grafana.net (required)" },
    { flag: "--folder <path>", description: "Project directory to set up (default: .)" },
    { flag: "--base-url <url>", description: "Synthetic Monitoring API URL (skips the prompt during setup)" },
    { flag: "--force-gcx-install", description: "Install the Grafana Cloud CLI (gcx) without asking, if it's missing" },
    { flag: "--debug", description: "Log raw Assistant tool calls/responses to a temp file, for troubleshooting" },
  ],
  run,
};
