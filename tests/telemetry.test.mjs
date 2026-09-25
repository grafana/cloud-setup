import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

// Every run gets its own XDG state home, so the persisted device ID never
// touches the developer's real one and each test starts with no install ID.
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-setup-telemetry-"));
process.env.XDG_STATE_HOME = stateRoot;
const deviceIdFile = () => path.join(process.env.XDG_STATE_HOME, "cloud-setup", "device-id");

const ENDPOINT = "https://stats.grafana.org/cloud-setup-usage-report";

let sequence = 0;
async function telemetry(mode = "enabled", stateHome = fs.mkdtempSync(path.join(stateRoot, "run-"))) {
  process.env.CLOUD_SETUP_TELEMETRY = mode;
  process.env.XDG_STATE_HOME = stateHome;
  return import(`../dist/telemetry.js?test=${sequence++}`);
}

// Captures each POST and hands back the resolver, so delivery can be settled
// or deliberately left hanging.
function captureSends(t) {
  const sent = [];
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (typeof url === "string" && url.startsWith(ENDPOINT)) {
      let settle;
      const response = new Promise((resolve) => {
        settle = resolve;
      });
      sent.push({ url, payload: JSON.parse(options.body), method: options.method, settle });
      return response;
    }
    assert.fail(`Unexpected request to ${url}`);
  });
  return sent;
}

let authCalls = 0;
const stack = "https://example.grafana.net";

// A pre-auth event must not import or call the interactive authentication module.
mock.module("../dist/harness/auth.js", {
  namedExports: {
    ensureAssistantAuth() {
      authCalls++;
      throw new Error("Telemetry initiated login");
    },
  },
});

test("events POST with the envelope the receiver expects", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();
  api.recordStep("frontend", stack, "gcx", { status: "ok" });
  api.recordRun("frontend", stack, "canceled", 5);

  assert.equal(sent.length, 2);
  assert.equal(authCalls, 0);
  assert.equal(sent[0].url, ENDPOINT);
  assert.equal(sent[0].method, "POST");

  const step = sent[0].payload;
  assert.equal(step.service, "cloud-setup");
  assert.equal(step.command, "frontend");
  assert.equal(step.event, "completed_step");
  assert.equal(step.step, "gcx");
  assert.equal(step.status, "ok");
  assert.equal(step.os, process.platform);
  assert.equal(step.arch, process.arch);
  assert.equal(typeof step.version, "string");
  assert.equal(step.outcome, undefined, "a step event carries no run outcome");
  assert.equal(step.duration_ms, undefined);

  const run = sent[1].payload;
  assert.equal(run.event, "finished_setup");
  assert.equal(run.outcome, "canceled");
  assert.equal(run.duration_ms, 5);
  assert.equal(run.step, undefined, "a run event carries no step");

  // No identity of any kind beyond the anonymous install and run IDs.
  for (const field of ["user_id", "userId", "email", "stack_url", "anonymousId", "org_id", "stack_id"]) {
    assert.equal(step[field], undefined, `${field} must never be sent`);
  }
  assert.equal(step.run_id, run.run_id, "events of one run share a run ID");

  sent.forEach((s) => s.settle({ ok: true }));
  await api.waitForTelemetry();
});

test("the device ID persists across runs while the run ID does not", async (t) => {
  const home = fs.mkdtempSync(path.join(stateRoot, "shared-"));
  const first = captureSends(t);
  const firstRun = await telemetry("enabled", home);
  firstRun.recordRun("frontend", stack, "ok", 1);
  first.forEach((s) => s.settle({ ok: true }));

  const stored = fs.readFileSync(path.join(home, "cloud-setup", "device-id"), "utf8").trim();
  assert.equal(first[0].payload.device_id, stored);

  t.mock.restoreAll();
  const second = captureSends(t);
  const secondRun = await telemetry("enabled", home);
  secondRun.recordRun("frontend", stack, "ok", 1);
  second.forEach((s) => s.settle({ ok: true }));

  assert.equal(second[0].payload.device_id, stored, "install ID is stable across runs");
  assert.notEqual(second[0].payload.run_id, first[0].payload.run_id, "run ID is not");
});

test("URL validation reports completion without collecting either URL", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();
  api.recordStep("synthetics", stack, "urls", { status: "ok" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.step, "urls");
  assert.equal(sent[0].payload.status, "ok");
  assert.equal(sent[0].payload.stack_id, undefined);
  assert.equal(sent[0].payload.stack_url, undefined);
  assert.equal(sent[0].payload.target_url, undefined);
  assert.ok(!JSON.stringify(sent[0].payload).includes(stack));
  sent[0].settle({ ok: true });
  await api.waitForTelemetry();
});

