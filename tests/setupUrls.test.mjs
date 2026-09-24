import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { mock, test } from "node:test";
import React from "react";
import { render, Text } from "ink";

const steps = [];
const runs = [];
mock.module("../dist/telemetry.js", {
  namedExports: {
    recordStep: (...args) => steps.push(args),
    recordRun: (...args) => runs.push(args),
    waitForTelemetry: async () => {},
    setStackIdentity() {},
  },
});
const { SetupUrls } = await import("../dist/ui/SetupUrls.js");
const { SetupApp } = await import("../dist/ui/SetupApp.js");
const { FrontendApp } = await import("../dist/ui/FrontendApp.js");

async function terminal(t, props, child) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  stdout.columns = 180;
  stdout.rows = 60;
  stdout.isTTY = true;
  const resolved = [];
  const exits = [];
  t.mock.method(process, "exit", (code) => exits.push(code));
  t.mock.method(globalThis, "fetch", () => assert.fail("URL entry must not make network requests"));
  const app = render(
    React.createElement(SetupUrls, props, (urls) => {
      resolved.push(urls);
      return child ? child(urls) : React.createElement(Text, null, "Ready for setup");
    }),
    { stdin, stdout, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  t.after(() => app.unmount());
  await sleep(50);
  const send = async (input) => {
    stdin.write(input);
    await sleep(50);
  };
  return {
    resolved,
    exits,
    output: () => output,
    send,
    erase: async (count) => {
      // Each keypress arrives separately, allowing the controlled input to
      // render its new value before the next deletion.
      for (let i = 0; i < count; i++) await send("\x7f");
    },
  };
}

test("Synthetics asks for each missing URL and blocks empty or invalid submissions", async (t) => {
  const before = steps.length;
  const term = await terminal(t, { command: "synthetics" });
  assert.match(term.output(), /Target URL:/);
  await term.send("\r");
  assert.match(term.output(), /Enter the target URL to continue/);
  assert.equal(term.resolved.length, 0);
  await term.send("example.com/query");
  await term.send("\r");
  assert.match(term.output(), /Grafana Cloud stack \(slug or URL\):/);
  assert.equal(term.resolved.length, 0);
  await term.send("https:stackname.grafana.net");
  await term.send("\r");
  assert.match(term.output(), /Enter a stack slug.*or a valid HTTP or HTTPS URL/);
  assert.equal(term.resolved.length, 0);
  assert.equal(steps.length, before);
  await term.erase("https:stackname.grafana.net".length);
  await term.send("stackname");
  await term.send("\r");
  assert.equal(term.resolved.at(-1).targetUrl, "https://example.com/query");
  assert.equal(term.resolved.at(-1).stackUrl, "https://stackname.grafana.net");
  assert.deepEqual(steps.slice(before), [["synthetics", "https://stackname.grafana.net", "urls", { status: "ok" }]]);
});

test("invalid supplied stack URL is editable before the frontend wizard mounts", async (t) => {
  const term = await terminal(t, { command: "frontend", initialStackUrl: "https:example.grafana.net" });
  assert.match(term.output(), /https:example.grafana.net/);
  assert.match(term.output(), /Enter a stack slug.*or a valid HTTP or HTTPS URL/);
  assert.equal(term.resolved.length, 0);
  await term.send("\r");
  assert.equal(term.resolved.length, 0);
  await term.erase("https:example.grafana.net".length);
  await term.send("example");
  await term.send("\r");
  assert.equal(term.resolved.at(-1).stackUrl, "https://example.grafana.net");
});

test("valid flags skip prompts and preserve target paths and queries", async (t) => {
  const term = await terminal(t, {
    command: "synthetics",
    initialTargetUrl: "https://example.com/health?full=true",
    initialStackUrl: "example.grafana.net/",
  });
  assert.match(term.output(), /Ready for setup/);
  assert.equal(term.resolved.at(-1).targetUrl, "https://example.com/health?full=true");
  assert.equal(term.resolved.at(-1).stackUrl, "https://example.grafana.net");
});

test("supplied stack slugs skip the prompt in both commands", async (t) => {
  for (const command of ["synthetics", "frontend"]) {
    await t.test(command, async (t) => {
      const term = await terminal(t, {
        command,
        initialTargetUrl: "https://example.com",
        initialStackUrl: "my-team",
      });
      assert.match(term.output(), /Ready for setup/);
      assert.doesNotMatch(term.output(), /Which Grafana Cloud stack/);
      assert.equal(term.resolved.at(-1).stackUrl, "https://my-team.grafana.net");
    });
  }
});

test("an invalid supplied target is corrected without asking for an already valid stack", async (t) => {
  const term = await terminal(t, {
    command: "synthetics",
    initialTargetUrl: "ftp://example.com",
    initialStackUrl: "example.grafana.net",
  });
  assert.match(term.output(), /Target URL:/);
  assert.equal(term.resolved.length, 0);
  await term.erase("ftp://example.com".length);
  await term.send("https://example.com");
  await term.send("\r");
  assert.match(term.output(), /Ready for setup/);
  assert.doesNotMatch(term.output(), /Grafana Cloud stack \(slug or URL\):/);
});

test("URL input accepts intro and quit shortcut characters as ordinary text", async (t) => {
  const term = await terminal(t, { command: "frontend" });
  await term.send("q");
  await term.send("n");
  await term.send("y");
  assert.equal(term.exits.length, 0);
  assert.equal(term.resolved.length, 0);
});

test("malformed URLs can be corrected with arrow keys and Backspace", async (t) => {
  for (const [name, left, presses, together] of [
    ["individual left arrows", "\x1b[D", 11, false],
    ["application-mode left arrows", "\x1bOD", 11, false],
    ["held left arrow", "\x1b[D", 11, true],
    ["Ctrl+B cursor sequence", "\x02", 11, false],
    ["Meta+B word movement", "\x1bb", 2, false],
    ["modified left arrow word movement", "\x1b[1;5D", 2, false],
  ]) {
    await t.test(name, async (t) => {
      const term = await terminal(t, { command: "synthetics", initialStackUrl: "my-team" });
      await term.send("http:example.com");
      await term.send("\r");
      assert.equal(term.resolved.length, 0);
      if (together) await term.send(left.repeat(presses));
      else for (let i = 0; i < presses; i++) await term.send(left);
      await term.send("\x7f");
      await term.send("s://");
      await term.send("\r");
      assert.equal(term.resolved.at(-1)?.targetUrl, "https://example.com/");
    });
  }
});

test("held Backspace clears an invalid URL without leaving stale characters", async (t) => {
  const term = await terminal(t, {
    command: "synthetics",
    initialTargetUrl: "http:example.com",
    initialStackUrl: "my-team",
  });
  await term.send("\x1b[C".repeat(5));
  await term.send("\x7f".repeat(20));
  await term.send("example.com");
  await term.send("\r");
  assert.equal(term.resolved.at(-1)?.targetUrl, "https://example.com/");
});

test("cursor boundaries and forward Delete preserve the rest of the URL", async (t) => {
  const term = await terminal(t, {
    command: "synthetics",
    initialTargetUrl: "http:example.com",
    initialStackUrl: "my-team",
  });
  await term.send("\x1b[D".repeat(20));
  await term.send("\x7f");
  await term.send("\x1b[3~".repeat(5));
  await term.send("https://");
  await term.send("\x1b[F");
  await term.send("/b");
  await term.send("\x1b[H");
  await term.send("\x05"); // Ctrl+E, end of line
  await term.send("b");
  await term.send("\r");
  assert.equal(term.resolved.at(-1)?.targetUrl, "https://example.com/bb");
});

test("pasted URL text is editable without splitting Unicode characters", async (t) => {
  const term = await terminal(t, { command: "synthetics", initialStackUrl: "my-team" });
  await term.send("\x1b[200~https://example.com/👩‍💻\x1b[201~");
  await term.send("\x7f");
  await term.send("b");
  await term.send("\x07"); // Ctrl+G must not insert a g.
  await term.send("\x1bx"); // Unknown Meta shortcuts must not insert text.
  await term.send("b");
  await term.send("\r");
  assert.equal(term.resolved.at(-1)?.targetUrl, "https://example.com/bb");
});

test("submitting a stack slug shows its resolved hostname before starting either wizard", async (t) => {
  for (const command of ["synthetics", "frontend"]) {
    await t.test(command, async (t) => {
      const before = steps.length;
      const term = await terminal(
        t,
        { command, initialTargetUrl: "https://example.com" },
        ({ stackUrl, targetUrl, exit }) =>
          React.createElement(command === "synthetics" ? SetupApp : FrontendApp, {
            initialTargetUrl: targetUrl,
            initialStackUrl: stackUrl,
            forceGcxInstall: false,
            exit,
          }),
      );
      await term.send("example");
      await term.send("\r");
      assert.match(
        term.output(),
        command === "synthetics" ? /Let's set up synthetic checks/ : /Let's set up Frontend Observability/,
      );
      assert.match(term.output(), /Stack\s+example\.grafana\.net/);
      assert.equal(term.resolved.at(-1).stackUrl, "https://example.grafana.net");
      assert.deepEqual(
        steps.slice(before).map((entry) => entry[2]),
        ["urls"],
      );
    });
  }
});

test("Ctrl+C can cancel URL entry without advancing", async (t) => {
  const before = runs.length;
  const term = await terminal(t, { command: "synthetics" });
  t.mock.method(console, "log", () => {});
  await term.send("\x03");
  assert.equal(term.resolved.length, 0);
  assert.deepEqual(term.exits, [0]);
  assert.equal(runs.length, before + 1);
  assert.equal(runs.at(-1)[2], "canceled");
});

test("SIGINT after URL entry records the resolved stack", async (t) => {
  const term = await terminal(t, { command: "frontend" });
  t.mock.method(console, "log", () => {});
  await term.send("example.grafana.net");
  await term.send("\r");
  process.emit("SIGINT");
  await sleep(50);
  assert.deepEqual(term.exits, [0]);
  assert.equal(runs.at(-1)[1], "https://example.grafana.net");
  assert.equal(runs.at(-1)[2], "canceled");
});
