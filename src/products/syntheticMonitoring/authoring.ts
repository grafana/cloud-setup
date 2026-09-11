import { browserTools, ensureAssistantAuth, fileTools, runTask } from "../harness/index.js";

export interface DiscoveredEndpoint {
  path: string;
  description: string;
}

function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?/, "")
    .replace(/```$/, "")
    .trim();
}

function isDiscoveredEndpoint(value: unknown): value is DiscoveredEndpoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DiscoveredEndpoint).path === "string" &&
    typeof (value as DiscoveredEndpoint).description === "string"
  );
}

function parseEndpoints(response: string): DiscoveredEndpoint[] {
  try {
    const parsed = JSON.parse(stripJsonFences(response));
    return Array.isArray(parsed) ? parsed.filter(isDiscoveredEndpoint) : [];
  } catch {
    return [];
  }
}

// Not part of the default authorChecks pipeline below — kept as a
// separate, standalone building block (e.g. for a broader "understand my
// repo" task unrelated to live-checking a specific URL). Reads the
// project's real route/handler files (not framework-name heuristics) and
// reports which backend endpoints look worth a standalone Synthetic
// Monitoring check. Framed explicitly as an SM setup task, which is what
// keeps Grafana Assistant reliably in-scope for this (verified live: 8/8
// with this framing, vs. ~80% for a generic "explore this codebase"
// phrasing, and refusals even with real protocol-native tools available
// under that generic framing). Also verified live that a strict "respond
// with ONLY JSON" instruction alone can suppress tool use entirely (0/8)
// unless paired with an explicit "you must explore before answering"
// directive, which is why that's here.
//
// Deliberately not used by default for proposing checks against a live
// URL: cwd isn't guaranteed to match what's actually deployed there (a
// monorepo, staging vs. prod, feature-flagged or internal-only code) —
// proposing a check for something that only exists in source but isn't
// truly live is worse for a monitoring tool than missing it. The live,
// browser-observed signal in proposeLiveEndpoints is the trustworthy one
// for that job.
//
// Language/framework-agnostic on purpose: the model does the reasoning
// about where routes live in a given codebase, using real evidence from
// the files it reads, rather than us hand-writing a per-framework walker.
// Returns [] on any failure (no auth, assistant error, malformed
// response, or a genuine "found nothing") — this is a nice-to-have,
// callers should treat it as such.
export async function proposeApiEndpoints(cwd: string, stackUrl: string): Promise<DiscoveredEndpoint[]> {
  const task = [
    "I am setting up Grafana Synthetic Monitoring for this project.",
    "To create good synthetic checks, I need to know which backend API endpoints this project actually exposes.",
    "You must actually explore the project first — call list_dir and read_file (and grep if useful) to look at real",
    "files before answering. Do not answer from assumptions about the framework; look at the actual route or handler",
    "files — for example Next.js app/api/**/route.ts or pages/api/**, Express/Fastify route registrations,",
    "Django/FastAPI/Flask URL patterns, or a Go/Ruby router's route table. Start by listing the project root, then dig",
    "into whichever directory looks like it holds backend/API code.",
    "Only report endpoints you found actual evidence for in the code — never invent one.",
    "For each, give the URL path and a one-sentence description of what it does.",
    "This is part of a Grafana Synthetic Monitoring setup workflow.",
    "Once you're done exploring, respond with ONLY a JSON array, no prose, no markdown fences, of objects shaped like:",
    '[{"path": "/api/hello", "description": "Returns a health check response"}]',
    "Only respond with an empty array [] if you actually explored the project and found no backend code at all.",
  ].join(" ");

  try {
    return parseEndpoints(await runTask(stackUrl, task, fileTools(cwd)));
  } catch {
    return [];
  }
}

// Agent 2 — opens the real, live target URL in a local browser and
// inspects the network requests it actually makes while loading, so
// endpoints come from observed behavior instead of guessed-at code paths.
// Requires the caller's requestPermission callback to approve the first
// real browser launch (see BrowserToolOptions) — this is the one place
// this harness touches something outside the project directory itself.
export async function proposeLiveEndpoints(
  targetUrl: string,
  stackUrl: string,
  requestPermission: () => Promise<boolean> | boolean
): Promise<DiscoveredEndpoint[]> {
  const task = [
    "I am setting up Grafana Synthetic Monitoring and want to know which backend API endpoints a live website actually",
    `calls. Use list_network_requests to open ${targetUrl} in a real browser and inspect the fetch/XHR requests it makes`,
    "while loading — it's already filtered to real dynamic requests, so you don't need to guess which ones are",
    "static assets. Report EVERY same-origin one that looks like a real backend API call, not just the most obvious —",
    "err on the side of including a plausible one rather than dropping it; a second pass will judge which are truly",
    "worth their own check. Exclude only third-party domains (analytics, ads, consent managers, tag managers) and",
    "anything you found no actual evidence for — never invent one.",
    "This is part of a Grafana Synthetic Monitoring setup workflow.",
    "For each endpoint's description, write one sentence explaining what the endpoint's PATH STRUCTURE suggests it",
    "does — e.g. '/api/users/:id' is 'Fetches a user's profile'. Reason only from the path and method shape, never",
    "from a specific value you happened to see in one URL (an id, a name, a place, a query param's actual value) —",
    "those are one call's data, not the endpoint's purpose, and would be misleading on every other call this check",
    "makes. If you're unsure what an endpoint does, say so plainly rather than guessing something specific.",
    "Once you're done inspecting, respond with ONLY a JSON array, no prose, no markdown fences, of objects shaped",
    'like: [{"path": "https://example.com/api/hello", "description": "..."}]',
    "Respond with an empty array [] if you found no real API calls.",
  ].join(" ");

  try {
    return parseEndpoints(await runTask(stackUrl, task, browserTools({ requestPermission })));
  } catch {
    return [];
  }
}

// Agent 2 — a second, independent pass over the first agent's raw
// findings: a fresh judgment call, not just a format pass. Framed as an
// experienced SRE's review specifically so it applies real scrutiny
// (duplicates, one-off noise, anything that doesn't look genuinely worth
// its own check) rather than rubber-stamping whatever agent 1 already
// filtered. Pure reasoning over already-gathered evidence, so it needs no
// tools of its own. Falls back to the raw candidate list (rather than
// losing everything) if the judging call itself fails.
export async function judgeEndpoints(
  candidates: DiscoveredEndpoint[],
  targetUrl: string,
  stackUrl: string
): Promise<DiscoveredEndpoint[]> {
  if (candidates.length === 0) return [];

  const task = [
    "I am setting up Grafana Synthetic Monitoring and have a first-pass list of backend API endpoints observed on a",
    `live page (${targetUrl}) via its network requests: ${JSON.stringify(candidates)}.`,
    "Critically review this list as an experienced SRE deciding what's actually worth a dedicated synthetic check.",
    "Remove anything that looks like noise, a duplicate, a one-off request that wouldn't matter much if it broke, or",
    "anything that doesn't look like a real, meaningful backend endpoint. Keep only endpoints genuinely worth",
    "monitoring on their own. This is part of a Grafana Synthetic Monitoring setup workflow.",
    "Also rewrite any description that isn't a clear, generic one-sentence statement of the endpoint's purpose —",
    "in particular, if a description just repeats a specific value from one observed call (an id, a name, a place,",
    "a literal query param value) rather than explaining what the endpoint does, replace it with a proper one.",
    "Respond with ONLY a JSON array, no prose, no markdown fences, of the endpoints you kept, in the same shape:",
    '[{"path": "...", "description": "..."}]',
    "Respond with an empty array [] if none are worth keeping.",
  ].join(" ");

  try {
    return parseEndpoints(await runTask(stackUrl, task, []));
  } catch {
    return candidates;
  }
}

// Orchestrates the two-agent pipeline: browse the live URL, then have a
// fresh pass judge the results. Warms the assistant auth cache first so
// the eventual judging call (same stack) doesn't need its own auth round.
export async function authorChecks(
  targetUrl: string,
  stackUrl: string,
  requestPermission: () => Promise<boolean> | boolean
): Promise<DiscoveredEndpoint[]> {
  await ensureAssistantAuth(stackUrl);

  const candidates = await proposeLiveEndpoints(targetUrl, stackUrl, requestPermission);
  return judgeEndpoints(candidates, targetUrl, stackUrl);
}
