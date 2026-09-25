import assert from "node:assert/strict";
import { test } from "node:test";
import { plan } from "../dist/products/syntheticMonitoring/reconcile.js";

function client(overrides = {}) {
  return {
    listProbes: async () => [{ id: 1, name: "London" }],
    findCheck: async () => undefined,
    ...overrides,
  };
}

test("a browser-settings check is created on the v2 k6 channel", async () => {
  const config = {
    ssl: {
      target: "https://example.com",
      probes: ["London"],
      settings: { browser: { script: "export default function () {}" } },
    },
  };
  const { actions } = await plan(config, client());
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].payload.channels, { k6: { id: "v2" } });
});

test("an http check is created without a k6 channel", async () => {
  const config = {
    uptime: {
      target: "https://example.com",
      probes: ["London"],
      settings: { http: { method: "GET" } },
    },
  };
  const { actions } = await plan(config, client());
  assert.equal(actions[0].payload.channels, undefined);
});

test("an existing browser check missing the v2 channel is updated, not a noop", async () => {
  const config = {
    ssl: {
      target: "https://example.com",
      probes: ["London"],
      settings: { browser: { script: "export default function () {}" } },
    },
  };
  const existing = {
    id: 7,
    tenantId: 1,
    target: "https://example.com",
    job: "ssl",
    frequency: 60000,
    timeout: 60000,
    enabled: true,
    alertSensitivity: "none",
    basicMetricsOnly: true,
    probes: [1],
    labels: [],
    settings: { browser: { script: Buffer.from("export default function () {}", "utf8").toString("base64") } },
    // No `channels` at all — predates this feature.
    created: 0,
    modified: 0,
  };
  const { actions } = await plan(config, client({ findCheck: async () => existing }));
  assert.equal(actions[0].kind, "update");
  assert.deepEqual(actions[0].payload.channels, { k6: { id: "v2" } });
});