test("an unwritable state directory omits the device ID rather than sending a throwaway", async (t) => {
  const home = fs.mkdtempSync(path.join(stateRoot, "readonly-"));
  fs.chmodSync(home, 0o500);
  t.after(() => fs.chmodSync(home, 0o700));

  const sent = captureSends(t);
  const api = await telemetry("enabled", home);
  api.recordRun("frontend", stack, "ok", 1);

  // A throwaway UUID would read as a real install and inflate distinct-install
  // counts, so the field must be absent instead.
  assert.equal(sent[0].payload.device_id, undefined);
  assert.ok(sent[0].payload.run_id, "the run still reports, just unattributed");
  sent.forEach((s) => s.settle({ ok: true }));
});

test("the stack identity attaches to later events only", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();

  api.recordStep("synthetics", stack, "gcx", { status: "ok" });
  api.setStackIdentity(stack, 470494);
  api.recordStep("synthetics", stack, "auth", { status: "ok" });

  assert.equal(sent[0].payload.stack_id, undefined, "pre-sign-in events carry no stack");
  assert.equal(sent[1].payload.stack_id, 470494);
  assert.equal(
    sent[0].payload.run_id,
    sent[1].payload.run_id,
    "run_id joins the unattributed event to the attributed one",
  );
  sent.forEach((s) => s.settle({ ok: true }));
  await api.waitForTelemetry();
});

// The stack comes from the session the wizard already has, so establishing it
// must never cost a request of its own.
test("establishing the stack identity makes no HTTP request", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();
  api.setStackIdentity(stack, 470494);
  assert.equal(sent.length, 0, "no request beyond the events themselves");
  api.recordRun("synthetics", stack, "ok", 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.stack_id, 470494);
  sent.forEach((s) => s.settle({ ok: true }));
});

test("an absent stack id is omitted rather than defaulted", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();
  api.setStackIdentity(stack, undefined);
  api.recordRun("frontend", stack, "ok", 1);
  assert.equal(sent[0].payload.stack_id, undefined);
  assert.equal(sent[0].payload.command, "frontend", "the rest of the event is unaffected");
  sent.forEach((s) => s.settle({ ok: true }));
});

test("an identity never leaks across stack URLs", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();
  api.setStackIdentity(stack, 470494);
  api.recordRun("frontend", stack + "/different", "ok", 1);
  assert.equal(sent[0].payload.stack_id, undefined);
  api.recordRun("frontend", stack, "ok", 1);
  assert.equal(sent[1].payload.stack_id, 470494);
  sent.forEach((s) => s.settle({ ok: true }));
});

test("step properties travel alongside the envelope but cannot shadow it", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();
  api.recordStep("frontend", stack, "pick-app", { status: "ok", app_resolution: "existing", already_installed: false });
  // The envelope must win over anything a step reports. TypeScript forbids
  // these keys, so this is the runtime backstop for a JS caller or a cast.
  api.recordStep("frontend", stack, "auth", {
    status: "ok",
    command: "spoofed",
    event: "spoofed",
    step: "spoofed",
    os: "spoofed",
  });

  assert.equal(sent[0].payload.app_resolution, "existing");
  assert.equal(sent[0].payload.already_installed, false, "false properties are preserved, not dropped");

  assert.equal(sent[1].payload.command, "frontend");
  assert.equal(sent[1].payload.event, "completed_step");
  assert.equal(sent[1].payload.step, "auth");
  assert.equal(sent[1].payload.os, process.platform);

  sent.forEach((s) => s.settle({ ok: true }));
});

test("the alerting step reports its two halves separately", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();
  // The step can alert the checks without configuring an email
  // destination, so one status can't stand in for both outcomes. Easy for
  // a refactor to collapse the last two back into a plain "ok".
  api.recordStep("synthetics", stack, "alerting", {
    status: "ok",
    alerting_outcome: "configured",
    alert_presets: 2,
    checks_alerted: 4,
    contact_point: "created",
    notification_route: "created",
  });
  api.recordStep("synthetics", stack, "alerting", {
    status: "declined",
    alerting_outcome: "rules_only",
    checks_alerted: 4,
  });
  api.recordStep("synthetics", stack, "alerting", { status: "ok", alerting_outcome: "unavailable", checks_alerted: 4 });

  assert.equal(sent[0].payload.alerting_outcome, "configured");
  assert.equal(sent[0].payload.contact_point, "created");
  assert.equal(sent[0].payload.notification_route, "created");
  assert.equal(sent[0].payload.alert_presets, 2);
  assert.equal(sent[0].payload.checks_alerted, 4);

  assert.equal(sent[1].payload.alerting_outcome, "rules_only");
  assert.equal(sent[1].payload.status, "declined");
  // Out of reach is distinct from the user declining.
  assert.equal(sent[2].payload.alerting_outcome, "unavailable");

  for (const s of sent) {
    const serialized = JSON.stringify(s.payload);
    assert.ok(!serialized.includes("@"), "an alerting event must never carry an email address");
  }

  sent.forEach((s) => s.settle({ ok: true }));
});

