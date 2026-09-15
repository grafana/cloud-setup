# Playwright-based Synthetic Check Discovery — Design

Date: 2026-09-15
Status: Approved for planning

## Problem

`synthetics` already proposes candidate Synthetic Monitoring checks from
static heuristics (`candidatesFor`) and from AI-driven live browsing of the
target URL (`aiEndpointCandidatesFor` → `authorChecks` in `authoring.ts`).
Neither source looks at the user's own Playwright test suite, even though it
often already encodes the application's real, human-picked "happy path"
journeys — exactly the kind of thing worth turning into a synthetic browser
check.

This feature adds a third candidate source: when the project being set up
(`--folder`, default cwd) has a Playwright suite, analyze it, pick a small
set of genuinely distinct happy-path tests, translate each into a k6 browser
script, and offer them alongside the existing candidates in the same review
list.

## Non-goals

- Actually *running* a generated k6 script against the live target (`k6 x
  mcp`'s `run_script` tool) as part of setup. Only static validation
  (`validate_script`) is in scope — running a script sends real traffic to
  the user's app and would need its own explicit confirmation gate, out of
  scope for this plan.
- Supporting non-Playwright frameworks (Cypress, WebdriverIO, ...).
- Any new CLI flag beyond `--force-k6-install` (mirroring the existing
  `--force-gcx-install`). Detection/prompting is otherwise automatic.

## Dependencies

- New npm dependency: `@modelcontextprotocol/sdk` (Anthropic's official
  TypeScript MCP client) — used to talk to `k6 x mcp` for script
  validation. This is a deliberate exception to this CLI's normal
  no-new-dependencies bar: hand-rolling MCP's JSON-RPC/stdio framing
  ourselves is exactly the kind of protocol plumbing worth using the
  standard implementation for instead.
- New external prerequisite: a recent `k6` binary on `PATH` with `k6 x mcp`
  support (shipped as part of core k6 as of a recent-enough release — no
  custom `xk6` build required). Detected, never assumed; see "k6 CLI
  detection and install" below.

## Pipeline

New module: `src/products/syntheticMonitoring/playwright.ts`, following the
same multi-agent shape as `authoring.ts`.

### 1. Detection

```ts
function detectPlaywrightConfig(cwd: string): boolean
```

Synchronous `fs.existsSync` check for `playwright.config.ts` / `.js` / `.mjs`
/ `.cjs` directly at the project root (`cwd`). No recursion, no monorepo
workspace search — matches the existing "look at the project root" pattern
used elsewhere in this CLI (e.g. `applyFolder`).

### 2. Discovery (Agent 1)

```ts
function discoverTests(cwd: string, stackUrl: string): Promise<DiscoveredTest[]>
```

Runs an agent task with `fileTools(cwd)` (read-only: `list_dir`, `read_file`,
`grep`). Framed explicitly as a Synthetic Monitoring setup task (same
framing rationale documented in `authoring.ts`: this measurably keeps
Grafana Assistant in-scope and using its tools instead of refusing or
guessing).

Instructions:
- Read `playwright.config.*` first to find `testDir` (default `tests` or
  `e2e`, whatever the config says) and `use.baseURL` (informational only —
  not used for targeting per the approved design, but useful context for
  the model).
- List and read spec files under `testDir` (or wherever tests actually live,
  if the config doesn't say).
- For each `test(...)` (or `test.step`-free top-level test) found, extract:
  `file`, `testName`, `describeName` (if nested in a `describe` block), a
  one-sentence `summary` of what user journey it exercises, and the test's
  raw `source` text (so later steps never need to re-explore the
  filesystem).
- Respond with ONLY a JSON array, no prose/fences, of objects shaped like:
  `{"file": "...", "testName": "...", "describeName": "...", "summary": "...", "source": "..."}`.
- Empty array `[]` if no Playwright tests are found.

```ts
interface DiscoveredTest {
  file: string;
  testName: string;
  describeName?: string;
  summary: string;
  source: string;
}
```

### 3. Judging (Agent 2)

```ts
function judgeTests(candidates: DiscoveredTest[], stackUrl: string): Promise<DiscoveredTest[]>
```

Pure reasoning over the JSON produced by step 2 (no tools — same pattern as
`judgeEndpoints`). Framed as an experienced SRE picking which user journeys
are worth a dedicated synthetic check:

- Drop tests that are near-duplicates of each other (same journey, minor
  variations — e.g. different form input values, different viewport sizes).
- Drop tests that aren't happy-path (error-state tests, edge cases,
  accessibility-only checks, pure unit-style assertions with no real
  navigation).
- Keep only genuinely distinct, meaningful user journeys.
- Cap the result at `MAX_PLAYWRIGHT_CANDIDATES` (3 — same cap used for
  `MAX_AI_ENDPOINT_CANDIDATES` in `discover.ts`, kept as its own named
  constant since the two lists are conceptually independent).
- Return `[]` if candidates is empty; return the original list (not `[]`)
  if the judging call itself throws, mirroring `judgeEndpoints`'s
  fail-open behavior.

### 4. Translation (Agent 3, one call per kept test, with one retry on a validation failure)

```ts
function translateToK6(
  test: DiscoveredTest,
  stackUrl: string,
  priorAttempt?: { script: string; errors: string }
): Promise<string | undefined>
```

One agent call per test kept after judging (not batched, per the approved
design — isolates failures to a single candidate). Pure reasoning over the
already-captured `test.source` (no tools needed — no re-exploration). The
optional `priorAttempt` is set only on the one retry the orchestrator
(section 6) makes after `k6 x mcp`'s `validate_script` rejects a first
translation.

Instructions given to the model:
- Translate the given Playwright test source into a self-contained k6
  browser script.
- Use `import { browser } from 'k6/browser';` and the same
  `options.scenarios.ui` shape as the existing static browser-check
  template in `discover.ts` (`browserScript`), so generated scripts are
  structurally consistent with the ones already offered by this CLI.
- Translate Playwright `page.*` calls to their k6 browser equivalents
  (`page.goto`, `page.locator(...).click()`, `.fill()`, etc. — the k6
  browser module's API is intentionally close to Playwright's).
- Translate Playwright `expect(...)` assertions using the k6 `expect` from
  `https://jslib.k6.io/k6-testing/0.5.0/index.js`, which mirrors
  Playwright's assertion API (`toBeVisible`, `toHaveText`, `toHaveURL`,
  ...) — import it explicitly.
