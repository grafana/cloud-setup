import { writeSync } from "node:fs";
import { mock } from "node:test";

const scenario = process.argv[2];
mock.module("react", {
  defaultExport: {},
  namedExports: { useEffect: (effect) => effect(), useRef: (current) => ({ current }) },
});
mock.module("ink", { namedExports: { Box() {}, Text() {}, useInput() {}, useApp: () => ({ exit() {} }) } });
mock.module("ink-spinner", { defaultExport() {} });
mock.module("../../dist/telemetry.js", {
  namedExports: {
    recordRun: (_command, _stack, outcome) => writeSync(1, `${JSON.stringify({ outcome })}\n`),
    waitForTelemetry: () =>
      new Promise((resolve) => {
        if (scenario.startsWith("repeated")) return;
        setTimeout(() => {
          writeSync(1, "telemetry flushed\n");
          resolve();
        }, 10);
      }),
  },
});
const { useHardExit } = await import("../../dist/ui/shared.js");

// Open work must not keep the CLI alive after quitting. The parent has a
// timeout, so a missing process.exit fails instead of hanging the suite.
setInterval(() => {}, 1000);
const exit = useHardExit("frontend", "stack");
if (scenario === "repeated") {
  process.emit("SIGINT");
  process.emit("SIGINT");
} else if (scenario === "repeated-incomplete") {
  exit(undefined, "incomplete");
  process.emit("SIGINT");
} else if (scenario === "repeated-error") {
  exit(new Error("failed"));
  process.emit("SIGINT");
} else if (scenario === "reported-error") {
  exit(undefined, "error");
} else if (scenario === "cancel") {
  exit("Cancelled.");
} else if (scenario === "error") {
  exit(new Error("failed"));
} else {
  exit(undefined, scenario === "incomplete" ? "incomplete" : "ok");
}