test("shutdown waits for older deliveries even when the newest finishes first", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();
  api.recordStep("frontend", stack, "instrument", { status: "ok" });
  api.recordRun("frontend", stack, "incomplete", 100);
  sent[1].settle({ ok: true });

  let drained = false;
  const wait = api.waitForTelemetry().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  sent[0].settle({ ok: true });
  await wait;
  assert.equal(drained, true);
});

// send() runs inside workflow completion and hardExit(), so it must not
// throw for any reason. The property types are compile-time only, and an
// unserializable value makes JSON.stringify throw synchronously.
test("an unserializable property drops the event instead of throwing", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();

  api.recordStep("frontend", stack, "gcx", { status: "ok", bad: 10n });
  assert.equal(sent.length, 0, "the event is dropped");

  // The wizard carries on, and later events are unaffected.
  api.recordRun("frontend", stack, "ok", 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.outcome, "ok");
  sent.forEach((s) => s.settle({ ok: true }));
  await api.waitForTelemetry();
});

// The instrument step used to report its result as `outcome`, which belongs to
// the run — one run then reported two conflicting outcomes. Step results need
// their own field.
test("a step event never sets the run-level outcome field", async (t) => {
  const sent = captureSends(t);
  const api = await telemetry();
  api.recordStep("frontend", stack, "instrument", { status: "failed", instrumentation: "partial" });
  api.recordRun("frontend", stack, "incomplete", 10);

  assert.equal(sent[0].payload.outcome, undefined, "the step must not set outcome");
  assert.equal(sent[0].payload.instrumentation, "partial");
  assert.equal(sent[0].payload.status, "failed");
  assert.equal(sent[1].payload.outcome, "incomplete", "only the run event sets outcome");
  sent.forEach((s) => s.settle({ ok: true }));
  await api.waitForTelemetry();
});

// A run that cannot start is the one failure mode that would otherwise leave
// no trace at all, so the terminal guard reports before it throws.
test("a run with no TTY reports before throwing", async (t) => {
  process.env.CLOUD_SETUP_TELEMETRY = "enabled";
  process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(stateRoot, "notty-"));

  // Only our own endpoint is captured here: importing the UI module pulls in
  // Ink, which fetches a WASM module of its own.
  const sent = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (target, options) => {
    if (typeof target === "string" && target.startsWith(ENDPOINT)) {
      sent.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true });
    }
    return realFetch(target, options);
  });

  const shared = await import("../dist/ui/shared.js");
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  t.after(() => {
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
  });

  await assert.rejects(
    () => shared.requireInteractiveTerminal("frontend", stack),
    /frontend requires an interactive terminal/,
  );
  assert.equal(sent.length, 1, "the run is reported even though nothing ran");
  assert.equal(sent[0].outcome, "no_tty");
  assert.equal(sent[0].event, "finished_setup");
  assert.equal(sent[0].step, undefined);
});

test("a failed delivery does not reject or stall shutdown", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", (url, options) => {
    sent.push(JSON.parse(options.body));
    return Promise.reject(new Error("Network failure"));
  });
  const api = await telemetry();
  api.recordRun("frontend", stack, "error", 100);
  assert.equal(sent.length, 1);
  await api.waitForTelemetry();
});

test("shutdown remains bounded when a delivery never completes", async (t) => {
  captureSends(t);
  const api = await telemetry();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  api.recordRun("frontend", stack, "error", 100);
  const wait = api.waitForTelemetry();
  t.mock.timers.tick(1500);
  await wait;
});

