import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../dist/harness/auth.js", {
  namedExports: {
    ensureAssistantAuth: async () => ({ accessToken: "test-token", apiEndpoint: "https://stack.example" }),
  },
});

const runAgentMock = mock.fn();
mock.module("../dist/harness/a2a.js", { namedExports: { runAgent: runAgentMock } });

const { runTask } = await import("../dist/harness/index.js");

test.beforeEach(() => runAgentMock.mock.resetCalls());

test("runTask retries once on a transient A2A task failure, then succeeds", async () => {
  let calls = 0;
  runAgentMock.mock.mockImplementation(async () => {
    calls++;
    if (calls === 1) throw new Error("A2A task failed");
    return "done";
  });

  const result = await runTask("https://stack.example", "do the thing");

  assert.equal(result, "done");
  assert.equal(calls, 2);
});

test("runTask retries a pre-stream 5xx once, then succeeds", async () => {
  let calls = 0;
  runAgentMock.mock.mockImplementation(async () => {
    calls++;
    if (calls === 1) throw new Error("A2A request failed (503): service unavailable");
    return "done";
  });

  const result = await runTask("https://stack.example", "do the thing");

  assert.equal(result, "done");
  assert.equal(calls, 2);
});

test("runTask does not retry a deliberate terminal state", async () => {
  let calls = 0;
  runAgentMock.mock.mockImplementation(async () => {
    calls++;
    throw new Error("A2A task canceled");
  });

  await assert.rejects(runTask("https://stack.example", "do the thing"), /A2A task canceled/);
  assert.equal(calls, 1);
});

test("runTask gives up after exhausting retries and surfaces the last error", async () => {
  let calls = 0;
  runAgentMock.mock.mockImplementation(async () => {
    calls++;
    throw new Error("A2A task failed");
  });

  await assert.rejects(runTask("https://stack.example", "do the thing"), /A2A task failed/);
  assert.equal(calls, 2);
});
