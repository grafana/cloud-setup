import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import React from "react";
import { render } from "ink";
import { SyntheticsApp } from "../dist/ui/SyntheticsApp.js";
import { FrontendApp } from "../dist/ui/FrontendApp.js";
import { syntheticsServices } from "../dist/ui/synthetics/services.js";
import { frontendServices } from "../dist/ui/frontend/services.js";

function stub(t, services, overrides) {
  const defaults = {
    sleep: async () => {},
    checkNodeVersion() {},
    isGcxInstalled: () => true,
    startFakeProgress: () => ({ finish: async () => {}, stop() {}, pause() {}, resume() {} }),
  };
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) t.mock.method(services, key, value);
  t.mock.method(globalThis, "fetch", () => assert.fail("UI tests must not make network requests"));
}
async function terminal(t, component) {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  Object.assign(stdout, { columns: 180, rows: 60, isTTY: true });
  const app = render(component, {
    stdin,
    stdout,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  t.after(() => app.unmount());
  await sleep(50);
  return {
    output: () => stripVTControlCharacters(output),
    send: async (input) => {
      stdin.write(input);
      await sleep(50);
    },
  };
}

test("Synthetics accepts b and q in URL/token fields, supports Esc back, then q finishes the menu", async (t) => {
  const exits = [];
  const credentials = [];
  const client = {
    listProbes: async () => [{ id: 1, name: "London" }],
    createCheck: async () => ({ id: 42 }),
    putCheckAlerts: async () => {},
  };
  stub(t, syntheticsServices, {
    getSkillStatus: async () => ({ installed: true }),
    candidatesFor: async () => [
      {
        key: "uptime",
        label: "uptime",
        title: "Uptime",
        description: "Availability",
        target: "https://example.com",
        frequencyMs: 60000,
        probeCount: 1,
        settings: { http: {} },
        selectedByDefault: true,
      },
    ],
    tryAutoSmSession: () => assert.fail("declined sign-in must not be retried"),
    probeReachable: async () => {},
    createClient: () => client,
    writeCredentials: async (value) => {
      credentials.push(value);
    },
    buildPlan: async () => ({ actions: [{ kind: "create", name: "uptime", payload: {} }] }),
  });
  const term = await terminal(
    t,
    React.createElement(SyntheticsApp, {
      initialTargetUrl: "https://example.com",
      initialStackUrl: "https://example.grafana.net",
      forceGcxInstall: false,
      exit: (...args) => exits.push(args),
    }),
  );
  await term.send("\r");
  await term.send("n");
  await term.send("\r");
  assert.match(term.output(), /Synthetic Monitoring API URL:/);
  await term.send("bq");
  assert.match(term.output(), /Synthetic Monitoring API URL: bq/);
  assert.equal(exits.length, 0);
  await term.send("\x1b");
  await term.send("\r");
  await term.send("https://bq.example");
  await term.send("\r");
  assert.match(term.output(), /Token:/);
  await term.send("bq");
  assert.equal(exits.length, 0);
  await term.send("\x1b");
  await term.send("\r");
  await term.send("token-bq");
  await term.send("\r");
  assert.equal(credentials[0].token, "token-bq");
  assert.equal(credentials[0].baseUrl, "https://bq.example");
  await term.send("n");
  assert.match(term.output(), /Next actions/);
  await term.send("q");
  assert.deepEqual(exits, [[undefined, "ok"]]);
});

test("Frontend renders partial instrumentation as incomplete even when a file was written", async (t) => {
  const exits = [];
  stub(t, frontendServices, {
    detectFrontendTarget: () => ({ kind: "react", file: "src/main.tsx" }),
    detectEnvironmentExpr: () => undefined,
    readPkgName: () => "demo",
    readPkgVersion: () => undefined,
    tryFaroClient: () => assert.fail("declined sign-in must not be retried"),
    openFrontendO11ySetupPage() {},
    instrumentReact: async () => ({ entryFile: "src/main.tsx", complete: false, detail: "Needs manual wiring" }),
    installFaroPackages: async () => {},
  });
  const term = await terminal(
    t,
    React.createElement(FrontendApp, {
      initialStackUrl: "https://example.grafana.net",
      forceGcxInstall: false,
      exit: (...args) => exits.push(args),
    }),
  );
  await term.send("\r");
  await term.send("n");
  await term.send("\r");
  await term.send("https://collector.example/bq");
  await term.send("\r");
  await term.send("\r");
  await term.send("n");
  assert.match(term.output(), /Setup incomplete\./);
  assert.match(term.output(), /Needs manual wiring/);
  assert.doesNotMatch(term.output(), /Cool, we're done!/);
  assert.deepEqual(exits, [[undefined, "incomplete"]]);
});