test("disabled mode sends nothing, fetches no identity and writes no device ID", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("Unexpected HTTP request");
  });
  const home = fs.mkdtempSync(path.join(stateRoot, "disabled-"));
  const api = await telemetry("disabled", home);
  api.setStackIdentity(stack, 470494);
  api.recordStep("synthetics", stack, "gcx", { status: "ok" });
  api.recordRun("synthetics", stack, "ok", 100);
  await api.waitForTelemetry();
  assert.equal(fs.existsSync(path.join(home, "cloud-setup", "device-id")), false, "opting out must not persist an ID");
});

test("log mode prints the payload, sends nothing and creates no device ID", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("Unexpected HTTP request");
  });
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const home = fs.mkdtempSync(path.join(stateRoot, "log-"));
  const api = await telemetry("log", home);
  api.setStackIdentity(stack, 470494);
  api.recordRun("synthetics", stack, "ok", 100);
  await api.waitForTelemetry();

  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "[telemetry]");
  assert.equal(logs[0][1].outcome, "ok");
  assert.ok(logs[0][1].run_id);
  assert.equal(logs[0][1].device_id, undefined, "log mode never mints an install ID");
  assert.equal(fs.existsSync(path.join(home, "cloud-setup", "device-id")), false, "inspecting is not opting in");
});

test("DO_NOT_TRACK opts out, and an explicit mode overrides it", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("Unexpected HTTP request");
  });
  delete process.env.CLOUD_SETUP_TELEMETRY;
  process.env.DO_NOT_TRACK = "1";
  const optedOut = await import(`../dist/telemetry.js?test=${sequence++}`);
  optedOut.recordRun("frontend", stack, "ok", 1);
  await optedOut.waitForTelemetry();

  t.mock.restoreAll();
  const sent = captureSends(t);
  const overridden = await telemetry("enabled");
  overridden.recordRun("frontend", stack, "ok", 1);
  assert.equal(sent.length, 1, "CLOUD_SETUP_TELEMETRY=enabled wins over DO_NOT_TRACK");
  sent.forEach((s) => s.settle({ ok: true }));
  delete process.env.DO_NOT_TRACK;
});

// Running from a checkout reports nothing by default, since those runs would be
// indistinguishable from real ones in the data.
test("a source checkout is off by default but still overridable", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("Unexpected HTTP request");
  });
  delete process.env.CLOUD_SETUP_TELEMETRY;
  const offByDefault = await import(`../dist/telemetry.js?test=${sequence++}`);
  offByDefault.recordRun("frontend", stack, "ok", 1);
  await offByDefault.waitForTelemetry();

  t.mock.restoreAll();
  const sent = captureSends(t);
  const forced = await telemetry("enabled");
  forced.recordRun("frontend", stack, "ok", 1);
  assert.equal(sent.length, 1, "an explicit mode still wins");
  sent.forEach((s) => s.settle({ ok: true }));
});

test("an unrecognised mode disables telemetry rather than enabling it", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("Unexpected HTTP request");
  });
  const api = await telemetry("sure-why-not");
  api.recordRun("frontend", stack, "ok", 1);
  await api.waitForTelemetry();
});

test("the endpoint is overridable for development", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", (url, options) => {
    sent.push(url);
    assert.ok(JSON.parse(options.body));
    return Promise.resolve({ ok: true });
  });
  process.env.CLOUD_SETUP_TELEMETRY_ENDPOINT = "https://stats.grafana-dev.org/cloud-setup-usage-report";
  const api = await telemetry();
  api.recordRun("frontend", stack, "ok", 1);
  assert.deepEqual(sent, ["https://stats.grafana-dev.org/cloud-setup-usage-report"]);
  delete process.env.CLOUD_SETUP_TELEMETRY_ENDPOINT;
  await api.waitForTelemetry();
});

