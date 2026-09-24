import { setDebugEnabled } from "../debug.js";
import { runFrontendUI } from "../ui/FrontendApp.js";
import { applyFolder, parseCommandOptions, type Command } from "./shared.js";

const USAGE_LINE =
  "npx @grafana/cloud-setup frontend [--stack <slug-or-url>] [--app <name>] [--folder <path>] [--force-gcx-install] [--debug]";
const SHORT_USAGE_LINE = "npx @grafana/cloud-setup frontend";
const EXAMPLE = ["npx @grafana/cloud-setup frontend \\", "  --stack my-team"];

async function run(rest: string[]): Promise<void> {
  const { strings, booleans } = parseCommandOptions(rest, frontendO11yCommand);
  applyFolder(strings.folder, frontendO11yCommand);
  const debugFile = setDebugEnabled(booleans.has("debug"));
  if (debugFile) console.log(`Debug log: ${debugFile}`);
  await runFrontendUI(strings.stack, booleans.has("force-gcx-install"), strings.app);
}

export const frontendO11yCommand: Command = {
  name: "frontend",
  usageLine: USAGE_LINE,
  shortUsageLine: SHORT_USAGE_LINE,
  example: EXAMPLE,
  summary: "Instrument local app with Frontend Observability",
  flags: [
    { flag: "--stack <slug-or-url>", description: "Grafana Cloud stack slug or URL (prompted if omitted or invalid)" },
    { flag: "--app <name>", description: "Frontend Observability app to attach to (skips the picker if it exists)" },
    { flag: "--folder <path>", description: "Project directory to set up (default: .)" },
    { flag: "--force-gcx-install", description: "Install the Grafana Cloud CLI (gcx) without asking, if it's missing" },
    { flag: "--debug", description: "Log raw Assistant tool calls/responses to a temp file, for troubleshooting" },
  ],
  run,
};
