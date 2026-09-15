import { existsSync } from "node:fs";
import path from "node:path";
import { ensureAssistantAuth, fileTools, runTask } from "../../harness/index.js";
import { connectK6Mcp, type K6McpClient } from "../../harness/k6Mcp.js";
import { isK6McpSupported } from "../../k6.js";
import { MAX_AI_DESCRIPTION_LENGTH, slugForPath, THIRTY_MINUTES_MS, truncateDescription } from "./discover.js";
import type { Candidate } from "./discover.js";

const CONFIG_FILENAMES = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs"];

// Root-level only, matching this CLI's existing "look at the project root"
// convention (see applyFolder in commands/shared.ts) — no monorepo
// workspace search.
export function detectPlaywrightConfig(cwd: string): boolean {
  return CONFIG_FILENAMES.some((name) => existsSync(path.join(cwd, name)));
}

export interface DiscoveredTest {
  file: string;
  testName: string;
  describeName?: string;
  summary: string;
  source: string;
}

function isDiscoveredTest(value: unknown): value is DiscoveredTest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DiscoveredTest).file === "string" &&
    typeof (value as DiscoveredTest).testName === "string" &&
    typeof (value as DiscoveredTest).summary === "string" &&
    typeof (value as DiscoveredTest).source === "string"
  );
}

