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
import { SmApiError } from "../dist/products/syntheticMonitoring/api.js";
import { AlertingApiError } from "../dist/products/syntheticMonitoring/notifications.js";

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
async function terminal(t, component, columns = 180) {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let output = "";
  let frame = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      output += text;
      if (stripVTControlCharacters(text).trim()) frame = text;
      callback();
    },
  });
  Object.assign(stdout, { columns, rows: 60, isTTY: true });
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
    frame: () => stripVTControlCharacters(frame),
    send: async (input) => {
      stdin.write(input);
      await sleep(50);
    },
  };
}

test("Synthetics accepts b and q in URL/token fields, then q finishes the menu", async (t) => {
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
  await term.send("\r");
  assert.match(term.output(), /Token:/);
  await term.send("bq");
  assert.equal(exits.length, 0);
  await term.send("\r");
  assert.equal(credentials[0].token, "bq");
  assert.equal(credentials[0].baseUrl, "bq");
  await term.send("n");
  assert.match(term.output(), /Next actions/);
  await term.send("q");
  assert.deepEqual(exits, [[undefined, "ok"]]);
});

for (const columns of [64, 120])
  for (const failure of ["creation", "alerting", "additional", "combined"])
    test(`Synthetics summarizes ${failure} failures in steps and explains them below the check count at ${columns} columns`, async (t) => {
      const exits = [];
      const alertingFailure = failure === "alerting" || failure === "combined";
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
          if (failure === "creation" || (failure === "additional" && payload.job === "third"))
            throw new SmApiError("POST check/add failed", 403, '{"message":"plugin proxy route access denied"}');
          return { id: payload.job === "first" ? 101 : 202 };
        },
        putCheckAlerts: async () => {
          if (failure === "combined")
            throw new SmApiError("PUT alerts failed", 403, '{"message":"plugin proxy route access denied"}');
        },
      };
      stub(t, syntheticsServices, {
        ensureAssistantAuth: async () => ({ stackId: 123 }),
        setStackIdentity() {},
        candidatesFor: async () => [candidate("first"), candidate("second")],
        aiEndpointCandidatesFor: async () => [candidate("third")],
        tryAutoSmSession: async () => ({ client, probes: [{ id: 1, name: "London" }] }),
        buildPlan: async (config) => ({
          actions: Object.keys(config).map((name) => ({ kind: "create", name, payload: { job: name } })),
        }),
        tryAlertingClient: async () => ({
          inspect: async () => ({ userEmail: "ops@example.com" }),
          ensureContactPoint: async () => {
            throw new AlertingApiError("POST contact-points failed", 403, '{"message":"Access denied"}');
          },
          ensureRoute: () => assert.fail("cannot route to a failed contact point"),
        }),
      });
      const term = await terminal(
        t,
        React.createElement(SyntheticsApp, {
          initialTargetUrl: "https://example.com",
          initialStackUrl: "https://example.grafana.net",
          forceGcxInstall: false,
          exit: (...args) => exits.push(args),
        }),
        columns,
      );
      await term.send("\r");
      await term.send("\r");
      await term.send("\r");
      if (alertingFailure) {
        await term.send("\r");
        await term.send("\r");
        await term.send("q");
      } else if (failure === "additional") {
        await term.send("n");
        await term.send("\r");
        await term.send("\r");
        await term.send(" ");
        await term.send("\r");
      }
      const frame = term.frame();
      const footerStart = frame.indexOf("\n Setup incomplete.");
      assert.ok(footerStart > 0, frame);
      const progress = frame.slice(0, footerStart);
      const footer = frame.slice(footerStart).replace(/\s+/g, " ");
      const step =
        failure === "creation"
          ? "Create synthetic checks"
          : alertingFailure
            ? "Configure alerts"
            : "Find additional synthetic checks";
      const lines = progress.split("\n");
      const row = lines.findIndex((line) => line.trim() === `✗ ${step}`);
      assert.ok(row >= 0, frame);
      const next = lines.findIndex((line, index) => index > row && (!line.trim() || /^ {2}\S/.test(line)));
      const details = lines.slice(row + 1, next < 0 ? undefined : next).filter((line) => line.trim());
      assert.ok(details.length > 0, frame);
      for (const line of details) assert.match(line, /^ {6}\S/, frame);
      const stepDetail = details.map((line) => line.trim()).join(" ");
      if (alertingFailure) assert.match(stepDetail, /Couldn't configure alerting contact points\./);
      else assert.match(stepDetail, /✗ (first|third) - London · failed/);
      assert.doesNotMatch(progress, /Permission denied|administrator|access denied/);
      assert.equal(
        frame.replace(/\s+/g, " ").match(/Permission denied\./g)?.length,
        failure === "combined" ? 2 : 1,
        frame,
      );
      assert.match(footer, /Setup incomplete\. Permission denied\./);
      assert.match(footer, /After resolving the issue, run `npx @grafana\/cloud-setup synthetics` again\./);
      assert.doesNotMatch(footer, /Review the failed steps|Couldn't configure/);
      for (const line of frame
        .slice(footerStart)
        .split("\n")
        .filter((line) => line.trim()))
        assert.match(line, /^ \S/, frame);
      if (alertingFailure) {
        assert.match(footer, /manage alerting contact points/);
        assert.match(footer, /https:\/\/example.grafana.net\/alerting\/notifications/);
        assert.doesNotMatch(progress, /alerting\/notifications/);
      }
      if (!alertingFailure || failure === "combined") assert.match(footer, /Synthetic Monitoring write access/);
      if (failure !== "creation") {
        assert.ok(progress.includes("2 checks created."), frame);
        assert.ok(progress.includes("View checks:"), frame);
        assert.doesNotMatch(footer, /checks created|View checks/);
      }
      assert.equal(exits.length, 1);
      if (alertingFailure) assert.deepEqual(exits[0], [undefined, "incomplete"]);
      else assert.ok(exits[0][0] instanceof Error);
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