- Use a single browser context; never open more than one concurrently.
- Wrap navigation/assertions in `try`/`finally { await page.close(); }`,
  matching the existing template — deterministic cleanup, no dangling
  pages/contexts.
- Add a brief think-time `sleep()` (from `k6`) between major interactions
  where the original test implies a pause between user actions.
- Add a `thresholds` block covering browser web vitals when the test
  navigates to a real page: `browser_web_vital_cls` (`p(75)<0.1`),
  `browser_web_vital_inp` (`p(75)<200`), `browser_web_vital_lcp`
  (`p(75)<2500`) — Grafana's documented "good" thresholds for each.
- If `priorAttempt` is given, also include: "Your previous attempt failed
  k6 script validation. Previous script: `<priorAttempt.script>`.
  Validator errors: `<priorAttempt.errors>`. Fix these specific issues in
  your new script."
- Respond with ONLY the script source, no prose, no markdown fences.

Parsing: strip any markdown fences defensively (same `stripJsonFences`-style
helper, reused/adapted for plain-text stripping rather than JSON). If the
response is empty or the call throws, return `undefined` — the caller drops
that one candidate and continues; it never blocks the others.

### 5. k6 CLI detection, install, and MCP validation

**Detection/install** — new module `src/k6.ts`, mirroring the existing
`src/gcx.ts` pattern:

```ts
function isK6McpSupported(): boolean
function attemptInstallK6(): Promise<boolean>
```

