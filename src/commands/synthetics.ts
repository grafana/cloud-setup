import { readCredentials } from "../products/syntheticMonitoring/credentials.js";
import { setDebugEnabled } from "../debug.js";
import { runSyntheticsUI } from "../ui/SyntheticsApp.js";
import { applyFolder, parseCommandOptions, type Command } from "./shared.js";

const USAGE_LINE =
  "npx @grafana/cloud-setup synthetics [--url <target-url>] [--stack <slug-or-url>] [--folder <path>] [--base-url <url>] [--force-gcx-install] [--debug]";
const SHORT_USAGE_LINE = "npx @grafana/cloud-setup synthetics";
const EXAMPLE = ["npx @grafana/cloud-setup synthetics \\", "  --url https://example.com \\", "  --stack my-team"];

async function run(rest: string[]): Promise<void> {
  const { strings, booleans } = parseCommandOptions(rest, syntheticsCommand);
  let baseUrl = strings["base-url"] ?? process.env.SM_API_URL;
  applyFolder(strings.folder, syntheticsCommand);
  if (!baseUrl) {
    const stored = await readCredentials();
    baseUrl = stored?.baseUrl;
  }
  // Printed before runSyntheticsUI hands the terminal to Ink — console.log is
  // safe here only because Ink hasn't started rendering yet.
  const debugFile = setDebugEnabled(booleans.has("debug"));
  if (debugFile) console.log(`Debug log: ${debugFile}`);
  await runSyntheticsUI(baseUrl, strings.url, strings.stack, booleans.has("force-gcx-install"));
}

export const syntheticsCommand: Command = {
  name: "synthetics",
  usageLine: USAGE_LINE,
  shortUsageLine: SHORT_USAGE_LINE,
  example: EXAMPLE,
  summary: "Set up Synthetic Monitoring checks",
  flags: [
    { flag: "--url <url>", description: "Target URL to check (prompted if omitted or invalid)" },
    { flag: "--stack <slug-or-url>", description: "Grafana Cloud stack slug or URL (prompted if omitted or invalid)" },
    { flag: "--folder <path>", description: "Project directory to set up (default: .)" },
    { flag: "--base-url <url>", description: "Synthetic Monitoring API URL (skips the prompt during setup)" },
    { flag: "--force-gcx-install", description: "Install the Grafana Cloud CLI (gcx) without asking, if it's missing" },
    { flag: "--debug", description: "Log raw Assistant tool calls/responses to a temp file, for troubleshooting" },
  ],
  run,
};
