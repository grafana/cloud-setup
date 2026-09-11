#!/usr/bin/env node
import { SmApiError } from "./api.js";
import { readCredentials } from "./credentials.js";
import { setDebugEnabled } from "./debug.js";
import { runSetupUI } from "./ui/SetupApp.js";

const USAGE_LINE =
  "synthetics --url <target-url> --stack <stack-url> [--base-url <url>] [--force-gcx-install] [--debug]";

function printHelp(): void {
  console.log(
    [
      "synthetics — Grafana Cloud's interactive setup wizard, powered by Assistant.",
      "Installs gcx and agent skills, and sets up Grafana products in your project.",
      "",
      "USAGE",
      `  ${USAGE_LINE}`,
      "",
      "FLAGS",
      "  --url <url>            Target URL to set up (required)",
      "  --stack <url>          Grafana Cloud stack URL, e.g. https://my-team.grafana.net (required)",
      "  --base-url <url>       Synthetic Monitoring API URL (skips the prompt during setup)",
      "  --force-gcx-install    Install the Grafana Cloud CLI (gcx) without asking, if it's missing",
      "  --debug                Log raw Assistant tool calls/responses to a temp file, for troubleshooting",
      "  -h, --help             Show this help",
    ].join("\n")
  );
}

function usageError(): never {
  console.error(["Error: --url and --stack are required.", "", "Usage:", `  ${USAGE_LINE}`].join("\n"));
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);

  // "setup" was the only command and is now implicit, but still accepted for
  // anyone already typing it — `synthetics setup --url ...` and
  // `synthetics --url ...` do the same thing.
  const rest = argv[0] === "setup" ? argv.slice(1) : argv;

  if (rest.length === 0 || rest.includes("--help") || rest.includes("-h")) {
    printHelp();
    return;
  }

  let baseUrl = process.env.SM_API_URL;
  let targetUrl: string | undefined;
  let stackUrl: string | undefined;
  let forceGcxInstall = false;
  let debug = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--base-url") baseUrl = rest[++i];
    else if (rest[i] === "--url") targetUrl = rest[++i];
    else if (rest[i] === "--stack") stackUrl = rest[++i];
    else if (rest[i] === "--force-gcx-install") forceGcxInstall = true;
    else if (rest[i] === "--debug") debug = true;
  }
  if (!targetUrl || !stackUrl) usageError();
  if (!/^https?:\/\//.test(stackUrl)) stackUrl = `https://${stackUrl}`;
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof SmApiError) {
    console.error(err.body);
  }
  process.exit(1);
});
