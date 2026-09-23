# Contributing

```sh
npm install             # also installs the pre-commit hook, via `prepare`
npm run build           # clean, then tsc: src -> dist
npm run typecheck       # tsc, no output written
npm run lint            # eslint (type-aware, so it needs no build first)
npm run lint:fix        # eslint --fix
npm run format          # prettier --write
npm test                # builds, then runs tests/*.test.mjs
npm run check           # typecheck + lint + format:check + test, same as CI
npm run verify:package  # pack, install the tarball, run the installed binary
```

`npm run check` is the correctness gate. If it passes locally, CI should agree. `npm run verify:package` is the packaging gate, and it is the only thing that exercises what a user actually installs.

A `pre-commit` hook runs lint-staged (`eslint --fix`, then `prettier --write`, on staged files) followed by a whole-project typecheck. The typecheck is whole-project on purpose: a type error usually surfaces in a file the commit does not touch. It takes well under a second, so it stays in the hook rather than waiting for CI. `npm install` installs it through the `prepare` script, so a fresh clone gets it without a separate step.

## Commit messages

Changes land by squash merge, and the repo is configured to use the PR title as the commit subject with an empty body. So **the PR title is the commit message**, and it has to follow [Conventional Commits](https://www.conventionalcommits.org/). CI enforces it with `grafana/shared-workflows/actions/lint-pr-title`, using that action's bundled commitlint config rather than a local copy, so this repo stays on the org-wide convention.

```
feat: add a --dry-run flag
fix(synthetics): stop defaulting the check timeout to 3s
docs: explain the two tsconfigs
chore(deps): bump zod to v4
```

Accepted types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

Two rules catch people out:

- **The subject must be lower case.** `feat: Add a flag` fails — the config rejects sentence-case, start-case, PascalCase and UPPER-CASE subjects. Nearly every PR title in this repo's history predates the check and would fail it.
- **No trailing full stop.**

Commits on your own branch are not linted, because squash merging throws them away. Only the PR title matters.

Type choice decides the version, so it is not cosmetic: `fix` bumps the patch, `feat` bumps the minor, and `feat!` (or a `BREAKING CHANGE:` footer) bumps the minor while the package is pre-1.0. `chore`, `ci`, `style`, `test` and `build` are hidden from the changelog.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please), which is also what `grafana/shared-workflows` uses.

1. Merging to `main` runs `release.yml`, which opens or updates a **release PR** that bumps the version and writes `CHANGELOG.md` from the commit subjects since the last release.
2. Merging that release PR tags the commit and creates a GitHub Release.
3. `release.yml` then dispatches `publish.yml`, which publishes to npm.

Step 3 is a `workflow_dispatch` rather than the `release: published` event because **a release created with `GITHUB_TOKEN` does not fire that event** — GitHub suppresses it so automation cannot trigger itself recursively. `workflow_dispatch` and `repository_dispatch` are the two documented exceptions.

The publish deliberately stays in `publish.yml` instead of moving into `release.yml`. npm trusted publishing matches on the workflow _filename_, and for a reusable workflow it matches the **calling** workflow, so a `workflow_call` would need the trusted publisher on npmjs.com reconfigured and would break the manual path. A dispatch keeps `publish.yml` as the top-level workflow, so the existing npm config holds.

`bump-minor-pre-major: true` is set in `release-please-config.json` for a reason. By default a breaking change takes a `0.x` package straight to `1.0.0`; from release-please's own source:

```js
if (breaking > 0) {
  if (version.isPreMajor && this.bumpMinorPreMajor) return new MinorVersionUpdate();
  else return new MajorVersionUpdate(); // ← the default
}
```

While this is a development preview, `0.1.1` plus a `feat!` should become `0.2.0`, not `1.0.0`.

release-please owns the version in `package.json`, `CHANGELOG.md` and `.release-please-manifest.json`. Do not hand-edit any of them. To force a specific version, put `Release-As: 1.2.3` in a commit body.

`publish.yml` can still be run by hand — publish a GitHub Release, or dispatch it with a tag — which is the fallback if the automated path breaks.

## Not shipping broken code

`npm run check` gates correctness, but it only ever imports from `dist` in place. It cannot see a packaging mistake. `npm run verify:package` covers that gap: it packs the tarball, asserts the `bin` is present and starts with a shebang, installs the tarball into a throwaway project, and runs the installed binary.

That catches the failures that install cleanly and only break when a user runs the CLI: a missing shebang, a wrong `bin` path, a file `files` excludes, or an import that resolves inside the repo but is absent from `dependencies`. CI runs it on both the pinned Node and the `engines.node` floor.

Three package scripts keep the artifact honest:

