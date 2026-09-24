import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowController } from "../dist/ui/workflow/controller.js";
import { createFrontendController } from "../dist/ui/frontend/controller.js";
import { frontendServices } from "../dist/ui/frontend/services.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const initial = {
  currentStep: "edit",
  started: false,
  completed: new Set(),
  results: {},
  failedSteps: new Set(),
  done: false,
  outcome: "incomplete",
};

test("restart cancels a pending prompt and ignores a late operation from the previous attempt", async () => {
  const deferred = Promise.withResolvers();
  const events = [];
  let attempts = 0;
  const controller = new WorkflowController(
    initial,
    {
      edit: async (ctx) => {
        const attempt = ++attempts;
        await ctx.ask("confirm");
        if (attempt === 1) await ctx.wait(deferred.promise);
        ctx.update({ outcome: "ok", attempt });
        return { next: "done", properties: { status: "ok" } };
      },
    },
    (...event) => events.push(event),
    ["edit"],
  );
  controller.start();
  controller.answer("confirm", true);
  await tick();
  controller.restart("edit");
  controller.answer("wrongPrompt", true);
  assert.equal(controller.getSnapshot().prompt, "confirm");
  controller.answer("confirm", true);
  await tick();
  deferred.resolve();
  await tick();
  assert.equal(controller.getSnapshot().attempt, 2);
  assert.equal(controller.getSnapshot().done, true);
  assert.equal(events.length, 1);
});

test("disposing a controller cancels its outstanding question without reporting an error", async () => {
  const controller = new WorkflowController(
    initial,
    {
      edit: async (ctx) => {
        await ctx.ask("confirm");
        assert.fail("disposed questions must not resume");
      },
    },
    () => assert.fail("cancelled steps must not report completion"),
    ["edit"],
  );
  controller.start();
  controller.dispose();
  controller.answer("confirm", true);
  await tick();
  assert.equal(controller.getSnapshot().failureSummary, undefined);
});

function frontend(overrides = {}) {
  const events = [];
  const services = {
    ...frontendServices,
    sleep: async () => {},
    checkNodeVersion() {},
    isGcxInstalled: () => true,
    startFakeProgress: () => ({ finish: async () => {}, stop() {}, pause() {}, resume() {} }),
    detectFrontendTarget: () => ({ kind: "react", file: "src/main.tsx" }),
    detectEnvironmentExpr: () => undefined,
    readPkgVersion: () => undefined,
    readPkgName: () => "demo",
    openFrontendO11ySetupPage() {},
    tryFaroClient: () => assert.fail("declined auth must not be retried"),
    instrumentReact: async () => ({ entryFile: "src/main.tsx", complete: true }),
    installFaroPackages: async () => {},
    ...overrides,
  };
  const controller = createFrontendController(
    { stackUrl: "https://example.grafana.net", cwd: "/project", forceGcxInstall: false },
    services,
    (...event) => events.push(event),
  );
  return { controller, events };
}
async function configure(controller) {
  controller.start();
  await tick();
  controller.answer("authenticate", false);
  await tick();
  assert.equal(controller.getSnapshot().prompt, "createApp");
  controller.answer("createApp", true);
  await tick();
  controller.answer("collectorUrl", "https://collector.example/key");
  await tick();
  controller.answer("sampling", "25%");
  await tick();
  controller.answer("replay", true);
  await tick();
  controller.answer("masking", "strict");
  await tick();
}

test("manual setup respects declined authentication and records app configuration", async () => {
  const { controller, events } = frontend();
  await configure(controller);
  assert.equal(controller.getSnapshot().outcome, "ok");
  const picked = events.find(([step]) => step === "pick-app")[1];
  assert.deepEqual(picked, {
    status: "ok",
    app_resolution: "manual",
    sampling_rate: 25,
    session_replay: true,
    replay_masking: "strict",
  });
});

for (const [name, overrides] of [
  [
    "incomplete wiring",
    { instrumentReact: async () => ({ entryFile: "src/main.tsx", complete: false, detail: "Needs wiring" }) },
  ],
  [
    "package install failure",
    {
      installFaroPackages: async () => {
        throw new Error("install failed");
      },
    },
  ],
])
  test(`${name} retains the file result but does not report success`, async () => {
    const { controller, events } = frontend(overrides);
    await configure(controller);
    assert.equal(controller.getSnapshot().done, true);
    assert.equal(controller.getSnapshot().outcome, "incomplete");
    assert.equal(controller.getSnapshot().instrumentedFile, "src/main.tsx");
    assert.equal(events.at(-1)[1].status, "failed");
    assert.ok(controller.getSnapshot().error);
  });

