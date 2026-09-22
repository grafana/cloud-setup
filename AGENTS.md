# AGENTS.md

Grafana Cloud's interactive setup wizard. Two commands, `synthetics` and `frontend`, each an Ink (React-in-the-terminal) wizard built from a shared set of steps.

```sh
npm run build      # tsc, src -> dist
npm run typecheck  # tsc, no output written
npm run lint       # eslint (type-aware, so it needs no build first)
npm run format     # prettier --write
npm test           # builds, then runs tests/*.test.mjs
npm run check      # typecheck + lint + format:check + test, same as CI
```

## Node versions

Two different numbers, each written down exactly once.

`.nvmrc` pins the **toolchain**: the exact Node that contributors and CI use, currently the latest LTS. `actions/setup-node` reads it via `node-version-file` in both workflows, so no workflow hardcodes a version. Bumping it is a one-line change, and Renovate's `nvm` manager keeps it moving.

`engines.node` in package.json states the **floor the published CLI promises its users**, currently `>=22.6.0`. It is deliberately wider than `.nvmrc` — narrowing it to the pinned LTS would lock out users on 22 for no reason. Three things read it: npm warns on install, the CI `versions` job feeds it to the test matrix, and `checkNodeVersion()` in `src/ui/shared.tsx` parses it out of the manifest at runtime. Do not reintroduce a hardcoded minimum next to that gate.

CI tests both ends, the exact floor and the pinned LTS, so raising `engines.node` without meaning to shows up as a failing job rather than a surprise for someone on old Node.

## TypeScript configuration

There are two tsconfigs, and the split is deliberate.

`tsconfig.json` is the wide one: it covers `src`, the tests and `eslint.config.js`, and emits nothing. Every file in the repo belongs to it, so an editor never falls back to an inferred project. That fallback has no `@types/node`, which is what makes `console`, `process` and `setTimeout` look undefined in an editor while `npm run typecheck` stays clean.

`tsconfig.build.json` extends it, narrows to `src` and does the emit. `npm run build` uses it, so `dist` mirrors `src` exactly.

Three options in there are worth knowing about:

- `types: ["node", "react"]` is explicit rather than letting TypeScript pull in whatever happens to be under `node_modules/@types`. A transitive `@types` package can otherwise leak globals into the build and change what compiles.
- `allowJs` with `checkJs` off puts the tests in the project so Node's globals resolve there. `checkJs` stays off because the tests import the built output from `dist`, and turning it on would typecheck emitted files, which checks nothing useful.
- `verbatimModuleSyntax` and `isolatedModules` matter because emit is per-file. Without them an import that only carries types can erase to nothing and leave an unresolvable import in `dist`.

`exactOptionalPropertyTypes` is deliberately off: it produces 85 errors, almost all React prop plumbing, and is not worth the churn.

A `pre-commit` hook runs lint-staged (eslint --fix, then prettier --write, on staged files) and a whole-project typecheck. It is installed by `npm install` via the `prepare` script, so a fresh clone gets it without a separate step.

Four `react-hooks` rules are off in `eslint.config.js` (`purity`, `refs`, `static-components`, `set-state-in-effect`). They encode React Compiler's requirements, which this Ink app does not run, and satisfying them means restructuring `SetupApp.tsx` and `FrontendApp.tsx`. `rules-of-hooks` and `exhaustive-deps` are on.

## Telemetry

All of it lives in `src/telemetry.ts`. Nothing else in the tree talks to the usage-stats service, and nothing should.

Two events are reported:

- `completed_step`, once per wizard step that finished, carrying `step` and a `status`.
- `finished_setup`, once per run, carrying `outcome` and `duration_ms`.

