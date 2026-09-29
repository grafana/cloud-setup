import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import React from "react";
import { render } from "ink";
import { GCX_INSTALL_COMMAND } from "../dist/gcx.js";
import { FrontendApp } from "../dist/ui/FrontendApp.js";
import { SyntheticsApp } from "../dist/ui/SyntheticsApp.js";
import { frontendServices } from "../dist/ui/frontend/services.js";
import { syntheticsServices } from "../dist/ui/synthetics/services.js";

async function terminal(t, component, columns) {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let frame = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      const text = stripVTControlCharacters(chunk.toString());
      if (text.trim()) frame = text;
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
    frame: () => frame,
    send: async (input) => {
      stdin.write(input);
      await sleep(50);
    },
  };
}

const frontend = {
  App: FrontendApp,
  services: frontendServices,
  overrides: {
    detectFrontendTarget: () => ({ kind: "react", file: "src/main.tsx" }),
    detectEnvironmentExpr: () => undefined,
    readPkgVersion: () => undefined,
    tryFaroClient: async () => ({
      list: async () => [
        { name: "demo", id: "1", collectEndpointURL: "https://collector.example", appKey: "test-key" },
      ],
    }),
    instrumentReact: async () => ({ entryFile: "src/main.tsx", complete: true }),
    installFaroPackages: async () => {},
  },
  finish: async (term) => {
    assert.match(term.frame(), /Which Frontend Observability app do you want to use\?/);
    await term.send("\r");
    assert.match(term.frame(), /Use recommended defaults/);
    await term.send("n");
    assert.match(term.frame(), /Session sampling rate/);
    await term.send("\r");
    await term.send("n");
    assert.match(term.frame(), /Cool, we're done!/);
  },
};

const synthetics = {
  App: SyntheticsApp,
  services: syntheticsServices,
  overrides: {
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
    tryAutoSmSession: async () => ({
      apiUrl: "https://sm.example",
      client: { createCheck: async () => ({ id: 42 }), putCheckAlerts: async () => {} },
      probes: [{ id: 1, name: "London" }],
    }),
    buildPlan: async () => ({ actions: [{ kind: "create", name: "uptime", payload: {} }] }),
  },
  finish: async (term) => {
    assert.match(term.frame(), /Uptime/);
    await term.send("\r");
    await term.send("n");
    await term.send("q");
    assert.match(term.frame(), /1 check created/);
  },
};

for (const [name, flow] of Object.entries({ Frontend: frontend, Synthetics: synthetics }))
  for (const installation of ["failed", "successful", "declined", "already installed"])
    for (const columns of installation === "failed" ? [64, 120] : [120])
      test(`${name} keeps gcx ${installation} status and retry guidance at ${columns} columns`, async (t) => {
        const exits = [];
        const overrides = {
          ...flow.overrides,
          sleep: async () => {},
          checkNodeVersion() {},
          isGcxInstalled: () => installation === "already installed",
          installGcx: async () => {
            assert.ok(installation === "failed" || installation === "successful");
            if (installation === "failed") throw new Error("Could not download gcx: connection refused");
          },
          ensureAssistantAuth: async () => ({ stackId: 123 }),
          setStackIdentity() {},
          startFakeProgress: () => ({ finish: async () => {}, stop() {} }),
        };
        for (const [key, value] of Object.entries(overrides)) t.mock.method(flow.services, key, value);
        t.mock.method(globalThis, "fetch", () => assert.fail("UI tests must not make network requests"));
        const term = await terminal(
          t,
          React.createElement(flow.App, {
            initialTargetUrl: "https://example.com",
            initialStackUrl: "https://example.grafana.net",
            forceGcxInstall: false,
            exit: (...args) => exits.push(args),
          }),
          columns,
        );
        await term.send("\r");
        if (installation !== "already installed") {
          assert.match(term.frame(), /gcx isn't installed\. Install it now\?/);
          assert.ok(term.frame().replace(/\s/g, "").includes(GCX_INSTALL_COMMAND.replace(/\s/g, "")));
          await term.send(installation === "declined" ? "n" : "\r");
        }
        assert.match(term.frame(), /Sign in to Grafana Cloud using your browser\?/);
        const afterInstall = term.frame();
        await term.send("\r");
        await flow.finish(term);
        assert.deepEqual(exits, [[undefined, "ok"]]);
        for (const frame of [afterInstall, term.frame()]) {
          const icon = installation === "failed" ? "✗" : installation === "declined" ? "=" : "✓";
          assert.ok(frame.includes(`${icon} Install Grafana Cloud CLI (gcx)`), frame);
          if (installation === "failed") {
            const lines = frame.split("\n");
            const start = lines.findIndex((line) => line.includes("Install Grafana Cloud CLI (gcx)"));
            const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
            assert.ok(end > start + 1, frame);
            const details = lines.slice(start + 1, end);
            for (const line of details) {
              assert.match(line, /^ {6}\S/, `detail and continuation lines must share indentation: ${line}`);
              assert.ok(line.length <= columns, line);
            }
            assert.equal(details[0], "      Could not download gcx: connection refused");
            // Wrapping can split the command's URL, so compare its content
            // after removing indentation and line boundaries.
            const retry = details
              .slice(1)
              .map((line) => line.trim())
              .join("")
              .replace(/\s/g, "");
            assert.equal(retry, `Retry later: ${GCX_INSTALL_COMMAND}`.replace(/\s/g, ""));
            if (columns === 64) assert.ok(details.length > 2, "the retry command must wrap");
          } else {
            assert.doesNotMatch(frame, /Retry later|Could not download gcx/);
            assert.ok(!frame.includes(GCX_INSTALL_COMMAND), frame);
          }
        }
      });