test("failed gcx installation reports failure and still permits the next step", async () => {
  const { controller, events } = frontend({
    isGcxInstalled: () => false,
    installGcx: async () => {
      throw new Error("install failed");
    },
  });
  controller.start();
  await tick();
  controller.answer("install", true);
  await tick();
  assert.deepEqual(events[0], ["gcx", { status: "failed", already_installed: false, install_declined: false }]);
  assert.equal(controller.getSnapshot().prompt, "authenticate");
  assert.equal(controller.getSnapshot().gcx.error, "install failed");
  controller.dispose();
});

test("aborted sign-in ignores late credentials and does not retry app lookup", async () => {
  const deferred = Promise.withResolvers();
  const { controller, events } = frontend({
    ensureAssistantAuth: () => deferred.promise,
    setStackIdentity: () => assert.fail("late identity must not be applied"),
  });
  controller.start();
  await tick();
  controller.answer("authenticate", true);
  await tick();
  controller.answer("abortAuth", true);
  await tick();
  assert.equal(controller.getSnapshot().prompt, "createApp");
  deferred.resolve({ stackId: "stale" });
  await tick();
  assert.deepEqual(events.find(([step]) => step === "auth")[1], { status: "aborted", auth_outcome: "aborted" });
  controller.dispose();
});

test("a failed file edit does not claim packages were installed", async () => {
  const { controller, events } = frontend({
    instrumentReact: async () => {
      throw new Error("edit failed");
    },
    installFaroPackages: () => assert.fail("must not install after failed edit"),
  });
  await configure(controller);
  assert.equal(controller.getSnapshot().outcome, "incomplete");
  assert.equal(events.at(-1)[1].status, "failed");
  assert.equal(events.at(-1)[1].package_install, undefined);
});

test("declining app creation deliberately skips setup without a failure", async () => {
  const { controller, events } = frontend();
  controller.start();
  await tick();
  controller.answer("authenticate", false);
  await tick();
  controller.answer("createApp", false);
  await tick();
  assert.equal(controller.getSnapshot().done, true);
  assert.equal(controller.getSnapshot().outcome, "ok");
  assert.equal(controller.getSnapshot().failedSteps.size, 0);
  assert.equal(events.find(([step]) => step === "pick-app")[1].status, "declined");
  assert.equal(events.at(-1)[1].status, "skipped");
});

test("failed app resolution remains incomplete when instrumentation is skipped", async () => {
  const { controller, events } = frontend({
    openFrontendO11ySetupPage: () => {
      throw new Error("cannot open setup");
    },
  });
  controller.start();
  await tick();
  controller.answer("authenticate", false);
  await tick();
  controller.answer("createApp", true);
  await tick();
  assert.equal(controller.getSnapshot().outcome, "incomplete");
  assert.deepEqual([...controller.getSnapshot().failedSteps], ["pick-app"]);
  assert.equal(events.at(-1)[1].status, "skipped");
});

test("unsupported projects record a failed step and error outcome", async () => {
  const { controller, events } = frontend({ detectFrontendTarget: () => ({ kind: "unsupported" }) });
  controller.start();
  await tick();
  controller.answer("authenticate", false);
  await tick();
  assert.equal(controller.getSnapshot().outcome, "error");
  assert.match(controller.getSnapshot().failureSummary, /supported/);
  assert.deepEqual(events.at(-1), ["pick-app", { status: "failed" }]);
});

test("partial wiring and a failed package install both remain in the recovery details", async () => {
  const { controller } = frontend({
    instrumentReact: async () => ({ entryFile: "src/main.tsx", complete: false, detail: "Needs router wiring" }),
    installFaroPackages: async () => {
      throw new Error("registry unavailable");
    },
  });
  await configure(controller);
  assert.equal(controller.getSnapshot().outcome, "incomplete");
  assert.match(controller.getSnapshot().error, /Needs router wiring/);
  assert.match(controller.getSnapshot().error, /registry unavailable/);
});

for (const complete of [false, true])
  test(`Next.js ${complete ? "package failure" : "partial wiring"} reports incomplete setup and its changed files`, async () => {
    const { controller, events } = frontend({
      detectFrontendTarget: () => ({ kind: "nextjs" }),
      instrumentNextjs: async () => ({
        componentFile: "src/FrontendObservability.tsx",
        layoutFile: complete ? "src/app/layout.tsx" : undefined,
        complete,
        detail: "Add the component to the layout",
      }),
      installFaroPackages: async () => {
        if (complete) throw new Error("registry unavailable");
      },
    });
    await configure(controller);
    assert.equal(controller.getSnapshot().outcome, "incomplete");
    assert.match(controller.getSnapshot().instrumentedFile, /FrontendObservability.tsx/);
    if (complete) assert.match(controller.getSnapshot().instrumentedFile, /layout.tsx/);
    assert.match(controller.getSnapshot().error, complete ? /registry unavailable/ : /Add the component/);
    assert.equal(events.at(-1)[1].target_kind, "nextjs");
    assert.equal(events.at(-1)[1].status, "failed");
  });
