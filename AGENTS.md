# AGENTS.md

Grafana Cloud's interactive setup wizard. Two commands, `synthetics` and `frontend`, each an Ink (React-in-the-terminal) wizard built from a shared set of steps.

```sh
npm run check   # typecheck + lint + format:check + test, same as CI
npm run build   # tsc, src -> dist
npm test        # builds, then runs tests/*.test.mjs
```

**Commit subjects must be Conventional Commits.** Changes land by squash merge and the PR title becomes the commit subject, so the PR title is what has to conform: `feat: Add a thing`, not `Add a thing`. Start the subject with a capital, since release-please copies it straight into the changelog — preferred, though not enforced. Releases are generated from these subjects, so a wrong type means a wrong version. CI checks the format against `commitlint.config.js`.

CONTRIBUTING.md covers the toolchain: the two tsconfigs, the Node version split, the ESLint rule exclusions, the release flow, and why each is set the way it is. Read it before changing a config file. The traps worth knowing up front:

- **The supported Node floor lives in `engines.node`, once.** `checkNodeVersion()` in `src/ui/shared.tsx` parses it out of the manifest and CI installs exactly that version. Do not add a hardcoded minimum next to the gate.
- **`lib` tracks `engines.node`, not the newest spec.** Raising it past what the floor's Node provides lets the compiler bless calls that crash for real users.
- **Four `react-hooks` rules are off on purpose** (`purity`, `refs`, `static-components`, `set-state-in-effect`). They target React Compiler, which this app does not run. Changing this policy is its own change, not part of the wizard modularity refactor.
- **`npm test` cannot run on the `engines.node` floor**, for a `mock.module()` bug in that Node rather than anything wrong with the wizard. Raising `engines.node` is not the fix.
- **Never hand-edit the version in package.json, CHANGELOG.md or `.release-please-manifest.json`.** release-please owns all three. To force a version, put `Release-As: x.y.z` in a commit body.

## Opening a PR or an issue

`gh pr create` does not read `.github/PULL_REQUEST_TEMPLATE.md`, so pass it explicitly (`--body-file .github/PULL_REQUEST_TEMPLATE.md`, then fill it in) or write a body with the same two headings. It is short on purpose: what changed and why, how a reviewer checks it, and whether `npm run check` passed.

For changes to visible terminal output, include **text snapshots in the PR description**, like screenshots for a GUI. Use short, labeled Before/After captures in fenced `text` blocks under "What and why", showing the affected prompts, progress, or error states. Capture actual rendered output (a mocked UI test is fine), preserve spacing, and remove ANSI escape codes and repeated animation frames. For a new screen, an After snapshot is enough.

Issues go through the forms in `.github/ISSUE_TEMPLATE` — blank issues are disabled. For a bug, the two things worth collecting before filing are the terminal output including the version line and, if the failing step talks to the Assistant, the file `--debug` writes.

## Telemetry

All of it lives in `src/telemetry.ts`. Nothing else in the tree talks to the usage-stats service, and nothing should.

Two events are reported:

- `completed_step`, once per wizard step that finished, carrying `step` and a `status`.
- `finished_setup`, once per run, carrying `outcome` and `duration_ms`.

Both carry `run_id` (one per process, groups a run's events) and, from sign-in onward, `stack_id`. Do not add a third event type: a new thing to measure is almost always a new `step` value or a new property, and keeping it that way is what lets drop-off be a single group-by instead of a union across events.

### Adding a property to an existing step

1. Add the key to `StepProperties` in `src/telemetry.ts`. It is a closed interface, so an undeclared key is a compile error rather than a silently ignored one.
2. Return it in the step's result properties.

No coordination with the receiving service is needed: step properties are carried through as-is. The same is true of adding a value to an existing string field such as `Outcome` or `StepStatus`.

Adding a new **top-level** field is different, because the receiver has to know about it. Coordinate with the team that owns the usage-stats service before doing that, and prefer a step property unless the field genuinely applies to every event.

### Adding a new step

Both product controllers use `src/ui/workflow/controller.ts` to call `recordStep` once for each returned step result. A new step belongs in the product's `model.ts` and `controller.ts`, with an async handler returning `{ next, properties }`. Give `properties` an accurate `status`.

Declare whether the step is required in its product controller. A failed required step makes the completed run `incomplete` and exits with code 1, while deliberate skips and failures in best-effort steps do not. The controller retains required failures across repeated passes and records a failed step if a handler throws. See `src/ui/README.md` for the outcome policy.

Routing-only transitions can omit properties. Synthetics uses this when the next-actions menu routes to another discovery pass, then reports that menu step when it finishes. Every analyze exit returns its own result. See `src/ui/README.md` for the structure and cancellation rules.

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
