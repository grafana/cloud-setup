import { authorChecks } from "./checks/authoring.js";
import type { CheckSettings } from "./types.js";

export interface Candidate {
  key: string;
  label: string;
  // What's actually shown in the UI — `label` is the SM check's job name
  // (must stay unique, so AI ones carry an "ai-" prefix and a slugified
  // path) and was never meant to double as display text.
  title: string;
  description: string;
  selectedByDefault: boolean;
  target: string;
  settings: CheckSettings;
  frequencyMs: number;
}

// SSL certs don't change often, so the least frequent check the SM API
// allows (60 minutes) is enough; the other checks run twice as often.
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const SIXTY_MINUTES_MS = 60 * 60 * 1000;

function browserScript(url: string): string {
  return [
    "import { browser } from 'k6/browser';",
    "",
    "export const options = {",
    "  scenarios: { ui: { executor: 'shared-iterations', options: { browser: { type: 'chromium' } } } },",
    "};",
    "",
    "export default async function () {",
    "  const page = await browser.newPage();",
    "  try {",
    `    await page.goto('${url}');`,
    "  } finally {",
    "    await page.close();",
    "  }",
    "}",
    "",
  ].join("\n");
}

// A GET rather than HEAD, since plenty of servers handle HEAD poorly; body is
// discarded unread — only the Content-Type header matters here.
async function isWebsite(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    return (res.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

// Generates the default candidate checks for an explicitly-given target URL
// (always --url now — never invented or discovered from the project):
// an HTTP uptime check (always), an SSL check (only if the URL is https —
// there's no cert to check otherwise), and a browser check if the target
// actually serves an HTML page. So 1 to 3 candidates.
export async function candidatesFor(url: string): Promise<Candidate[]> {
  const trimmed = url.replace(/\/$/, "");
  const parsed = new URL(trimmed);
  // Display-only — target keeps the real protocol, the description just
  // doesn't need to repeat "https://" on every row.
  const displayUrl = trimmed.replace(/^https?:\/\//, "");

  const candidates: Candidate[] = [
    {
      key: "uptime",
      label: "uptime",
      title: "Uptime",
      description: `Request ${displayUrl}`,
      selectedByDefault: true,
      target: trimmed,
      settings: { http: { method: "GET" } },
      frequencyMs: THIRTY_MINUTES_MS,
    },
  ];

  if (parsed.protocol === "https:") {
    candidates.push({
      key: "ssl",
      label: "ssl",
      title: "SSL",
      description: `Check SSL certificate for ${parsed.hostname}`,
      selectedByDefault: true,
      target: `${parsed.hostname}:443`,
      settings: { tcp: { tls: true } },
      frequencyMs: SIXTY_MINUTES_MS,
    });
  }

  if (await isWebsite(trimmed)) {
    candidates.push({
      key: "browser",
      label: "browser",
      title: "Browser",
      description: `Load ${displayUrl} in a real browser`,
      selectedByDefault: true,
      target: trimmed,
      settings: { browser: { script: browserScript(trimmed) } },
      frequencyMs: THIRTY_MINUTES_MS,
    });
  }

  return candidates;
}

const MAX_AI_ENDPOINT_CANDIDATES = 3;

// Candidate labels double as SM job names (and must stay unique across the
// whole list), so each AI-discovered endpoint needs its own label rather
// than a shared one — derived from its path, e.g. "ai-region".
function slugForPath(pathname: string): string {
  const cleaned = pathname
    .replace(/^\/|\/$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned : "root";
}

function resolveTarget(path: string, baseUrl: string): string {
  try {
    return new URL(path).toString();
  } catch {
    return new URL(path, baseUrl).toString();
  }
}

// AI-discovered candidates: a live-browsing agent finds real backend calls
// a page makes, a second agent judges which are actually worth their own
// check. Proposed alongside the standard candidates above — never
// auto-selected, and capped so the review list stays scannable. Each
// carries the judge agent's own reason as its description.
export async function aiEndpointCandidatesFor(
  targetUrl: string,
  stackUrl: string,
  requestPermission: () => Promise<boolean> | boolean
): Promise<Candidate[]> {
  const endpoints = await authorChecks(targetUrl, stackUrl, requestPermission);

  return endpoints.slice(0, MAX_AI_ENDPOINT_CANDIDATES).map((endpoint) => {
    const target = resolveTarget(endpoint.path, targetUrl);
    const pathname = new URL(target).pathname;
    const slug = slugForPath(pathname);
    return {
      key: `ai-${slug}`,
      label: `ai-${slug}`,
      title: pathname,
      description: endpoint.description,
      selectedByDefault: false,
      target,
      settings: { http: { method: "GET" } },
      frequencyMs: THIRTY_MINUTES_MS,
    };
  });
}
