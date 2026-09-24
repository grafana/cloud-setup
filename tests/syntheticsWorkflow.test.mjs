import assert from "node:assert/strict";
import { test } from "node:test";
import { createSyntheticsController } from "../dist/ui/synthetics/controller.js";
import { syntheticsServices } from "../dist/ui/synthetics/services.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const candidate = (key) => ({
  key,
  title: key,
  label: key,
  target: `https://example.com/${key}`,
  settings: { http: {} },
  frequencyMs: 60000,
  probeCount: 1,
  selectedByDefault: true,
  description: "Uptime",
});
const first = candidate("first");
const second = candidate("second");

function setup(overrides = {}) {
  const events = [];
  const exports = [];
  const mutations = [];
  const client = {
    listProbes: async () => [{ id: 1, name: "London" }],
    createCheck: async (payload) => {
      mutations.push(payload.job);
      return { id: payload.job === "first" ? 101 : 202 };
    },
    updateCheck: () => assert.fail("unexpected update"),
    getCheckAlerts: async () => [],
    putCheckAlerts: async () => {},
  };
  const services = {
    ...syntheticsServices,
    sleep: async () => {},
    checkNodeVersion() {},
    isGcxInstalled: () => true,
    ensureAssistantAuth: async () => ({ stackId: "123" }),
    setStackIdentity() {},
    startFakeProgress: () => ({ finish: async () => {}, stop() {}, pause() {}, resume() {} }),
    getSkillStatus: async () => ({ installed: true }),
    candidatesFor: async () => [first],
    aiEndpointCandidatesFor: async () => [second],
    tryAutoSmSession: async () => ({ client, apiUrl: "https://sm.example", probes: await client.listProbes() }),
    probeReachable: async () => {},
    createClient: () => client,
    writeCredentials: async () => {},
    buildPlan: async (config) => ({
      actions: Object.keys(config).map((name) => ({ kind: "create", name, payload: { job: name } })),
    }),
    writeTerraformExport: async (...args) => {
      exports.push(args);
      return "/project/terraform";
    },
    ...overrides,
  };
  const controller = createSyntheticsController(
    {
      stackUrl: "https://example.grafana.net",
      targetUrl: "https://example.com",
      forceGcxInstall: false,
      cwd: "/project",
    },
    services,
    (...event) => events.push(event),
  );
  return { controller, events, exports, mutations, client };
}
async function start(controller, auth = true) {
  controller.start();
  await tick();
  controller.answer("authenticate", auth);
  await tick();
  assert.equal(controller.getSnapshot().prompt, "selection");
}
async function firstPass(controller) {
  await start(controller);
  controller.answer("selection", ["first"]);
  await tick();
  assert.equal(controller.getSnapshot().prompt, "alerting");
  controller.answer("alerting", false);
  await tick();
  assert.equal(controller.getSnapshot().prompt, "nextAction");
}

test("the configure-skills next action records where a fresh install landed, relative to cwd", async () => {
  const { controller } = setup({
    getSkillStatus: async () => ({ installed: false, agents: [] }),
    installSkill: async () => ({
      installed: true,
      agents: ["Claude Code", "Cursor"],
      path: "/project/.agents/skills/synthetic-monitoring-checks",
    }),
  });
  await firstPass(controller);
  controller.answer("nextAction", "configure-skills");
  await tick();
  const entry = controller.getSnapshot().nextStepsLog.find((e) => e.key === "configure-skills");
  assert.equal(entry.detail, "Wrote to .agents/skills/synthetic-monitoring-checks");
  assert.equal(controller.getSnapshot().prompt, "nextAction");
  controller.dispose();
});

test("an already-installed skill reads its path from getSkillStatus, not installSkill", async () => {
  const { controller } = setup({
    getSkillStatus: async () => ({
      installed: true,
      agents: ["Windsurf"],
      path: "/project/.agents/skills/synthetic-monitoring-checks",
    }),
    installSkill: async () => assert.fail("already installed — should not reinstall"),
  });
  await firstPass(controller);
  controller.answer("nextAction", "configure-skills");
  await tick();
  const entry = controller.getSnapshot().nextStepsLog.find((e) => e.key === "configure-skills");
  assert.equal(entry.detail, "Wrote to .agents/skills/synthetic-monitoring-checks");
  controller.dispose();
});

test("a browser-type check skips probes that can't run k6, but keeps every capable one", async () => {
  const browserCandidate = {
    ...first,
    key: "ssl",
    label: "ssl",
    settings: { browser: { script: "" } },
    probeCount: 3,
  };
  const probes = [
    { id: 1, name: "Legacy", capabilities: { disableBrowserChecks: true } },
    { id: 2, name: "NoV2", k6Versions: { v2: null } },
    { id: 3, name: "Unreported", k6Versions: { v2: "unknown" } },
    { id: 4, name: "London" },
    { id: 5, name: "Paris", k6Versions: { v2: "2.3.1" } },
  ];
  const client = {
    createCheck: async () => ({ id: 1 }),
    updateCheck: () => assert.fail("unexpected update"),
    getCheckAlerts: async () => [],
    putCheckAlerts: async () => {},
  };
  const { controller } = setup({
    candidatesFor: async () => [browserCandidate],
    tryAutoSmSession: async () => ({ client, apiUrl: "https://sm.example", probes }),
  });
  await start(controller);
  controller.answer("selection", ["ssl"]);
  await tick();
  await tick();
  assert.deepEqual(controller.getSnapshot().records[0].probes, ["Unreported", "London", "Paris"]);
  controller.dispose();
});