Both carry `run_id` (one per process, groups a run's events) and, from sign-in onward, `stack_id`. Do not add a third event type: a new thing to measure is almost always a new `step` value or a new property, and keeping it that way is what lets drop-off be a single group-by instead of a union across events.

### Adding a property to an existing step

1. Add the key to `StepProperties` in `src/telemetry.ts`. It is a closed interface, so an undeclared key is a compile error rather than a silently ignored one.
2. Pass it at the `advance()` call for that step.

No coordination with the receiving service is needed: step properties are carried through as-is. The same is true of adding a value to an existing string field such as `Outcome` or `StepStatus`.

Adding a new **top-level** field is different, because the receiver has to know about it. Coordinate with the team that owns the usage-stats service before doing that, and prefer a step property unless the field genuinely applies to every event.

### Adding a new step

Both apps call `recordStep` from a single `advance(properties)` function (`FrontendApp.tsx`, `SetupApp.tsx`), so a step added to `STEP_ORDER` that exits through `advance()` reports automatically. Give it a `status`.

Watch for steps that exit some other way. `SetupApp`'s `analyze` step can leave through `advance()`, `proceedToReview()` or `backToNextSteps()`, so each of those paths calls `recordStep` explicitly. If you add a step-exit path, it needs its own call or that path goes unmeasured.

### Choosing a status

`status` exists because the wizard advances past a step whether it worked or not, so the event's existence never implies success. Be accurate about which one:

- `ok` did what it set out to do
- `failed` errored
- `declined` the user said no
- `aborted` the user gave up on a wait
- `skipped` a no-op by design

Track it in a local variable, not by reading React state you just set with a setter, which still holds its previous value inside the same closure.

### Adding a new command

Add it to `Command`, pass it through `useHardExit(command, stackUrl)` so the run event fires on every exit path, and call `requireInteractiveTerminal(command, stackUrl)` at the entry point. That last one reports runs that could not start at all, which are otherwise invisible.

If the command signs in, call `setStackIdentity(stackUrl, tokens.stackId)` once it has a session, as the shared auth step already does. The stack comes from the session itself, so this must never cost an HTTP request: do not reintroduce a lookup for it.

## What must never be reported

- **No per-person identifier.** No user ID, email, username, or anything derived from them. The identifiers a run may carry are `stack_id`, which is a Grafana Cloud stack, and `device_id`, which is a random per-install UUID the user can delete.
- **No free-form or high-cardinality values.** No URLs, hostnames, file paths, resource names, tokens, error message text, or anything the user typed. Properties are closed vocabularies, counts, or booleans. Where a step has a meaningful shape to report, report the shape: `app_resolution: "picker"`, not the app's name.
- **No raw counts of someone's inventory.** Counts of what this run did (`created`, `ai_candidates`) are fine. Counts of what the user already has are not.

If a new property cannot be expressed within those limits, that is a signal it should not be a property.

## Invariants that must not break

Telemetry is fire-and-forget, and the wizard's behaviour must not depend on it:

- Never `await` a telemetry call in a wizard path, and never give telemetry a reason to make a network request of its own. The only permitted wait is `waitForTelemetry()` at exit, which is bounded.
- Never let telemetry throw into a caller. `send()` is wrapped for this reason: it runs inside a step handler and inside the exit path, and `JSON.stringify` throws on values the compile-time types do not catch.
- Never let telemetry start authentication. It only ever uses a session the wizard already obtained.
- Keep opting out total. `CLOUD_SETUP_TELEMETRY=disabled` and `DO_NOT_TRACK=1` must send nothing, look nothing up, and write no `device_id` file.

## Checking your work

`CLOUD_SETUP_TELEMETRY=log` prints each payload to stderr and sends nothing, which is the fastest way to see exactly what a change produces. Note that runs from a source checkout report nothing by default, so `log` or an explicit `CLOUD_SETUP_TELEMETRY=enabled` is needed to see anything locally.

`tests/telemetry.test.mjs` pins the wire contract, the identity rules, and the failure behaviour. A change to what is reported should change a test there. The suite mocks transport, authentication and the state directory, so it never sends real events or touches a real `device_id`.
