import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { render } from "ink";
import { validateCollectorUrl } from "../dist/urls.js";
import { createFrontendController } from "../dist/ui/frontend/controller.js";
import { frontendServices } from "../dist/ui/frontend/services.js";
import { FrontendApp } from "../dist/ui/FrontendApp.js";

const invalidUrls = [
  "",
  " ",
  "collector.example/key",
  "/collect/key",
  "//collector.example/key",
  "ftp://collector.example/key",
  "javascript:alert(1)",
  "https:collector.example/key",
  "https:/collector.example/key",
  "https:///collector.example/key",
  "https://",
  "https://collector.example:bad/key",
  "https://collector.example/has space",
  "https://collector.example/has\nnewline",
  "https://collector.example/back\\slash",
  "https://user:password@collector.example/key",
];
for (const value of invalidUrls)
  test(`rejects invalid collector URL ${JSON.stringify(value)}`, () => {
    const result = validateCollectorUrl(value);
    assert.ok(result.error);
    assert.equal(result.url, undefined);
  });

for (const value of [
  "https://collector.example/collect/abc",
  "http://localhost:1234/collect/key",
  "https://collector.example/O'Reilly?key=a%2Fb&value=one+two",
  "https://[::1]:1234/collect/key",
])
  test(`preserves valid collector URL ${value}`, () => {
    assert.deepEqual(validateCollectorUrl(`  ${value}  `), { url: value });
  });

const tick = () => new Promise((resolve) => setImmediate(resolve));
function services() {
  return {
    ...frontendServices,
    sleep: async () => {},
    checkNodeVersion() {},
    isGcxInstalled: () => true,
    startFakeProgress: () => ({ finish: async () => {}, stop() {}, pause() {}, resume() {} }),
    detectFrontendTarget: () => ({ kind: "javascript", file: "src/main.js" }),
    detectEnvironmentExpr: () => "process.env.NODE_ENV",
    readPkgName: () => "demo",
    readPkgVersion: () => "1.0.0",
    tryFaroClient: () => assert.fail("declined sign-in must not be retried"),
    openFrontendO11ySetupPage() {},
    insertFaroSnippet: () => assert.fail("must not edit before completing configuration"),
    installFaroPackages: () => assert.fail("must not install before completing configuration"),
  };
}

test("invalid collector submissions keep the workflow at the prompt until corrected", async (t) => {
  const events = [];
  const controller = createFrontendController(
    { cwd: "/project", stackUrl: "https://example.grafana.net", forceGcxInstall: false },
    services(),
    (...event) => events.push(event),
  );
  t.after(() => controller.dispose());
  controller.start();
  await tick();
  controller.answer("authenticate", false);
  await tick();
  controller.answer("createApp", true);
  await tick();
  for (const value of invalidUrls) {
    controller.answer("collectorUrl", value);
    await tick();
    const state = controller.getSnapshot();
    assert.equal(state.prompt, "collectorUrl");
    assert.equal(state.collectorUrlInput.value, value);
    assert.ok(state.collectorUrlInput.error);
    assert.equal(state.instrumentation, undefined);
  }
  assert.equal(
    events.some(([step]) => step === "pick-app" || step === "instrument"),
    false,
  );
  controller.answer("collectorUrl", " https://collector.example/O'Reilly?key=a%2Fb ");
  await tick();
  const state = controller.getSnapshot();
  assert.equal(state.prompt, "sampling");
  assert.equal(state.collectorUrlInput.error, undefined);
  assert.equal(state.instrumentation.collectorUrl, "https://collector.example/O'Reilly?key=a%2Fb");
});

test("the collector prompt displays the validation error and keeps its value editable", async (t) => {
  for (const [key, value] of Object.entries(services())) t.mock.method(frontendServices, key, value);
  t.mock.method(globalThis, "fetch", () => assert.fail("collector entry must not make network requests"));
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
  Object.assign(stdout, { columns: 120, rows: 60, isTTY: true });
  const app = render(
    React.createElement(FrontendApp, {
      cwd: "/project",
      initialStackUrl: "https://example.grafana.net",
      forceGcxInstall: false,
      exit: () => assert.fail("invalid input must not exit setup"),
    }),
    { stdin, stdout, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  t.after(() => app.unmount());
  const send = async (value) => {
    stdin.write(value);
    await sleep(50);
  };
  await sleep(50);
  await send("\r");
  await send("n");
  await send("\r");
  await send("https:collector.example/key");
  await send("\r");
  assert.match(frame, /Enter a valid Faro collector URL starting with http:\/\/ or https:\/\//);
  assert.match(frame, /Faro collector URL: https:collector.example\/key/);
  assert.doesNotMatch(frame, /Session sampling rate/);
  // Repair the missing slashes using the input's cursor editing.
  for (let i = 0; i < "collector.example/key".length; i++) await send("\x1b[D");
  await send("//");
  await send("\r");
  assert.match(frame, /Session sampling rate/);
  assert.doesNotMatch(frame, /Enter a valid Faro collector URL/);
});