test("checks selected together draw probes from one shared, consistently filtered pool", async () => {
  const uptimeCandidate = { ...first, key: "uptime", label: "uptime", probeCount: 3 };
  const sslCandidate = {
    ...second,
    key: "ssl",
    label: "ssl",
    settings: { browser: { script: "" } },
    probeCount: 1,
  };
  const probes = [
    { id: 1, name: "Incapable", capabilities: { disableBrowserChecks: true } },
    { id: 2, name: "London" },
    { id: 3, name: "Paris" },
    { id: 4, name: "Tokyo" },
  ];
  const client = {
    createCheck: async () => ({ id: 1 }),
    updateCheck: () => assert.fail("unexpected update"),
    getCheckAlerts: async () => [],
    putCheckAlerts: async () => {},
  };
  const { controller } = setup({
    candidatesFor: async () => [uptimeCandidate, sslCandidate],
    tryAutoSmSession: async () => ({ client, apiUrl: "https://sm.example", probes }),
  });
  await start(controller);
  controller.answer("selection", ["uptime", "ssl"]);
  await tick();
  await tick();
  const records = new Map(controller.getSnapshot().records.map((r) => [r.candidate.key, r]));
  // ssl's single pick is the first of uptime's three, not some other probe
  // it landed on only because it filters differently.
  assert.deepEqual(records.get("uptime").probes, ["London", "Paris", "Tokyo"]);
  assert.deepEqual(records.get("ssl").probes, ["London"]);
  controller.dispose();
});

for (const prompt of ["baseUrl", "token"])
  test(`Back from ${prompt} returns to a working selection prompt and preserves the submitted selection`, async () => {
    const { controller, mutations } = setup({ tryAutoSmSession: () => assert.fail("auth was declined") });
    await start(controller, false);
    controller.answer("selection", ["first"]);
    await tick();
    if (prompt === "token") {
      controller.answer("baseUrl", "https://sm.example");
      await tick();
    }
    assert.equal(controller.getSnapshot().prompt, prompt);
    controller.restart("create");
    await tick();
    assert.equal(controller.getSnapshot().prompt, "selection");
    assert.deepEqual(controller.getSnapshot().selectedKeys, ["first"]);
    controller.answer(prompt, "stale value");
    assert.equal(controller.getSnapshot().prompt, "selection");
    controller.answer("selection", ["first"]);
    await tick();
    if (controller.getSnapshot().prompt === "baseUrl") {
      controller.answer("baseUrl", "https://sm.example");
      await tick();
    }
    controller.answer("token", "token-with-b-and-q");
    await tick();
    assert.deepEqual(mutations, ["first"]);
    assert.equal(controller.getSnapshot().prompt, "alerting");
    controller.dispose();
  });

test("an abandoned auto-discovery response cannot install a session or create checks", async () => {
  const deferred = Promise.withResolvers();
  const { controller, client, mutations } = setup({ tryAutoSmSession: () => deferred.promise });
  await start(controller);
  controller.answer("selection", ["first"]);
  await tick();
  controller.restart("create");
  await tick();
  deferred.resolve({ client, apiUrl: "stale", probes: await client.listProbes() });
  await tick();
  assert.equal(controller.getSnapshot().session, undefined);
  assert.equal(controller.getSnapshot().prompt, "selection");
  assert.deepEqual(mutations, []);
  controller.dispose();
});

test("export retains exact configurations and remote IDs from both creation passes", async () => {
  const { controller, exports, mutations, events } = setup();
  await firstPass(controller);
  controller.answer("nextAction", "browser-discovery");
  await tick();
  controller.answer("browser", true);
  await tick();
  controller.answer("selection", ["first", "second"]);
  await tick();
  assert.equal(controller.getSnapshot().prompt, "nextAction");
  controller.answer("nextAction", "export");
  await tick();
  controller.answer("nextAction", "finish");
  await tick();
  assert.equal(controller.getSnapshot().done, true);
  assert.deepEqual(mutations, ["first", "second"]);
  assert.deepEqual(Object.keys(exports[0][0]), ["first", "second"]);
  assert.deepEqual(
    [...exports[0][2]],
    [
      ["first", 101],
      ["second", 202],
    ],
  );
  assert.equal(exports[0][0].first.frequency, 60000);
  assert.deepEqual(exports[0][0].first.probes, ["London"]);
  assert.equal(events.filter(([step]) => step === "next-steps").length, 1);
  assert.equal(events.filter(([step]) => step === "create").length, 2);
});

for (const variant of ["empty", "declined", "failed"])
  test(`${variant} discovery leaves previous results available for export`, async () => {
    const { controller, exports } = setup({
      aiEndpointCandidatesFor: async () => {
        if (variant === "failed") throw new Error("discovery failed");
        return [];
      },
    });
    await firstPass(controller);
    controller.answer("nextAction", "browser-discovery");
    await tick();
    controller.answer("browser", variant !== "declined");
    await tick();
    controller.answer("nextAction", "export");
    await tick();
    controller.answer("nextAction", "finish");
    await tick();
    assert.deepEqual([...exports[0][2]], [["first", 101]]);
    assert.deepEqual(Object.keys(exports[0][0]), ["first"]);
    assert.equal(controller.getSnapshot().done, true);
  });

test("cancelling during creation never starts another remote mutation", async () => {
  const deferred = Promise.withResolvers();
  const { controller, mutations, client } = setup({ candidatesFor: async () => [first, second] });
  client.createCheck = (payload) => {
    mutations.push(payload.job);
    return deferred.promise;
  };
  await start(controller);
  controller.answer("selection", ["first", "second"]);
  await tick();
  controller.dispose();
  deferred.resolve({ id: 101 });
  await tick();
  assert.deepEqual(mutations, ["first"]);
  assert.equal(controller.getSnapshot().failureSummary, undefined);
  assert.equal(controller.getSnapshot().done, false);
});