// Strips markdown code fences an agent response sometimes wraps its answer
// in, regardless of which language tag (or none) it used. Matches any
// alphanumeric language tag (e.g. ```k6, ```JavaScript), not just a fixed list.
function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z0-9]*\n?/, "")
    .replace(/```$/, "")
    .trim();
}

function parseTests(response: string): DiscoveredTest[] {
  try {
    const parsed = JSON.parse(stripFences(response));
    return Array.isArray(parsed) ? parsed.filter(isDiscoveredTest) : [];
  } catch {
    return [];
  }
}

// Agent 1 — explores the project's own Playwright suite (never invents
// tests) and extracts a structured list, capturing each test's raw source
// now so translateToK6 never needs to re-explore the filesystem. Framed
// explicitly as a Synthetic Monitoring setup task — see the framing
// rationale documented above proposeApiEndpoints in authoring.ts, which
// applies equally here.
export async function discoverTests(cwd: string, stackUrl: string): Promise<DiscoveredTest[]> {
  const task = [
    "I am setting up Grafana Synthetic Monitoring for this project and want to know which Playwright tests already",
    "exist, so I can turn the best ones into synthetic checks. You must actually explore the project first — call",
    "list_dir and read_file (and grep if useful) to look at real files before answering. Start by reading a",
    "playwright.config.ts/js/mjs/cjs file at the project root to find its testDir (or look for a conventional",
    "'tests' or 'e2e' directory if the config doesn't say). Then list and read the spec files you find there.",
    "For every test(...) you find (whether or not it's nested in a describe(...) block), report: the file it's in,",
    "the test's name, its enclosing describe block's name if any, a one-sentence summary of what user journey it",
    "exercises, and the test's exact source code.",
    "Only report tests you found actual evidence for in the code — never invent one.",
    "Report at most 20 tests — if the suite has more than that, pick the 20 most representative ones rather than",
    "reporting every single one.",
    "This is part of a Grafana Synthetic Monitoring setup workflow.",
    "Once you're done exploring, respond with ONLY a JSON array, no prose, no markdown fences, of objects shaped",
    'like: [{"file": "tests/login.spec.ts", "testName": "logs in with valid credentials", "describeName": "Login",',
    '"summary": "Logs in with valid credentials and lands on the dashboard", "source": "test(...) { ... }"}]',
    "Respond with an empty array [] if you found no Playwright tests at all.",
  ].join(" ");

  try {
    return parseTests(await runTask(stackUrl, task, fileTools(cwd)));
  } catch {
    return [];
  }
}

// Kept as its own named constant (rather than reusing
// MAX_AI_ENDPOINT_CANDIDATES from discover.ts) since the two candidate
// lists are conceptually independent — nothing requires them to move
// together.
export const MAX_PLAYWRIGHT_CANDIDATES = 3;

// Agent 2 — a fresh, independent pass over agent 1's raw findings,
// mirroring judgeEndpoints in authoring.ts: real scrutiny (duplicates,
// non-happy-path tests) rather than rubber-stamping whatever agent 1
// already filtered. Pure reasoning over already-gathered evidence, so it
// needs no tools of its own. Falls back to the raw (capped) candidate
// list, rather than losing everything, if the judging call itself fails.
export async function judgeTests(candidates: DiscoveredTest[], stackUrl: string): Promise<DiscoveredTest[]> {
  if (candidates.length === 0) return [];

  const task = [
    "I am setting up Grafana Synthetic Monitoring and have a first-pass list of Playwright tests found in this",
    `project: ${JSON.stringify(candidates)}.`,
    "Critically review this list as an experienced SRE deciding which ones represent genuinely distinct,",
    "worth-monitoring happy-path user journeys. Remove any test that is a near-duplicate of another (same journey",
    "with only minor variations — different input values, viewports, or locales), any test that isn't a real",
    "happy-path journey (error states, edge cases, accessibility-only checks, pure assertions with no real",
    `navigation), and keep at most ${MAX_PLAYWRIGHT_CANDIDATES} of the most valuable, distinct journeys.`,
    "This is part of a Grafana Synthetic Monitoring setup workflow.",
    "Respond with ONLY a JSON array, no prose, no markdown fences, of the tests you kept, in the exact same shape",
    "they were given to you (file, testName, describeName, summary, source unchanged).",
    "Respond with an empty array [] if none are worth keeping.",
  ].join(" ");

  try {
    const kept = parseTests(await runTask(stackUrl, task, []));
    return kept.slice(0, MAX_PLAYWRIGHT_CANDIDATES);
  } catch {
    return candidates.slice(0, MAX_PLAYWRIGHT_CANDIDATES);
  }
}

// Agent 3 — one call per kept test, translating its captured source into a
// self-contained k6 browser script. Pure reasoning over already-captured
// source, so it needs no tools. Returns undefined (never throws) on any
// failure, so one bad translation never drops its siblings — the caller
// (playwrightCandidatesFor) filters these out rather than surfacing an
// error. When `priorAttempt` is given (the orchestrator's one retry after
// a k6 MCP validation failure), the validator's exact error text is folded
// into the prompt so the model fixes the specific reported issue rather
// than guessing.
export async function translateToK6(
  test: DiscoveredTest,
  stackUrl: string,
  priorAttempt?: { script: string; errors: string }
): Promise<string | undefined> {
  const task = [
    "Translate the following Playwright test into a self-contained k6 browser script.",
    `Test source:\n${test.source}`,
    "Requirements:",
    "- Use `import { browser } from 'k6/browser';` and this options shape:",
    "  export const options = { scenarios: { ui: { executor: 'shared-iterations', options: { browser: { type: 'chromium' } } } } };",
    "- Translate Playwright page.* calls (goto, locator().click()/fill()/etc.) to their k6 browser module",
    "  equivalents — the k6 browser API is intentionally close to Playwright's page API.",
    "- Translate any Playwright expect(...) assertions using the k6 expect from",
    "  'https://jslib.k6.io/k6-testing/0.5.0/index.js' (import it explicitly with",
    "  `import { expect } from 'https://jslib.k6.io/k6-testing/0.5.0/index.js';`), which mirrors Playwright's",
    "  assertion API (toBeVisible, toHaveText, toHaveURL, ...).",
    "- Use a single browser context; never open more than one concurrently.",
    "- Export a single `export default async function () { const page = await browser.newPage(); try { ... }",
    "  finally { await page.close(); } }` — deterministic cleanup, no dangling pages/contexts.",
    "- Add a brief think-time `sleep()` (imported from 'k6') between major interactions where the original test",
    "  implies a pause between user actions.",
    "- Add a `thresholds` block in `options` covering browser web vitals when the test navigates to a real page:",
    "  `browser_web_vital_cls: ['p(75)<0.1']`, `browser_web_vital_inp: ['p(75)<200']`,",
    "  `browser_web_vital_lcp: ['p(75)<2500']`.",
    "- Never invent a step that isn't in the given source.",
    "- Never copy literal credentials, tokens, or other secrets from the test source into the generated script —",
    "  read any such values from `__ENV` (k6's environment-variable mechanism) instead.",
    ...(priorAttempt
      ? [
          "Your previous attempt failed k6 script validation and must be corrected, not just rewritten from scratch.",
          `Previous script:\n${priorAttempt.script}`,
          `Validator errors:\n${priorAttempt.errors}`,
          "Fix exactly these reported issues in your new script while keeping everything else that was correct.",
        ]
      : []),
    "Respond with ONLY the script source — no prose, no markdown fences.",
  ].join("\n");

  try {
    const response = await runTask(stackUrl, task, []);
    const script = stripFences(response);
    return script.length > 0 ? script : undefined;
  } catch {
    return undefined;
  }
}

