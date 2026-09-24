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

const scenario = process.argv[2];
const command = scenario.startsWith("synthetics") ? "synthetics" : "frontend";
const stackUrl = "https://example.grafana.net";
// Exercise the actual telemetry and exit code. Log mode avoids transport and
// device ID writes, and only product/environment operations are substituted.
const originalError = console.error;
console.error = (prefix, ...args) => {
  if (prefix === "[telemetry]") writeSync(1, `\nEVENT ${JSON.stringify(args[0])}\n`);
  else originalError(prefix, ...args);
};
mock.method(globalThis, "fetch", () => assert.fail("Outcome tests must not make network requests"));
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
  createCheck: async (payload) => ({ id: payload.job === "first" ? 101 : 202 }),
  putCheckAlerts: async (id) => {
    if (scenario === "synthetics-alerts" && id === 101) throw new Error("alerts unavailable");
  },
};
Object.assign(syntheticsServices, common, {
  ensureAssistantAuth: async () => ({ stackId: "123" }),
  getSkillStatus: async () => ({ installed: true }),
  candidatesFor: async () => [candidate("first")],
  aiEndpointCandidatesFor: async () => [candidate("second")],
  tryAutoSmSession: async () => ({ client, probes: [{ id: 1, name: "London" }] }),
  buildPlan: async (config) => ({
    actions: Object.keys(config).map((name) => ({ kind: "create", name, payload: { job: name } })),
  }),
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
render(React.createElement(App), {
  stdin,
  stdout,
  stderr: stdout,
  debug: true,
  patchConsole: false,
  exitOnCtrlC: false,
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
    await answer("\r", "Session sampling rate");
    await answer("\r", "Enable Session Replay");
    await answer("n");
  }
} else {
  await answer("\r", "These are the synthetic checks");
  await answer("\r", "Alert on");
  await answer("n", "Next actions");
  if (scenario === "synthetics-alerts") {
    await answer("\r", "Open a real browser");
    await answer("\r", "These are the additional synthetic checks");
    await answer(" ", "[x] second");
    await answer("\r", "Next actions");
    // The later alerting pass succeeds. Next actions still has
    // "Configure agent skills" left (getSkillStatus above reports no path,
    // so it logs as failed but doesn't affect the run's outcome) — picking
    // it is what actually empties the menu and finishes it.
    await answer("\r", "Next actions");
    await answer("\r");
  } else await answer("q");
}
