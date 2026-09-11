import { setDebugEnabled } from "../debug.js";
import { runFrontendUI } from "../ui/FrontendApp.js";
import { applyFolder, usageError, type Command } from "./shared.js";

const USAGE_LINE = "npx @grafana/setup-cli frontend-o11y --stack <stack-url> [--folder <path>] [--force-gcx-install] [--debug]";

async function run(rest: string[]): Promise<void> {
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
  if (!stackUrl) usageError("--stack is required.", USAGE_LINE);
  if (!/^https?:\/\//.test(stackUrl)) stackUrl = `https://${stackUrl}`;
  applyFolder(folder, USAGE_LINE);
  const debugFile = setDebugEnabled(debug);
  if (debugFile) console.log(`Debug log: ${debugFile}`);
  await runFrontendUI(stackUrl, forceGcxInstall);
}

export const frontendO11yCommand: Command = {
  name: "frontend-o11y",
  usageLine: USAGE_LINE,
  summary: "Instrument this project with Frontend O11y only — no target URL needed",
  run,
};
