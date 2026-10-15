import assert from "node:assert/strict";
import test from "node:test";
import { browserCommand } from "../dist/browser.js";

const url = "https://example.grafana.net/a/app/cli/auth?callback_port=1234&state=abc&code_challenge=xyz";

test("windows passes the whole URL to rundll32 instead of through cmd, where & would split it", () => {
  const { cmd, args } = browserCommand("win32", url);
  assert.equal(cmd, "rundll32");
  assert.deepEqual(args, ["url.dll,FileProtocolHandler", url]);
});

test("macOS and Linux open the URL with the platform launcher", () => {
  assert.deepEqual(browserCommand("darwin", url), { cmd: "open", args: [url] });
  assert.deepEqual(browserCommand("linux", url), { cmd: "xdg-open", args: [url] });
});
