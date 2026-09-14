#!/usr/bin/env node
import { COMMANDS } from "./commands/index.js";
import { printCommandHelp } from "./commands/shared.js";
import { bad, titleLine } from "./cliStyle.js";
import { SmApiError } from "./products/syntheticMonitoring/api.js";

function printGlobalHelp(): void {
  const nameWidth = Math.max(...COMMANDS.map((c) => c.name.length));
  console.log(
    [
      titleLine(),
      "Grafana Cloud's interactive setup wizard, powered by Assistant.",
      "",
      "USAGE",
      "  npx @grafana/setup-cli <command>",
      "",
      "COMMANDS",
      ...COMMANDS.map((c) => `  ${c.name.padEnd(nameWidth)}    ${c.summary}`),
      "",
      "Run npx @grafana/setup-cli <command> --help for usage and options.",
    ].join("\n")
  );
}

function printUnknownCommand(name: string): void {
  console.error([titleLine(), "", bad(`✗ Unknown command: ${name}`), "", "Run npx @grafana/setup-cli --help to see available commands."].join("\n"));
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printGlobalHelp();
    return;
  }

  const command = COMMANDS.find((c) => c.name === argv[0]);
  if (!command) {
    if (argv.includes("--help") || argv.includes("-h")) {
      printGlobalHelp();
      return;
    }
    printUnknownCommand(argv[0]!);
    process.exit(1);
    return;
  }

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    printCommandHelp(command);
    return;
  }
  await command.run(rest);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof SmApiError) {
    console.error(err.body);
  }
  process.exit(1);
});
