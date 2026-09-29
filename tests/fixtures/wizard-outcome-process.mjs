import assert from "node:assert/strict";
import { mock } from "node:test";
import { writeSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import React from "react";
import { render } from "ink";
import { FrontendApp } from "../../dist/ui/FrontendApp.js";
import { SyntheticsApp } from "../../dist/ui/SyntheticsApp.js";
import { frontendServices } from "../../dist/ui/frontend/services.js";
import { syntheticsServices } from "../../dist/ui/synthetics/services.js";
import { useHardExit } from "../../dist/ui/shared.js";
import { SmApiError } from "../../dist/products/syntheticMonitoring/api.js";

const scenario = process.argv[2];
const delayedDelivery = process.argv[3] === "delayed";
const creationCrash = ["synthetics-crash", "synthetics-401", "synthetics-403"].includes(scenario);
const command = scenario.startsWith("synthetics") ? "synthetics" : "frontend";
const stackUrl = "https://example.grafana.net";
// Exercise the actual telemetry and exit code. Log mode records emissions.
// Delayed mode records transport completions so early process.exit loses them.
const originalError = console.error;
console.error = (prefix, ...args) => {
  if (prefix === "[telemetry]") writeSync(1, `\nEVENT ${JSON.stringify(args[0])}\n`);
  else originalError(prefix, ...args);
};
const finishedDelivery = Promise.withResolvers();
mock.method(globalThis, "fetch", async (url, options) => {
  assert.ok(delayedDelivery, "Log-mode tests must not make network requests");
  assert.equal(url, "https://telemetry.invalid/cloud-setup-test");
  assert.equal(options.method, "POST");
  const payload = JSON.parse(options.body);
  // Hold failures until the final event has arrived. This also catches waiting
  // for only the newest request instead of every pending step event.
  if (payload.event === "completed_step" && payload.status === "failed") await finishedDelivery.promise;
  await sleep(30);
  writeSync(1, `\nEVENT ${JSON.stringify(payload)}\n`);
  if (payload.event === "finished_setup") finishedDelivery.resolve();
  return { ok: true };
});
const common = {
  sleep: async () => {},
  checkNodeVersion() {},
  isGcxInstalled: () => true,
  startFakeProgress: () => ({ finish: async () => {}, stop() {}, pause() {}, resume() {} }),
};
Object.assign(frontendServices, common, {
  detectFrontendTarget: () => ({ kind: "react", file: "src/main.tsx" }),
  detectEnvironmentExpr: () => undefined,
  readPkgName: () => "demo",
  readPkgVersion: () => undefined,
  tryFaroClient: () => assert.fail("sign-in was declined"),
  openFrontendO11ySetupPage() {},
  instrumentReact: async () => ({
    entryFile: "src/main.tsx",
    complete: scenario !== "frontend-partial",
    detail: "Needs router wiring",
  }),
  installFaroPackages: async () => {
    if (scenario === "frontend-packages") throw new Error("registry unavailable");
  },
});
const candidate = (key) => ({
  key,
  label: key,
  title: key,
  description: "Availability",
  target: `https://example.com/${key}`,
  frequencyMs: 60000,
  probeCount: 1,
  settings: { http: {} },
  selectedByDefault: true,
});
const client = {
  createCheck: async (payload) => {
    if (scenario === "synthetics-401" || scenario === "synthetics-403") {
      const status = Number(scenario.slice(-3));
      throw new SmApiError(
        `POST check/add failed with status ${status}`,
        status,
        '{"message":"plugin proxy route access denied"}',
      );
    }
    return { id: payload.job === "first" ? 101 : 202 };
  },
  putCheckAlerts: async (id) => {
    if (scenario === "synthetics-alerts" && id === 101) throw new Error("alerts unavailable");
  },
};
Object.assign(syntheticsServices, common, {
  ensureAssistantAuth: async () => ({ stackId: 123 }),
  getSkillStatus: async () => ({ installed: true }),
  candidatesFor: async () => [candidate("first")],
  aiEndpointCandidatesFor: async () => [candidate("second")],
  tryAutoSmSession: async () => ({ client, probes: [{ id: 1, name: "London" }] }),
  buildPlan: async (config) => {
    if (scenario === "synthetics-crash") throw new Error("check planning crashed");
    return { actions: Object.keys(config).map((name) => ({ kind: "create", name, payload: { job: name } })) };
  },
  writeTerraformExport: async () => "/project/terraform",
});
const stdin = new PassThrough();
Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let output = "";
const stdout = new Writable({
  write(chunk, _encoding, callback) {
    output += chunk.toString();
    writeSync(1, chunk);
    callback();
  },
});
Object.assign(stdout, { columns: 180, rows: 60, isTTY: true });
function App() {
  const exit = useHardExit(command, stackUrl);
  return React.createElement(command === "frontend" ? FrontendApp : SyntheticsApp, {
    initialStackUrl: stackUrl,
    initialTargetUrl: "https://example.com",
    forceGcxInstall: false,
    exit,
  });
}
const app = render(React.createElement(App), {
  stdin,
  stdout,
  stderr: stdout,
  debug: true,
  patchConsole: false,
  exitOnCtrlC: false,
});
// Mirror cli.ts: an Ink rejection prints the error and exits immediately,
// bypassing the telemetry wait in useHardExit.
void app.waitUntilExit().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
// Open work must not keep the process alive after completion.
setInterval(() => {}, 1000);
async function waitFor(text, from = 0) {
  const deadline = Date.now() + 2000;
  while (!output.slice(from).includes(text)) {
    if (Date.now() > deadline) throw new Error(`Wizard never displayed ${text}`);
    await sleep(10);
  }
  // Let Ink install the current prompt's input handler after rendering.
  await sleep(20);
}
async function answer(input, nextText) {
  const from = output.length;
  stdin.write(input);
  if (nextText) await waitFor(nextText, from);
}
await waitFor("Let's set up");
await answer("\r", "Sign in to Grafana Cloud");
if (command === "frontend") {
  await answer("n", "No existing app found");
  if (scenario === "frontend-declined") await answer("n");
  else {
    await answer("\r", "Faro collector URL:");
    await answer("https://collector.example/key", "https://collector.example/key");
    await answer("\r", "Use recommended defaults");
    await answer("n", "Session sampling rate");
    await answer("\r", "Enable Session Replay");
    await answer("n");
  }
} else {
  await answer("\r", "These are the synthetic checks");
  if (creationCrash) {
    await answer("\r");
  } else {
    await answer("\r", "Alert on");
    await answer("n", "Next actions");
    if (scenario === "synthetics-alerts") {
      await answer("\r", "Open a real browser");
      await answer("\r", "These are the additional synthetic checks");
      await answer(" ", "[x] second");
      await answer("\r", "Next actions");
      // The later alerting pass succeeds. Next actions still has
      // "Configure agent skills" left (getSkillStatus above reports no path,
      // so it logs as failed but doesn't affect the run's outcome) - picking
      // it is what actually empties the menu and finishes it.
      await answer("\r", "Next actions");
      await answer("\r");
    } else await answer("q");
  }
}