for (const [scenario, outcome, code, message, failedStep] of [
  ["frontend-success", "ok", 0, "Cool, we're done!"],
  ["frontend-partial", "incomplete", 1, "Needs router wiring", "instrument"],
  ["frontend-packages", "incomplete", 1, "registry unavailable", "instrument"],
  ["frontend-declined", "ok", 0, "Setup skipped."],
  ["synthetics-success", "ok", 0, "1 check created."],
  ["synthetics-alerts", "incomplete", 1, "alerts unavailable", "alerting"],
  ["synthetics-403", "error", 1, "Synthetic Monitoring write access", "create"],
])
  test(`${scenario}: rendered result, telemetry, and process exit agree`, () => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/wizard-outcome-process.mjs", import.meta.url)), scenario],
      {
        encoding: "utf8",
        timeout: 8000,
        env: { ...process.env, CLOUD_SETUP_TELEMETRY: "log", DO_NOT_TRACK: "0", NO_COLOR: "1" },
      },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, code, child.stderr + child.stdout);
    const output = stripVTControlCharacters(child.stdout);
    const events = output
      .split("\n")
      .filter((line) => line.startsWith("EVENT "))
      .map((line) => JSON.parse(line.slice(6)));
    const finished = events.filter((event) => event.event === "finished_setup");
    assert.equal(finished.length, 1, output);
    assert.equal(finished[0].outcome, outcome);
    assert.ok(output.includes(message), output);
    if (failedStep) {
      assert.ok(output.includes("Setup incomplete."), output);
      assert.ok(output.includes("Resolve the issue, then run"), output);
      assert.ok(events.some((event) => event.step === failedStep && event.status === "failed"));
      assert.ok(!output.includes("Cool, we're done!"));
    }
    if (scenario === "synthetics-alerts") {
      assert.deepEqual(
        events.filter((event) => event.step === "alerting").map((event) => event.status),
        ["failed", "ok"],
      );
      assert.ok(output.includes("2 checks created."), output);
      assert.equal(events.find((event) => event.step === "next-steps").status, "ok");
    }
    if (scenario === "synthetics-403") {
      assert.equal(child.stderr, "", "the CLI must not print the rendered failure again");
      assert.doesNotMatch(output, /plugin proxy|\{"message"/);
      assert.equal(events.filter((event) => event.step === "create").length, 1);
      assert.equal(
        events.some((event) => event.step === "alerting"),
        false,
      );
    }
    if (scenario === "frontend-declined") {
      assert.equal(events.find((event) => event.step === "pick-app").status, "declined");
      assert.equal(events.find((event) => event.step === "instrument").status, "skipped");
      assert.ok(!output.includes("Setup incomplete."));
    }
    if (scenario === "frontend-partial" || scenario === "frontend-packages") assert.ok(output.includes("src/main.tsx"));
    for (const event of events) {
      const serialized = JSON.stringify(event);
      assert.ok(!serialized.includes("example.com"));
      assert.ok(!serialized.includes("example/key"));
      assert.ok(!serialized.includes("unavailable"));
      assert.ok(!serialized.includes("Needs router wiring"));
    }
  });

for (const [scenario, failedStep, outcome] of [
  ["synthetics-crash", "create", "error"],
  ["synthetics-401", "create", "error"],
  ["synthetics-403", "create", "error"],
  ["synthetics-alerts", "alerting", "incomplete"],
  ["frontend-packages", "instrument", "incomplete"],
])
  test(`${scenario}: failed step and final outcome are delivered before exit`, () => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/wizard-outcome-process.mjs", import.meta.url)), scenario, "delayed"],
      {
        encoding: "utf8",
        timeout: 8000,
        env: {
          ...process.env,
          CLOUD_SETUP_TELEMETRY: "enabled",
          CLOUD_SETUP_TELEMETRY_ENDPOINT: "https://telemetry.invalid/cloud-setup-test",
          XDG_STATE_HOME: fs.mkdtempSync(path.join(stateRoot, "delivery-")),
          DO_NOT_TRACK: "0",
          NO_COLOR: "1",
        },
      },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 1, child.stderr + child.stdout);
    const output = stripVTControlCharacters(child.stdout);
    const delivered = output
      .split("\n")
      .filter((line) => line.startsWith("EVENT "))
      .map((line) => JSON.parse(line.slice(6)));
    const failures = delivered.filter(
      (event) => event.event === "completed_step" && event.step === failedStep && event.status === "failed",
    );
    const finished = delivered.filter((event) => event.event === "finished_setup");
    assert.equal(failures.length, 1, output);
    assert.equal(finished.length, 1, output);
    assert.equal(finished[0].outcome, outcome);
    assert.equal(new Set(delivered.map((event) => event.run_id)).size, 1);
    assert.ok(finished[0].duration_ms > 0);
    assert.ok(delivered.indexOf(failures[0]) > delivered.indexOf(finished[0]), "older step delivery was still pending");
    assert.equal(child.stderr, "", "rendered failures must not be printed again by cli.ts");
    assert.match(output, /Setup incomplete\./);
    if (outcome === "error") {
      assert.equal(delivered.filter((event) => event.step === failedStep).length, 1);
      assert.equal(
        delivered.some((event) => event.step === "alerting" || event.step === "next-steps"),
        false,
      );
    }
    assert.doesNotMatch(JSON.stringify(delivered), /check planning crashed|access denied|unavailable|example\.com/);
  });

test.after(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  assert.equal(fs.existsSync(deviceIdFile()), false);
});
