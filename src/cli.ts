#!/usr/bin/env node
import { COMMANDS } from "./commands/index.js";
import { SmApiError } from "./products/syntheticMonitoring/api.js";

const FLAGS_HELP = [
  "  --url <url>            Target URL to set up (required for synthetics)",
  "  --stack <url>          Grafana Cloud stack URL, e.g. https://my-team.grafana.net (required)",
  "  --folder <path>        Project directory to set up (default: .)",
  "  --base-url <url>       Synthetic Monitoring API URL (skips the prompt during setup)",
  "  --force-gcx-install    Install the Grafana Cloud CLI (gcx) without asking, if it's missing",
  "  --debug                Log raw Assistant tool calls/responses to a temp file, for troubleshooting",
  "  -h, --help             Show this help",
];

function printHelp(): void {
  console.log(
    [
      "@grafana/setup-cli — Grafana Cloud's interactive setup wizard, powered by Assistant.",
      "Sets up Grafana products in your project.",
      "",
      "USAGE",
      ...COMMANDS.map((c) => `  ${c.usageLine}`),
      "",
      "COMMANDS",
      ...COMMANDS.map((c) => `  ${c.name.padEnd(23)}${c.summary}`),
      "",
      "FLAGS",
      ...FLAGS_HELP,
    ].join("\n")
  );
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const command = COMMANDS.find((c) => c.name === argv[0]);
  if (!command) {
    console.error([`Error: unknown command "${argv[0]}".`, "", "Run with --help to see available commands."].join("\n"));
    process.exit(1);
    return;
  }
  await command.run(argv.slice(1));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof SmApiError) {
    console.error(err.body);
  }
  process.exit(1);
});
