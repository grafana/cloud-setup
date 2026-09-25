import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const events = [];
const inkExits = [];
mock.module("react", {
  defaultExport: {},
  namedExports: { useEffect() {}, useRef: (current) => ({ current }) },
});
mock.module("ink", {
  namedExports: { Box() {}, Text() {}, useInput() {}, useApp: () => ({ exit: (...args) => inkExits.push(args) }) },
});
mock.module("ink-spinner", { defaultExport() {} });
mock.module("../dist/telemetry.js", {
  namedExports: {
    recordRun: (...args) => events.push(args),
    waitForTelemetry: () => new Promise(() => {}),
  },
});
const { useHardExit } = await import("../dist/ui/shared.js");

test("explicit incomplete setup is reported without a thrown Error", () => {
  useHardExit("frontend", "stack")(undefined, "incomplete");
  assert.equal(events.at(-1)[2], "incomplete");
});

test("errors and cancellation take precedence over a setup result", (t) => {
  t.mock.method(console, "log", () => {});
  useHardExit("frontend", "stack")(new Error("failed"), "ok");
  assert.equal(events.at(-1)[2], "error");
  assert.deepEqual(inkExits.at(-1), [], "rendered errors must not reject Ink's waitUntilExit and print again");
  useHardExit("frontend", "stack")("Cancelled.", "ok");
  assert.equal(events.at(-1)[2], "canceled");
});

test("multiple exit callbacks produce only one finished event", (t) => {
  const terminated = new Error("process exited");
  const processExit = t.mock.method(process, "exit", () => {
    // process.exit never returns. A returning stub would run unreachable code.
    throw terminated;
  });
  const exit = useHardExit("frontend", "stack");
  const before = events.length;
  exit(undefined, "ok");
  assert.throws(
    () => exit(undefined, "ok"),
    (error) => error === terminated,
  );
  assert.equal(events.length, before + 1);
  assert.equal(processExit.mock.callCount(), 1);
  assert.deepEqual(processExit.mock.calls[0].arguments, [0]);
});

for (const [scenario, outcome, code] of [
  ["success", "ok", 0],
  ["incomplete", "incomplete", 1],
  ["error", "error", 1],
  ["cancel", "canceled", 0],
  ["repeated", "canceled", 0],
  ["repeated-incomplete", "incomplete", 1],
  ["repeated-error", "error", 1],
  ["reported-error", "error", 1],
]) {
  test(`${scenario} exits the child process with code ${code} and one finished event`, () => {
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        fileURLToPath(new URL("./fixtures/exit-process.mjs", import.meta.url)),
        scenario,
      ],
      { encoding: "utf8", timeout: 5000, env: { ...process.env, CLOUD_SETUP_TELEMETRY: "disabled" } },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, code, child.stderr);
    const output = child.stdout.trim().split("\n");
    const reported = output.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    assert.equal(reported.length, 1, child.stdout);
    assert.equal(reported[0].outcome, outcome);
    assert.equal(output.includes("telemetry flushed"), !scenario.startsWith("repeated"), child.stdout);
    assert.equal(output.includes("Cancelled."), outcome === "canceled", child.stdout);
  });
}