- `clean` (`rm -rf dist`) runs before every build. `tsc` never deletes anything, so without it a renamed or deleted source leaves its old `.js` in `dist` and `npm pack` ships it. This was real: the tarball once contained `checkAlerts.js` and `notifications.js` from a branch that was never merged.
- `prepack` rebuilds, so `npm pack` and `npm publish` always package a freshly compiled tree rather than whatever happened to be on disk.
- `prepublishOnly` runs `npm run check`, so a publish from a laptop is gated the same way CI is.

The `rm -rf` is not portable to Windows `cmd`. Neither is the existing `npm test`, which relies on the shell expanding `tests/*.test.mjs`, so this adds no new constraint.

## Node versions

Two different numbers, each written down exactly once.

`.nvmrc` pins the **toolchain**: the exact Node contributors and CI use, currently the latest LTS. `actions/setup-node` reads it through `node-version-file` in both workflows, so no workflow spells out a version. Renovate's `nvm` manager keeps it current.

`engines.node` states the **floor the published CLI promises its users**, currently `>=22.6.0`. It is deliberately wider than `.nvmrc`; narrowing it to the pinned LTS would lock out users on 22 for no reason. Three things read it: npm warns on install, the `oldest-supported-node` CI job installs exactly that version, and `checkNodeVersion()` in `src/ui/shared.tsx` parses it out of the manifest at runtime.

`oldest-supported-node` runs the built CLI rather than `npm test`, and that is not laziness. The suite's `mock.module()` mis-resolves a bare specifier inside Ink on 22.6.0 (`Cannot find module .../ink/build/@alcalzone/ansi-tokenize`), fixed in a later 22.x. The wizard itself runs fine there, verified directly, so the floor is honest even though the suite cannot run on it. If you want the suite green on the floor too, raising `engines.node` is the wrong fix: the product works, the harness is what needs the newer Node.

## TypeScript configuration

There are two tsconfigs.

`tsconfig.json` is the wide one: `src`, the tests and `eslint.config.js`, emitting nothing. Every file in the repo belongs to it, so an editor never falls back to an inferred project. That fallback has no `@types/node`, which is what makes `console`, `process` and `setTimeout` look undefined in an editor while `npm run typecheck` stays clean.

`tsconfig.build.json` extends it, narrows to `src` and does the emit. `npm run build` uses it, so `dist` mirrors `src` exactly.

`target` and `lib` are `ES2024`, and the number that decides them is `engines.node`, not the newest spec or the pinned LTS. Every ES2024 addition works on 22.6.0, checked feature by feature including the RegExp `v` flag. `ESNext` would not be safe: `Promise.try`, `RegExp.escape`, `Float16Array` and `Error.isError` are all absent on 22.6.0, so it would let the compiler bless calls that crash for a user on the oldest Node the package supports. (TypeScript 5.9 has no `ES2025`; `ES2024` is the highest real value, then `ESNext`.)

Three more options worth knowing about:

- `types: ["node", "react"]` is explicit rather than letting TypeScript pull in whatever happens to sit under `node_modules/@types`. A transitive `@types` package can otherwise leak globals in and change what compiles.
- `allowJs` with `checkJs` off puts the tests in the project so Node's globals resolve there. `checkJs` stays off because the tests import the built output from `dist`, and turning it on would typecheck emitted files, which checks nothing useful.
- `verbatimModuleSyntax` and `isolatedModules` matter because emit is per-file. Without them an import that only carries types can erase to nothing and leave an unresolvable import in `dist`.

`exactOptionalPropertyTypes` is deliberately off: it produces 85 errors, almost all React prop plumbing, and is not worth the churn.

## Formatting and linting

Prettier runs at `printWidth: 120`, the width the code was already written to, and `proseWrap: preserve` so markdown prose is never hard-wrapped.

ESLint is a flat config using `typescript-eslint`'s type-aware rules, so it needs no build first. Four `react-hooks` rules are off (`purity`, `refs`, `static-components`, `set-state-in-effect`). They encode React Compiler's requirements, which this Ink app does not run, and satisfying them means restructuring `SetupApp.tsx` and `FrontendApp.tsx` — nested render functions, refs read during render, `Date.now()` in a `useRef` initializer. Worth doing as its own change. `rules-of-hooks` and `exhaustive-deps` are on. `no-useless-assignment` is off because it flags initializers that exist so a value can outlive the `try` block computing it.

`@typescript-eslint/no-floating-promises` is on, which is what makes the "never `await` telemetry" rule in AGENTS.md enforceable: a deliberate fire-and-forget call has to say so with `void`.

## CI

Three jobs. `checks` runs typecheck, lint and format check on the pinned Node. `test` runs the suite on the pinned Node. `oldest-supported-node` builds and starts the CLI on the `engines.node` floor. `checks` keeps its steps separate with `if: ${{ !cancelled() }}` so all three report rather than stopping at the first failure.
