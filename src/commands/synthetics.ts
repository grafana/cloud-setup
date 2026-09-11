import { readCredentials } from "../products/syntheticMonitoring/credentials.js";
import { setDebugEnabled } from "../debug.js";
import { runSetupUI } from "../ui/SetupApp.js";
import { applyFolder, usageError, type Command } from "./shared.js";

const USAGE_LINE =
  "npx @grafana/setup-cli synthetics --url <target-url> --stack <stack-url> [--folder <path>] [--base-url <url>] [--force-gcx-install] [--debug]";

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
  if (!targetUrl || !stackUrl) usageError("--url and --stack are required.", USAGE_LINE);
  if (!/^https?:\/\//.test(stackUrl)) stackUrl = `https://${stackUrl}`;
  applyFolder(folder, USAGE_LINE);
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
  summary: "Set up Synthetic Monitoring checks for --url",
  run,
};
