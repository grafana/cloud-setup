import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { AgentTool } from "./a2a.js";

const execFileAsync = promisify(execFile);

export interface BrowserToolOptions {
  // Called at most once per process, right before the first real browser
  // launch — lets the caller show whatever UI fits it (an Ink confirm, a
  // plain stdin prompt, ...) and decide whether to allow it. The harness
  // itself stays UI-agnostic; this is the seam for that.
  requestPermission: () => Promise<boolean> | boolean;
}

// Common install locations for a browser agent-browser can drive via CDP
// without downloading its own ~380MB Chrome for Testing copy. Checked in
// this order; the first one found wins. Not exhaustive, just the common
// cases — falls back to a managed download if none of these exist.
const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const LINUX_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "brave-browser",
  "microsoft-edge",
];
const WINDOWS_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findOnPath(command: string): boolean {
  const which = process.platform === "win32" ? "where" : "which";
  return spawnSync(which, [command], { stdio: "ignore" }).status === 0;
}

let cachedSystemBrowser: string | undefined | null = null;

function findSystemBrowser(): string | undefined {
  if (cachedSystemBrowser !== null) return cachedSystemBrowser;

  if (process.platform === "darwin") {
    cachedSystemBrowser = MAC_CANDIDATES.find((p) => existsSync(p));
  } else if (process.platform === "win32") {
    cachedSystemBrowser = WINDOWS_CANDIDATES.find((p) => existsSync(p));
  } else {
    cachedSystemBrowser = LINUX_CANDIDATES.find((cmd) => findOnPath(cmd));
  }
  return cachedSystemBrowser;
}

// Always run through npx rather than a global install of agent-browser
// itself — it resolves into npm's own package cache instead of adding a
// permanent global bin. Points it at an existing system browser whenever
// one is found (no download at all); only falls back to agent-browser's
// own managed Chrome-for-Testing download when nothing usable is present.
async function agentBrowser(args: string[], timeout: number): Promise<string> {
  const systemBrowser = findSystemBrowser();
  const env = systemBrowser ? { ...process.env, AGENT_BROWSER_EXECUTABLE_PATH: systemBrowser } : process.env;
  const { stdout } = await execFileAsync("npx", ["--yes", "agent-browser@latest", ...args], { timeout, env });
  return stdout;
}

let permissionGranted: boolean | undefined;
let installEnsured = false;

async function ensurePermission(options: BrowserToolOptions): Promise<boolean> {
  if (permissionGranted !== undefined) return permissionGranted;
  permissionGranted = await options.requestPermission();
  return permissionGranted;
}

// Only agent-browser's own bundled-Chromium path needs "install" (that's
// the ~380MB Chrome for Testing download); driving an existing system
// browser via AGENT_BROWSER_EXECUTABLE_PATH needs no separate install
// step at all, so this becomes a no-op whenever one was found.
async function ensureInstalled(): Promise<void> {
  if (installEnsured || findSystemBrowser()) return;
  await agentBrowser(["install"], 180000);
  installEnsured = true;
}

async function withPage<T>(options: BrowserToolOptions, url: string, run: () => Promise<T>): Promise<T | string> {
  if (!(await ensurePermission(options))) {
    return "The user declined to allow local browser access for this task.";
  }
  try {
    await ensureInstalled();
    // Headed, not headless — permission was already granted for this
    // exact reason: a visible window is its own transparency, not just a
    // technical preference.
    await agentBrowser(["open", url, "--headed"], 30000);
    return await run();
  } finally {
    // Awaited, not fire-and-forget: withPage must not return (or the next
    // call's "open" must not race) until the visible browser window has
    // actually closed — otherwise it lingers on screen after the CLI
    // moves on, and a second withPage call can hang waiting on the same
    // profile lock this one hasn't released yet.
    await agentBrowser(["close"], 10000).catch(() => {});
  }
}

// Best-effort — some pages never truly go idle (websockets, polling,
// analytics beacons), so this is given its own budget and a failure here
// just means we read performance entries a bit earlier than ideal, not a
// reason to abort discovery.
async function waitForNetworkIdle(): Promise<void> {
  try {
    await agentBrowser(["wait", "--load", "networkidle"], 15000);
  } catch {
    // See above.
  }
}

// Reads performance.getEntriesByType('resource') from the live page — the
// same signal a real network tab shows — but filtered to entries whose own
// initiatorType says they're a fetch()/XHR call. That's a hard signal
// straight from the browser, not a guess: earlier this handed the model
// *every* resource (scripts, images, fonts, CSS, trackers, the works) and
// asked it to guess which looked "API-shaped" from the URL text alone —
// which buried the real backend calls in noise and made the model play it
// safe, often keeping just one. Filtering here means every URL the model
// sees really is a dynamic request, so it only has to judge same-origin
// vs. third-party and relevance, not guess at resource type. `new Set`
// dedupes repeat/polling calls to the same URL.
const RESOURCE_URLS_JS = [
  "JSON.stringify([...new Set(",
  "performance.getEntriesByType('resource')",
  ".filter((r) => r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest')",
  ".map((r) => r.name)",
  ")])",
].join("");

export function browserTools(options: BrowserToolOptions): AgentTool[] {
  return [
    {
      name: "browse_url",
      description:
        "Open a URL in a real local browser and return its agent-readable page text. Use this to see what a live page actually renders — not for reading local project files.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      execute: (input) => withPage(options, String(input.url), () => agentBrowser(["read", String(input.url)], 30000)),
    },
    {
      name: "list_network_requests",
      description:
        "Open a URL in a real local browser, wait for it to load and settle, then return every fetch/XHR request URL the page actually made — already filtered to real dynamic requests, not static assets like scripts, images, or fonts. Use this to find a live page's real backend API calls.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      execute: (input) =>
        withPage(options, String(input.url), async () => {
          await waitForNetworkIdle();
          return agentBrowser(["eval", RESOURCE_URLS_JS], 15000);
        }),
    },
  ];
}