// Builds the final Candidate shape from a kept test and its already-produced
// script. Seeded with the describe block name too (not just the test name)
// so two tests with the same name in different files/describe blocks don't
// collide — SM job labels must be unique. playwrightCandidatesFor still
// de-dupes defensively afterward (see dedupeKeysAndLabels) in case slugging
// still collides (e.g. two non-ASCII names both reducing to "root").
function buildCandidate(test: DiscoveredTest, targetUrl: string, script: string): Candidate {
  const slug = slugForPath([test.describeName, test.testName].filter(Boolean).join(" "));
  return {
    key: `pw-${slug}`,
    label: `pw-${slug}`,
    title: test.testName,
    description: truncateDescription(test.summary),
    selectedByDefault: false,
    target: targetUrl,
    settings: { browser: { script } },
    frequencyMs: THIRTY_MINUTES_MS,
  };
}

// One kept test through to a Candidate, or undefined if translation never
// produced a valid script. Tries translateToK6 once; if a validator is
// available and rejects the result, retries translateToK6 exactly once
// more with the validator's error text, then gives up on this candidate.
async function candidateFor(
  test: DiscoveredTest,
  targetUrl: string,
  stackUrl: string,
  validator: K6McpClient | undefined
): Promise<Candidate | undefined> {
  const first = await translateToK6(test, stackUrl);
  if (first === undefined) return undefined;

  let script = first;
  if (validator) {
    const result = await validator.validateScript(first);
    if (!result.valid) {
      const retry = await translateToK6(test, stackUrl, { script: first, errors: result.errors ?? "invalid script" });
      if (retry === undefined) return undefined;
      const retryResult = await validator.validateScript(retry);
      if (!retryResult.valid) return undefined;
      script = retry;
    }
  }

  return buildCandidate(test, targetUrl, script);
}

// Fallback path used only when the validator itself looks broken (see the
// comment at its call site in playwrightCandidatesFor) — translates once,
// with no validate_script call at all, and keeps whatever script comes out.
async function candidateForUnvalidated(test: DiscoveredTest, targetUrl: string, stackUrl: string): Promise<Candidate | undefined> {
  const script = await translateToK6(test, stackUrl);
  return script === undefined ? undefined : buildCandidate(test, targetUrl, script);
}

// Defensive de-dup pass: slugForPath can still collide even after seeding
// with describeName (e.g. two tests, in different files, whose
// describeName+testName combination happens to slug identically, or two
// non-ASCII names both reducing to "root"). SM job labels must be unique,
// so later duplicates get a numeric suffix on both key and label (title and
// description are left as-is — they're not uniqueness-critical).
function dedupeKeysAndLabels(candidates: Candidate[]): Candidate[] {
  const seen = new Map<string, number>();
  return candidates.map((c) => {
    const count = (seen.get(c.key) ?? 0) + 1;
    seen.set(c.key, count);
    return count === 1 ? c : { ...c, key: `${c.key}-${count}`, label: `${c.label}-${count}` };
  });
}

// Orchestrates detection -> (k6 MCP connect, if supported) -> discovery ->
// judging -> per-test translation-with-retry, mapping the result to the
// Candidate shape discover.ts's other candidate sources produce. Never
// throws — any failure anywhere in this pipeline just means fewer (or
// zero) Playwright-derived candidates, same philosophy as
// aiEndpointCandidatesFor/authorChecks in authoring.ts.
export async function playwrightCandidatesFor(cwd: string, targetUrl: string, stackUrl: string): Promise<Candidate[]> {
  if (!detectPlaywrightConfig(cwd)) return [];

  let validator: K6McpClient | undefined;
  try {
    await ensureAssistantAuth(stackUrl);

    const discovered = await discoverTests(cwd, stackUrl);
    const kept = await judgeTests(discovered, stackUrl);

    if (isK6McpSupported()) {
      try {
        validator = await connectK6Mcp();
      } catch {
        validator = undefined;
      }
    }

    const results = await Promise.all(kept.map((test) => candidateFor(test, targetUrl, stackUrl, validator)));
    let candidatesList = results.filter((c): c is Candidate => c !== undefined);

    // If a validator was connected and every single kept test still got
    // dropped, that looks far more like a validator problem (e.g. the real
    // validate_script response shape not matching what we assumed, or the
    // generated scripts' jslib.k6.io import failing to resolve offline)
    // than three simultaneously-broken translations — treat it as such and
    // fail open: fall back to the unvalidated translations rather than
    // surfacing nothing at all to the user.
    if (validator && kept.length > 0 && candidatesList.length === 0) {
      const fallbackResults = await Promise.all(kept.map((test) => candidateForUnvalidated(test, targetUrl, stackUrl)));
      candidatesList = fallbackResults.filter((c): c is Candidate => c !== undefined);
    }

    return dedupeKeysAndLabels(candidatesList);
  } catch {
    return [];
  } finally {
    if (validator) {
      try {
        await validator.close();
      } catch {
        // Best-effort cleanup — must never propagate past this module's
        // own fail-safe boundary.
      }
    }
  }
}
