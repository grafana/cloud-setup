import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Probe } from "./api.js";
import { DEFAULT_FREQUENCY_MS, DEFAULT_TIMEOUT_MS } from "./reconcile.js";
import type { CheckDefinition, CheckSettings, SyntheticConfig } from "./types.js";

// Never an existing directory — this should never silently merge into (or
// clobber) a project's real Terraform setup. Falls back to a numbered name
// in the unlikely case both plain names are already taken.
function pickExportDir(cwd: string): string {
  for (const name of ["terraform", "terraform_synthetics"]) {
    const full = path.join(cwd, name);
    if (!existsSync(full)) return full;
  }
  for (let n = 2; ; n++) {
    const full = path.join(cwd, `terraform_synthetics_${n}`);
    if (!existsSync(full)) return full;
  }
}

function hclString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function hclScalar(value: unknown): string {
  if (typeof value === "string") return hclString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => hclScalar(v)).join(", ")}]`;
  return "null";
}

function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}

// Fallback for any settings type beyond the three below (dns, ping,
// traceroute, grpc, multihttp, scripted) — none of these are ever produced
// by discover.ts today, but this keeps export from silently breaking if
// that changes. Field names are converted to the provider's snake_case.
function genericBlockBody(obj: Record<string, unknown>, indent: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const snakeKey = camelToSnake(key);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      lines.push(`${indent}${snakeKey} {`);
      lines.push(genericBlockBody(value as Record<string, unknown>, `${indent}  `));
      lines.push(`${indent}}`);
    } else {
      lines.push(`${indent}${snakeKey} = ${hclScalar(value)}`);
    }
  }
  return lines.join("\n");
}

// http/tcp/browser are hand-modeled (rather than run through the generic
// fallback above) so the export matches the shape Grafana's own Terraform
// export page produces byte-for-byte where it matters — including fields
// our own candidates never set explicitly (fail_if_ssl, ip_version, ...)
// but the real provider schema always shows.
function httpBlock(s: NonNullable<CheckSettings["http"]>, indent: string): string {
  return [
    `${indent}http {`,
    `${indent}  method = ${hclScalar(s.method ?? "GET")}`,
    `${indent}  fail_if_not_ssl = ${s.failIfNotSsl ?? false}`,
    `${indent}  fail_if_ssl = ${s.failIfSsl ?? false}`,
    `${indent}  ip_version = ${hclScalar(s.ipVersion ?? "Any")}`,
    `${indent}  no_follow_redirects = ${s.noFollowRedirects ?? false}`,
    `${indent}}`,
  ].join("\n");
}

function tcpBlock(s: NonNullable<CheckSettings["tcp"]>, indent: string): string {
  return [
    `${indent}tcp {`,
    `${indent}  ip_version = ${hclScalar(s.ipVersion ?? "Any")}`,
    `${indent}  tls = ${s.tls ?? false}`,
    `${indent}}`,
  ].join("\n");
}

// Un-indented closing marker (`<<EOF` not `<<-EOF`) to match Grafana's own
// export exactly — an indented heredoc marker is also valid HCL but this
// keeps a byte-for-byte match with the reference output.
function browserBlock(s: NonNullable<CheckSettings["browser"]>, indent: string): string {
  // s.script already ends in a single newline — strip it before joining so
  // `.join("\n")` doesn't add a second one and leave a blank line before EOF.
  return [`${indent}browser {`, `${indent}  script = <<EOF`, s.script.replace(/\n$/, ""), "EOF", `${indent}}`].join(
    "\n",
  );
}

function settingsBlock(settings: CheckSettings, indent: string): string {
  if (settings.http) return [`${indent}settings {`, httpBlock(settings.http, `${indent}  `), `${indent}}`].join("\n");
  if (settings.tcp) return [`${indent}settings {`, tcpBlock(settings.tcp, `${indent}  `), `${indent}}`].join("\n");
  if (settings.browser)
    return [`${indent}settings {`, browserBlock(settings.browser, `${indent}  `), `${indent}}`].join("\n");

  const entry = Object.entries(settings).find(([, v]) => v !== undefined);
  if (!entry) return `${indent}settings {}`;
  const [type, value] = entry;
  return [
    `${indent}settings {`,
    `${indent}  ${type} {`,
    genericBlockBody(value, `${indent}    `),
    `${indent}  }`,
    `${indent}}`,
  ].join("\n");
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "_");
}

// Matches Grafana's own export page's local resource names exactly:
// "<job>_<target with every non-alnum char turned into '_'>". Terraform
// local names allow hyphens, so job names like "ai-api-profile" (from
// discover.ts's AI-discovered candidates) pass through unchanged.
function resourceLocalName(jobName: string, target: string): string {
  return `${jobName}_${slug(target)}`;
}

function checkResource(jobName: string, def: CheckDefinition, probeIds: Map<string, number>): string {
  const ids = def.probes.map((name) => probeIds.get(name)).filter((id): id is number => id !== undefined);
  return [
    `resource "grafana_synthetic_monitoring_check" "${resourceLocalName(jobName, def.target)}" {`,
    `  job = ${hclScalar(jobName)}`,
    `  target = ${hclScalar(def.target)}`,
    `  enabled = ${def.enabled ?? true}`,
    `  probes = [${ids.join(", ")}]`,
    settingsBlock(def.settings, "  "),
    `  frequency = ${def.frequency ?? DEFAULT_FREQUENCY_MS}`,
    `  timeout = ${def.timeout ?? DEFAULT_TIMEOUT_MS}`,
    "}",
  ].join("\n");
}

function generateTerraform(
  config: SyntheticConfig,
  probes: Probe[],
  stackUrl: string,
  smUrl: string | undefined,
): string {
  const probeIds = new Map(probes.map((p) => [p.name, p.id]));
  const resources = Object.entries(config).map(([name, def]) => checkResource(name, def, probeIds));

  return [
    "# Generated by @grafana/cloud-setup.",
    "# See README.md in this folder for required environment variables and the",
    "# `terraform import` commands to run before `terraform apply` — these",
    "# checks already exist (this wizard created them via the API), so",
    "# applying without importing first would try to create duplicates.",
    "",
    "terraform {",
    "  required_providers {",
    '    grafana = { source = "grafana/grafana" }',
    "  }",
    "}",
    "",
    'provider "grafana" {',
    `  url    = ${hclScalar(stackUrl)}`,
    // The real SM API URL couldn't be auto-discovered — GRAFANA_SM_URL
    // needs to be set instead (see README.md), rather than writing a
    // guessed/wrong value here.
    ...(smUrl !== undefined ? [`  sm_url = ${hclScalar(smUrl)}`] : []),
    "  # auth and sm_access_token are read from the GRAFANA_AUTH and",
    "  # GRAFANA_SM_ACCESS_TOKEN environment variables — see README.md.",
    "}",
    "",
    resources.join("\n\n"),
    "",
  ].join("\n");
}

// Sequential lines, not `&&`-chained — `set -e` already stops on the first
// failure, and separate lines make it obvious which check failed to import.
function generateImportScript(importCommands: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "# Imports the checks this wizard already created into Terraform state.",
    "# Run this once, before your first `terraform apply` — see README.md.",
    "set -euo pipefail",
    'cd "$(dirname "$0")"',
    "",
    ': "${GRAFANA_AUTH:?GRAFANA_AUTH is not set — see README.md}"',
    ': "${GRAFANA_SM_ACCESS_TOKEN:?GRAFANA_SM_ACCESS_TOKEN is not set — see README.md}"',
    "",
    ...importCommands,
    "",
  ].join("\n");
}

function generateReadme(stackUrl: string, smUrlKnown: boolean): string {
  const trimmedStack = stackUrl.replace(/\/$/, "");
  return [
    "# Terraform Export (Synthetic Monitoring)",
    "",
    "Generated by `@grafana/cloud-setup`",
    "",
    "## What's included",
    "",
    "- `synthetic_monitoring.tf`: the checks this wizard created, as Terraform config",
    "- `import.sh`: script to import existing checks into Terraform state by ID",
    "",
    "## First-time setup",
    "",
    "1. Install [Terraform](https://developer.hashicorp.com/terraform/install).",
    "2. Export the credentials Terraform needs to authenticate:",
    "   - `GRAFANA_AUTH`: a Grafana Cloud service account token with Synthetic Monitoring permissions.",
    `      - Create one at: ${trimmedStack}/org/serviceaccounts`,
    "   - `GRAFANA_SM_ACCESS_TOKEN`: a Synthetic Monitoring access token.",
    `      - Create one at: ${trimmedStack}/a/grafana-synthetic-monitoring-app/config/access-tokens`,
    ...(smUrlKnown
      ? []
      : [
          "   - `GRAFANA_SM_URL`: the Synthetic Monitoring API's base URL. Couldn't be",
          "     auto-discovered this run.",
          `      - Find it at: ${trimmedStack}/a/grafana-synthetic-monitoring-app, or from the`,
          "        URL the access-token page above redirected you from.",
        ]),
    "3. Run `./import.sh` once.",
    "4. Run `terraform plan`: it should report no changes.",
    "",
  ].join("\n");
}

// Writes the generated config, an import.sh, and a README into a fresh
// directory under `cwd`, and returns the .tf file's path for display.
// `remoteIds` maps job name -> the SM check ID the API assigned when the
// wizard created it, so import.sh actually works.
export async function writeTerraformExport(
  config: SyntheticConfig,
  probes: Probe[],
  remoteIds: Map<string, number>,
  stackUrl: string,
  smUrl: string | undefined,
  cwd: string,
): Promise<string> {
  const dir = pickExportDir(cwd);
  await mkdir(dir, { recursive: true });

  const importCommands = Object.entries(config)
    .map(([jobName, def]) => {
      const id = remoteIds.get(jobName);
      return id === undefined
        ? undefined
        : `terraform import grafana_synthetic_monitoring_check.${resourceLocalName(jobName, def.target)} ${id}`;
    })
    .filter((line): line is string => line !== undefined);

  const file = path.join(dir, "synthetic_monitoring.tf");
  await writeFile(file, generateTerraform(config, probes, stackUrl, smUrl), "utf8");
  await writeFile(path.join(dir, "import.sh"), generateImportScript(importCommands), { mode: 0o755 });
  await writeFile(path.join(dir, "README.md"), generateReadme(stackUrl, smUrl !== undefined), "utf8");
  return file;
}