- `isK6McpSupported()`: `spawnSync("k6", ["x", "mcp", "--help"])` exits `0`
  — confirms both that `k6` is on `PATH` *and* that it's recent enough to
  have the `x mcp` subcommand (a plain `k6 version` check isn't enough).
- `attemptInstallK6()`: on macOS with Homebrew present, runs
  `brew install k6` and returns whether it succeeded. On every other
  platform (Linux, Windows, or macOS without Homebrew) there is no single
  official unattended installer the way gcx has one — returns `false`
  without attempting anything; the caller falls back to printing the
  install docs link
  (`https://grafana.com/docs/k6/latest/set-up/install-k6/`).
- Never fatal either way: declining, an unsupported platform, or a failed
  install all just mean "skip validation this run" (see below), the same
  "nice-to-have" philosophy as the rest of this feature.

**MCP client** — new module `src/harness/k6Mcp.ts`, using the new
`@modelcontextprotocol/sdk` dependency:

```ts
function connectK6Mcp(): Promise<K6McpClient> // spawns `k6 x mcp` via StdioClientTransport
interface K6McpClient {
  validateScript(script: string): Promise<{ valid: boolean; errors?: string }>;
  close(): Promise<void>;
}
```

- One client connection per `playwrightCandidatesFor` call (section 6),
  reused across every kept test's validation, closed in a `finally`.
- `validateScript` calls the `validate_script` MCP tool exposed by
  `k6 x mcp` and normalizes its response to `{ valid, errors }`. Any
  connection/tool-call failure is treated as `{ valid: true }` (fail
  *open* — an unreachable validator must never itself cause candidates to
  be dropped; the point of validation is to filter obviously-broken
  scripts, not to become a new single point of failure for a "nice to
  have" feature).

### 6. Orchestration

```ts
async function playwrightCandidatesFor(
  cwd: string,
  targetUrl: string,
  stackUrl: string
): Promise<Candidate[]>
```

- Returns `[]` immediately if `!detectPlaywrightConfig(cwd)`.
- `ensureAssistantAuth(stackUrl)` (cheap no-op if already authenticated from
  the earlier `auth` step — same pattern as `authorChecks`).
- `discoverTests` → `judgeTests`.
- If `isK6McpSupported()`, connects one `K6McpClient` for the whole call
  (closed in `finally`); otherwise validation is skipped entirely for
  every kept test.
- For each kept test, in parallel (`Promise.all`):
  1. `translateToK6(test, stackUrl)`. If it returns `undefined`, drop this
     candidate.
  2. If a validator connection is available, `validateScript(script)`. If
     invalid, `translateToK6(test, stackUrl, { script, errors })` once
     more and validate the result again. Still invalid (or the retry
     itself returned `undefined`) → drop this candidate. Valid (on either
     attempt) → keep it. No validator available → keep the first
     translation unvalidated, same as before this section existed.
- Maps each surviving translated test to a `Candidate`:
  - `key`/`label`: `pw-<slug>`, slug derived from `testName` using the same
    slugification approach as `slugForPath` in `discover.ts` (lowercase,
    non-alphanumeric → `-`, trimmed).
  - `title`: the test's `testName`.
  - `description`: the judge-approved `summary`, truncated to
    `MAX_AI_DESCRIPTION_LENGTH` (60 chars, reusing the existing constant).
  - `selectedByDefault`: `false` (approved design — AI-translated content
    needs explicit opt-in, same as `ai-*` endpoint candidates).
  - `target`: `targetUrl` as passed into `synthetics --url` (approved
    design — always the command's target, not anything derived from the
    test itself).
  - `settings`: `{ browser: { script } }` (the translated k6 script).
  - `frequencyMs`: `THIRTY_MINUTES_MS` (same as the existing `browser`
    candidate type).
- Any failure anywhere in this pipeline is caught and treated as "no
  Playwright candidates" — this feature never blocks or fails the overall
  `synthetics` setup.

## UI integration (`SetupApp.tsx`)

- `AnalyzeSubPhase` gains `"playwright-confirm"`, `"k6-install-confirm"`,
  `"k6-installing"`, and `"playwright-analyzing"`. `"playwright-confirm"`
  and `"k6-install-confirm"` are added to `ANALYZE_WAITING_SUBPHASES`
  (they block on user input); the other two don't.
- New refs `playwrightPermissionResolver` and `k6InstallResolver`,
  mirroring `browserPermissionResolver`, plus `useInput` handlers for both
  new confirm sub-phases (Enter/`y` → proceed, `n` → skip) — same shape as
  the existing browser-confirm handler.
- In `runAnalyze`, after local `candidatesFor` completes and only when
  `!auth.error` (Assistant auth is available) **and**
  `detectPlaywrightConfig(process.cwd())`, the sub-phase becomes
  `"playwright-confirm"` and shows:
  *"Analyze this project's Playwright test suite to suggest additional
  synthetic checks?"* with the existing `EnterHint suffix="or n to skip"`
  pattern.
- On accept:
  1. If `!isK6McpSupported()` (or `--force-k6-install`), sub-phase becomes
     `"k6-install-confirm"`: *"Install k6 to validate the checks generated
     from your tests? Without it, generated checks are offered
     unvalidated."* On accept, sub-phase becomes `"k6-installing"` and
     `attemptInstallK6()` runs; its result (installed or not) only affects
     whether `playwrightCandidatesFor`'s internal validation runs — it is
     never surfaced as a failure to the user, since validation itself is
     a nice-to-have layered on a nice-to-have.
  2. Sub-phase becomes `"playwright-analyzing"`; calls
     `playwrightCandidatesFor(process.cwd(), targetUrl, initialStackUrl)`
     and merges any returned candidates into `candidates` the same way
     `aiCandidates` are merged today (`setCandidates((prev) =>
     [...(prev ?? []), ...pwCandidates])`). Wrapped in try/catch exactly
     like the existing AI-endpoint block — failures are silently ignored.
- This new confirm step is positioned **before** the existing
  browser-discovery confirm (approved design), then flow continues into the
  existing browser-confirm step unchanged.
- If no Playwright config is detected, or `auth.error` is set, this whole
  sub-flow is skipped entirely — behaves exactly as today.
- `analyzeStatusSuffix`/fake-progress behavior is unaffected — the new
  sub-phases are just inserted into the same paused/resumed progress flow
  the existing browser-confirm uses.

## CLI flag

- `synthetics` gains `--force-k6-install`, mirroring the existing
  `--force-gcx-install`: when set, always shows the `"k6-install-confirm"`
  prompt (as a reinstall offer) even if `isK6McpSupported()` is already
  true. Parsed in `src/commands/synthetics.ts` alongside the existing
  flags and threaded into `runSetupUI`/`SetupApp` the same way
  `forceGcxInstall` already is.

## Data flow summary

```
detectPlaywrightConfig(cwd)
        │ true
        ▼
isK6McpSupported()? ──► no ──► attemptInstallK6() (mac+brew only) or skip
        │ yes (or install succeeded)                              │
        ▼                                                          │
connectK6Mcp() ── one client for this whole call ◄──────────────────┘ (validator = undefined if unavailable)
        │
        ▼
discoverTests(cwd, stackUrl) ──► DiscoveredTest[]  (file, testName, describeName, summary, source)
        │
        ▼
judgeTests(candidates, stackUrl) ──► DiscoveredTest[]  (deduped, happy-path only, capped at 3)
        │
        ▼
per kept test, in parallel:
  translateToK6(test, stackUrl) ──► script | undefined
        │ script
        ▼
  validator?.validateScript(script) ──► invalid ──► translateToK6(test, stackUrl, {script, errors}) ──► validateScript again ──► still invalid ──► drop
        │ valid (or no validator)
        ▼
Candidate[]  (settings.browser.script = k6 source, selectedByDefault: false)
        │
        ▼
merged into SetupApp's `candidates` state, shown in the existing
CheckboxList review step, created via the existing `buildPlan` /
`SmClient` flow — no changes needed downstream of candidate generation.
```

## Error handling

Every function in the new pipeline degrades to "produce fewer/no
candidates" rather than throwing past its own boundary:
- No config found → `[]`, no prompt shown at all.
- No tests found / malformed JSON at any stage → `[]` for that stage.
- A single test's translation failing (even after the one retry) → that
  one candidate is dropped, others proceed.
- k6 not installed, an unsupported platform, a declined install, or a
  failed/unreachable `k6 x mcp` connection → validation is skipped
  entirely for this run; translated scripts are still offered
  unvalidated, exactly as they would be with no k6 MCP integration at
  all. This is a strict fallback, never a failure.
- Any Assistant/network failure → caught in `playwrightCandidatesFor`,
  treated as `[]`.

This matches the existing philosophy in `authoring.ts` and `discover.ts`:
AI-assisted candidate generation is a nice-to-have layered on top of a
setup flow that must otherwise keep working.

## Testing

There is no existing automated test suite under `src/` in this repo, so this
feature is validated manually:
- Run `synthetics --url <target> --stack <stack>` from inside a real
  Playwright project (e.g. `grafana-agentictesting-app`) with a mix of
  happy-path and edge-case/duplicate tests, and confirm:
  - The new confirmation prompt appears before the browser-discovery
    prompt.
  - Declining it skips straight to the existing browser-discovery prompt,
    identical to today's behavior.
  - Accepting it produces a small number of `pw-*` candidates in the review
    list, unselected by default, with plausible k6 scripts and titles/
    descriptions.
  - Running from a project with no Playwright config shows no new prompt at
    all.
  - With no k6 on `PATH`: the `"k6-install-confirm"` prompt appears;
    declining still produces `pw-*` candidates (unvalidated).
  - With k6 present (`k6 x mcp --help` exits 0): no install prompt; spot-
    check that a deliberately-broken test still produces either a fixed-up
    script (retry succeeded) or no candidate at all (retry failed) —
    never a candidate with a script `validate_script` actually rejected.
