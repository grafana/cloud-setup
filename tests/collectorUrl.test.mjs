import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { render } from "ink";
import { validateSetupUrl } from "../dist/urls.js";
import { createFrontendController } from "../dist/ui/frontend/controller.js";
import { frontendServices } from "../dist/ui/frontend/services.js";
import { FrontendApp } from "../dist/ui/FrontendApp.js";
import { FrontendPrompts } from "../dist/ui/frontend/FrontendPrompts.js";

const invalidUrls = [
  "",
  " ",
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
    const result = validateSetupUrl(value, "collector");
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
    assert.deepEqual(validateSetupUrl(`  ${value}  `, "collector"), { url: value });
  });

test("collector URLs use the same HTTPS default and normalization as target URLs", () => {
  for (const [input, expected] of [
    [" collector.example/collect/key ", "https://collector.example/collect/key"],
    ["localhost:1234/collect/key", "https://localhost:1234/collect/key"],
    ["[::1]:1234/collect/key", "https://[::1]:1234/collect/key"],
    [
      "HTTPS://COLLECTOR.EXAMPLE/O'Reilly?key=a%2Fb&value=one+two",
      "https://collector.example/O'Reilly?key=a%2Fb&value=one+two",
    ],
    ["collector.example/collect/ключ", "https://collector.example/collect/%D0%BA%D0%BB%D1%8E%D1%87"],
  ]) {
    assert.deepEqual(validateSetupUrl(input, "collector"), { url: expected });
    assert.deepEqual(validateSetupUrl(input, "collector"), validateSetupUrl(input, "target"));
  }
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

  function Prompts() {
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return React.createElement(FrontendPrompts, { key: state.prompt, state, controller });
  }
  const term = await terminal(t, React.createElement(Prompts));
  // Control characters are filtered by the editor. The validator's newline
  // rejection is covered separately above.
  for (const value of invalidUrls.filter((value) => !value.includes("\n"))) {
    await term.send("\x15"); // Ctrl+U clears the current input.
    if (value) await term.send(value);
    await term.send("\r");
    const state = controller.getSnapshot();
    assert.equal(state.prompt, "collectorUrl");
    assert.ok(term.frame().includes(validateSetupUrl(value, "collector").error));
    assert.ok(term.frame().includes(`Faro collector URL: ${value}`.trimEnd()), JSON.stringify(value));
    assert.equal(state.instrumentation, undefined);
  }
  assert.equal(
    events.some(([step]) => step === "pick-app" || step === "instrument"),
    false,
  );
  await term.send("\x15");
  await term.send(" collector.example/O'Reilly?key=a%2Fb ");
  await term.send("\r");
  const state = controller.getSnapshot();
  assert.equal(state.prompt, "sampling");
  assert.equal(state.instrumentation.collectorUrl, "https://collector.example/O'Reilly?key=a%2Fb");
});

async function terminal(t, element) {
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
  const app = render(element, { stdin, stdout, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  t.after(() => app.unmount());
  await sleep(50);
  return {
    frame: () => frame,
    send: async (value) => {
      stdin.write(value);
      await sleep(50);
    },
  };
}

test("the collector prompt displays the validation error and keeps its value editable", async (t) => {
  for (const [key, value] of Object.entries(services())) t.mock.method(frontendServices, key, value);
  t.mock.method(globalThis, "fetch", () => assert.fail("collector entry must not make network requests"));
  const { send, frame } = await terminal(
    t,
    React.createElement(FrontendApp, {
      initialStackUrl: "https://example.grafana.net",
      forceGcxInstall: false,
      exit: () => assert.fail("invalid input must not exit setup"),
    }),
  );
  await send("\r");
  await send("n");
  await send("\r");
  await send("https:collector.example/key");
  await send("\r");
  assert.match(frame(), /Enter a valid HTTP or HTTPS URL/);
  assert.match(frame(), /Faro collector URL: https:collector.example\/key/);
  assert.doesNotMatch(frame(), /Session sampling rate/);
  // Repair the missing slashes using the input's cursor editing.
  for (let i = 0; i < "collector.example/key".length; i++) await send("\x1b[D");
  await send("//");
  await send("\r");
  assert.match(frame(), /Session sampling rate/);
  assert.doesNotMatch(frame(), /Enter a valid HTTP or HTTPS URL/);
});
