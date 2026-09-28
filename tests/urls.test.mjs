import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { validateUrl } from "../dist/urls.js";
import { parseCommandOptions } from "../dist/commands/shared.js";

test("setup URLs accept HTTP(S), bare hostnames, ports, and IPv6", () => {
  for (const [raw, kind, expected] of [
    [" example.grafana.net ", "stack", "https://example.grafana.net"],
    ["HTTPS://EXAMPLE.GRAFANA.NET/", "stack", "https://example.grafana.net"],
    ["http://localhost:3000/", "stack", "http://localhost:3000"],
    ["http://my-team/", "stack", "http://my-team"],
    ["https://my-team", "stack", "https://my-team"],
    ["https://grafana.example.org", "stack", "https://grafana.example.org"],
    ["localhost:3000", "stack", "https://localhost:3000"],
    ["127.0.0.1:3000", "stack", "https://127.0.0.1:3000"],
    ["[::1]:3000", "stack", "https://[::1]:3000"],
    ["example.com/api/health?ready=1", "target", "https://example.com/api/health?ready=1"],
    ["https://example.com/a%20b", "target", "https://example.com/a%20b"],
  ]) {
    assert.deepEqual(validateUrl(raw, kind), { url: expected });
  }
});

test("stack slugs, hostnames, and URLs resolve to the same canonical URL", () => {
  for (const raw of ["my-team", " MY-Team ", "my-team.grafana.net", "https://my-team.grafana.net/"]) {
    assert.deepEqual(validateUrl(raw, "stack"), { url: "https://my-team.grafana.net" });
  }
  for (const raw of ["a", "team42", "42", "a".repeat(63)]) {
    assert.deepEqual(validateUrl(raw, "stack"), { url: `https://${raw}.grafana.net` });
  }
});

test("invalid stack slugs cannot fall through to single-label URLs", () => {
  for (const raw of ["my_team", "my team", "-my-team", "my-team-", "a".repeat(64), "my-team/", "my-team?orgId=1"]) {
    assert.ok(validateUrl(raw, "stack").error, raw);
  }
});

test("slug expansion applies only to stack input", () => {
  assert.deepEqual(validateUrl("my-team", "target"), { url: "https://my-team/" });
  assert.deepEqual(validateUrl("my-team", "stack"), { url: "https://my-team.grafana.net" });
});

test("missing and malformed URLs cannot be normalized into accepted setup inputs", () => {
  for (const raw of [
    "",
    "  ",
    "https:stackname.grafana.net",
    "https:my-team",
    "https:/stackname.grafana.net",
    "https:///stackname.grafana.net",
    "https//stackname.grafana.net",
    "https//my-team",
    "https://",
    "ftp://example.com",
    "javascript:alert(1)",
    "//example.com",
    "/relative/path",
    "https://example.com:invalid",
    "https://example.com/a b",
    "https://example.com\n/path",
    "https://example.com\\path",
    "https://test-user@example.com",
  ]) {
    for (const kind of ["target", "stack", "collector"]) {
      assert.equal(typeof validateUrl(raw, kind).error, "string", `${kind}: ${JSON.stringify(raw)}`);
    }
  }
});

test("stack URLs must identify the base URL, while targets can include paths and queries", () => {
  for (const suffix of ["/a/grafana-synthetic-monitoring-app", "?orgId=1", "#home"]) {
    const url = `https://example.grafana.net${suffix}`;
    assert.ok(validateUrl(url, "stack").error);
    assert.ok(validateUrl(url, "target").url);
  }
});

const command = {
  flags: [{ flag: "--url <url>" }, { flag: "--stack <slug-or-url>" }, { flag: "--folder <path>" }, { flag: "--debug" }],
};

test("omitted URL values do not consume the next flag", () => {
  const result = parseCommandOptions(["--url", "--stack", "example.grafana.net", "--debug"], command);
  assert.equal(result.strings.url, "");
  assert.equal(result.strings.stack, "example.grafana.net");
  assert.ok(result.booleans.has("debug"));
  assert.equal(parseCommandOptions(["--stack"], command).strings.stack, "");
  assert.deepEqual(parseCommandOptions([], command).strings, {});
});

test("command options accept equals syntax and keep URLs intact for interactive correction", () => {
  const result = parseCommandOptions(["--stack=https:example.grafana.net", "--url=https://example.com?q=1"], command);
  assert.equal(result.strings.stack, "https:example.grafana.net");
  assert.equal(result.strings.url, "https://example.com?q=1");
  assert.equal(parseCommandOptions(["--stack", "my-team"], command).strings.stack, "my-team");
  assert.equal(parseCommandOptions(["--stack=my-team"], command).strings.stack, "my-team");
});

function cli(...args) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], {
    encoding: "utf8",
    // Avoid reading the developer's saved Synthetic Monitoring credentials.
    env: { ...process.env, CLOUD_SETUP_TELEMETRY: "disabled", SM_API_URL: "https://example.invalid" },
    timeout: 5000,
  });
}

test("unknown options and missing non-URL values report usage errors", () => {
  for (const name of ["synthetics", "frontend"]) {
    const typo = cli(name, "--stak", "example.grafana.net");
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /Unknown option '--stak'/);
    const missingFolder = cli(name, "--folder");
    assert.equal(missingFolder.status, 1);
    assert.match(missingFolder.stderr, /argument missing/);
  }
});

test("commands without URL flags reach the interactive-terminal gate", () => {
  for (const name of ["synthetics", "frontend"]) {
    const result = cli(name);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires an interactive terminal/);
    assert.doesNotMatch(result.stderr, /Missing required/);
  }
});

test("help documents prompted stack slugs and URLs for both commands", () => {
  for (const name of ["synthetics", "frontend"]) {
    const result = cli(name, "--help");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[--stack <slug-or-url>\]/);
    assert.match(result.stdout, /stack slug or URL/);
    assert.match(result.stdout, /prompted if omitted or invalid/);
  }
});
