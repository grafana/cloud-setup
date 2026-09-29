import assert from "node:assert/strict";
import { test } from "node:test";
import { createFrontendController } from "../dist/ui/frontend/controller.js";
import { frontendServices } from "../dist/ui/frontend/services.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides = {}) {
  const services = {
    ...frontendServices,
    sleep: async () => {},
    checkNodeVersion() {},
    isGcxInstalled: () => true,
    startFakeProgress: () => ({ finish: async () => {}, stop() {}, pause() {}, resume() {} }),
    detectFrontendTarget: () => ({ kind: "react", file: "src/main.tsx" }),
    detectEnvironmentExpr: () => undefined,
    readPkgName: () => "demo",
    readPkgVersion: () => undefined,
    tryFaroClient: () => assert.fail("declined sign-in must not be retried"),
    openFrontendO11ySetupPage() {},
    instrumentReact: async () => ({ entryFile: "src/main.tsx", complete: true }),
    installFaroPackages: async () => {},
    ...overrides,
  };
  const controller = createFrontendController(
    { stackUrl: "https://example.grafana.net", forceGcxInstall: false, cwd: "/project" },
    services,
    () => {},
  );
  return { controller };
}

test("session replay isn't shown enabled with a masking level before masking is actually answered", async () => {
  const { controller } = setup();
  controller.start();
  await tick();
  controller.answer("authenticate", false);
  await tick();
  assert.equal(controller.getSnapshot().prompt, "createApp");
  controller.answer("createApp", true);
  await tick();
  assert.equal(controller.getSnapshot().prompt, "collectorUrl");
  controller.answer("collectorUrl", "https://collector.example/abc");
  await tick();
  assert.equal(controller.getSnapshot().prompt, "defaults");
  controller.answer("defaults", false);
  await tick();
  assert.equal(controller.getSnapshot().prompt, "sampling");
  controller.answer("sampling", "100");
  await tick();
  assert.equal(controller.getSnapshot().prompt, "replay");
  controller.answer("replay", true);
  await tick();
  // Right after answering "replay" (yes), sessionReplay is enabled right
  // away — but replayMaskingKnown must stay false until "masking" is
  // actually answered, or the detail line would render the masking level
  // still held in its placeholder default ("balanced") as if chosen.
  assert.equal(controller.getSnapshot().prompt, "masking");
  assert.equal(controller.getSnapshot().instrumentation.sessionReplay, true);
  assert.equal(controller.getSnapshot().replayMaskingKnown, false);
  controller.answer("masking", "strict");
  await tick();
  assert.equal(controller.getSnapshot().instrumentation.sessionReplay, true);
  assert.equal(controller.getSnapshot().instrumentation.replayMasking, "strict");
  assert.equal(controller.getSnapshot().replayMaskingKnown, true);
  controller.dispose();
});

test("accepting recommended defaults skips the sampling/replay/masking questions", async () => {
  const { controller } = setup();
  controller.start();
  await tick();
  controller.answer("authenticate", false);
  await tick();
  controller.answer("createApp", true);
  await tick();
  controller.answer("collectorUrl", "https://collector.example/abc");
  await tick();
  assert.equal(controller.getSnapshot().prompt, "defaults");
  controller.answer("defaults", true);
  await tick();
  assert.equal(controller.getSnapshot().prompt, undefined);
  const state = controller.getSnapshot();
  assert.equal(state.instrumentation.samplingRate, 1);
  assert.equal(state.instrumentation.sessionReplay, true);
  assert.equal(state.instrumentation.replayMasking, "balanced");
  assert.equal(state.samplingKnown, true);
  assert.equal(state.replayKnown, true);
  assert.equal(state.replayMaskingKnown, true);
  assert.equal(state.results["pick-app"].used_defaults, true);
  controller.dispose();
});
