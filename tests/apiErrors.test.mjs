import assert from "node:assert/strict";
import { test } from "node:test";
import { SmApiError, SmClient } from "../dist/products/syntheticMonitoring/api.js";
import { AlertingApiError, AlertingClient } from "../dist/products/syntheticMonitoring/notifications.js";
import { apiErrorMessage } from "../dist/ui/synthetics/errors.js";

for (const [name, createClient, write, ErrorType] of [
  [
    "Synthetic Monitoring",
    () => new SmClient({ mode: "direct", baseUrl: "https://sm.example", token: "test" }),
    (client) => client.createCheck({}),
    SmApiError,
  ],
  [
    "Alerting",
    () => new AlertingClient("https://stack.example", "test"),
    (client) => client.ensureContactPoint("ops@example.com"),
    AlertingApiError,
  ],
])
  test(`${name} preserves HTTP status and response body without exposing raw JSON in the UI`, async (t) => {
    const body = JSON.stringify({ accessErrorId: "ACE3209940705", message: "Access denied" });
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (url.endsWith("/api/frontend/settings")) return Response.json({ namespace: "stacks-test" });
      if (options.method === "GET") return Response.json({ items: [] });
      return new Response(body, { status: 403 });
    });
    await assert.rejects(write(createClient()), (error) => {
      assert.ok(error instanceof ErrorType);
      assert.equal(error.status, 403);
      assert.equal(error.body, body);
      assert.equal(apiErrorMessage(error), "Permission denied (403).");
      return true;
    });
  });

test("other API failures retain useful messages and tolerate unstructured responses", () => {
  for (const [body, expected] of [
    ['{"message":"invalid target"}', "invalid target"],
    ["service unavailable", "service unavailable"],
    ["<html>Bad gateway</html>", "Request failed with status 502"],
    ["", "Request failed with status 502"],
    ["null", "Request failed with status 502"],
    ['{"message":123}', "Request failed with status 502"],
  ]) {
    assert.equal(apiErrorMessage(new SmApiError("Request failed with status 502", 502, body)), expected);
  }
  assert.equal(apiErrorMessage(new Error("network failed")), "network failed");
});
