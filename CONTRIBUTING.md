# Contributing

```sh
npm install             # also installs the pre-commit hook, via `prepare`
npm run check           # typecheck + lint + format:check + test, same as CI
npm run verify:package  # pack, install the tarball, run the installed binary
npm run build           # clean, then tsc: src -> dist
npm run lint:fix        # eslint --fix
npm run format          # prettier --write
```

`npm run check` is the correctness gate; `npm run verify:package` is the packaging gate, and the only thing that exercises what a user installs.

A `pre-commit` hook runs lint-staged on staged files, then a whole-project typecheck. Whole-project because a type error usually surfaces in a file the commit does not touch, and it takes under a second.

## Commit messages

Changes land by squash merge, and the repo uses the PR title as the commit subject with an empty body. **The PR title is the commit message**, so it is the PR title that must follow [Conventional Commits](https://www.conventionalcommits.org/). CI enforces this with `grafana/shared-workflows/actions/lint-pr-title`, pointed at this repo's `commitlint.config.js`.

```
feat: Add a --dry-run flag
fix(synthetics): Stop defaulting the check timeout to 3s
chore(deps): Bump zod to v4
```

Types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`. Subjects take no trailing full stop, and `feat!` or a `BREAKING CHANGE:` footer marks a breaking change.

**Please start the subject with a capital**, as the examples above do. release-please copies the subject verbatim into `CHANGELOG.md`, so this is the case the changelog reads in. It is a preference rather than a gate: `commitlint.config.js` disables `subject-case`, so a lower-case subject passes CI too. Rejecting a PR title over its first letter would cost more than the inconsistency is worth.

That config exists only to relax two rules from the one bundled in the shared action — the case rule above, and `header-max-length`, kept at the org's 128. Everything else, including the parser that understands `!`, comes from `@commitlint/config-conventional` through `extends`, which the action supplies. Nothing needs installing to run the check.

The type sets the version bump, so it is not cosmetic: `fix` bumps the patch, `feat` the minor, and `feat!` also the minor while the package is pre-1.0. Only `feat`, `fix`, `perf`, `revert` and `docs` appear in the changelog; `refactor`, `build`, `ci`, `chore`, `style` and `test` are hidden, since they describe work on the repo rather than anything a user of the CLI sees.

Commits on a branch are not linted, since squash merging discards them.

## Releases

release-please generates releases from those subjects.

1. Merging to `main` opens or updates a **release PR** that bumps the version and writes `CHANGELOG.md`.
2. Merging the release PR tags the commit and creates a GitHub Release.
3. `release.yml` then dispatches `publish.yml`, which publishes to npm.

The release PR is a queue: it keeps recalculating as commits land, so merge it when there is something worth shipping.

release-please owns the version in `package.json`, `CHANGELOG.md` and `.release-please-manifest.json`. Do not hand-edit them. To force a version, put `Release-As: 1.2.3` in a commit body.

`publish.yml` can also be run by hand, which is the fallback if the automated path breaks: publish a GitHub Release, or dispatch the workflow with a tag.

Two settings look arbitrary and are not:

- **Step 3 is a `workflow_dispatch`, not the `release: published` event.** A release created with `GITHUB_TOKEN` does not fire that event, because GitHub suppresses it to prevent recursive runs. `workflow_dispatch` is one of two documented exceptions. The publish stays in `publish.yml` rather than becoming a reusable workflow because npm trusted publishing matches on workflow filename, and for a reusable workflow it matches the calling workflow.
- **`bump-minor-pre-major: true`.** Without it, the first breaking change takes a `0.x` package straight to `1.0.0`.

## Packaging

`npm run check` only imports `dist` in place, so it cannot see a packaging mistake. `npm run verify:package` packs the tarball, asserts the `bin` exists and starts with a shebang, installs it into a throwaway project, and runs the installed binary. That covers the failures which install cleanly and break on first run: a missing shebang, a wrong `bin` path, a file excluded by `files`, or an import that resolves in the repo but is absent from `dependencies`. CI runs it on the pinned Node and on the `engines.node` floor.

Three scripts keep the artifact honest. `clean` runs before every build, because `tsc` never deletes and a renamed source otherwise leaves its old output in `dist` for `npm pack` to ship. `prepack` rebuilds, so pack and publish always package a fresh tree. `prepublishOnly` runs `npm run check`, so a publish from a laptop is gated like CI.

## Node versions

Two numbers, each written down once.

`.nvmrc` pins the **toolchain**: the exact Node contributors and CI use, currently the latest LTS. Both workflows read it through `node-version-file`. Renovate keeps it current.

`engines.node` is the **floor the published CLI promises users**, currently `>=22.6.0`, deliberately wider than `.nvmrc`. Three things read it: npm on install, the `oldest-supported-node` CI job, and `checkNodeVersion()` in `src/ui/shared.tsx`, which parses it out of the manifest at runtime.

That job runs the built CLI instead of `npm test` for a specific reason: the suite's `mock.module()` mis-resolves a bare specifier inside Ink on 22.6.0 (`Cannot find module .../ink/build/@alcalzone/ansi-tokenize`), fixed in a later 22.x. The wizard itself runs there, verified directly, so the floor is accurate even though the suite cannot run on it. Raising `engines.node` would be the wrong fix.

## TypeScript

`tsconfig.json` covers `src`, the tests and `eslint.config.js`, and emits nothing. Every file in the repo belongs to it, so an editor never falls back to an inferred project — that fallback has no `@types/node`, which makes `console` and `process` appear undefined while `npm run typecheck` stays clean. `tsconfig.build.json` extends it, narrows to `src` and does the emit.

`target` and `lib` are `ES2024`, decided by `engines.node` rather than the newest spec. Every ES2024 addition works on 22.6.0. `ESNext` would not: `Promise.try`, `RegExp.escape`, `Float16Array` and `Error.isError` are all absent there, so it would let the compiler approve calls that crash on the oldest supported Node.

Also deliberate: `types: ["node", "react"]` is explicit so a transitive `@types` package cannot leak globals in; `allowJs` with `checkJs` off puts the tests in the project without typechecking the `dist` files they import; `verbatimModuleSyntax` and `isolatedModules` stop a type-only import erasing to an unresolvable import in `dist`. `exactOptionalPropertyTypes` is off, since it produces 85 errors, almost all React prop plumbing.

## Formatting and linting

Prettier runs at `printWidth: 120`, the width the code was already written to, with `proseWrap: preserve` so markdown prose is never hard-wrapped.

ESLint uses `typescript-eslint`'s type-aware rules, so it needs no build first. Four `react-hooks` rules are off (`purity`, `refs`, `static-components`, `set-state-in-effect`): they encode React Compiler's requirements, which this Ink app does not run, and changing that lint policy is separate from the wizard refactor. `rules-of-hooks` and `exhaustive-deps` stay on. `no-useless-assignment` is off because it flags initializers that exist so a value can outlive the `try` block computing it.

`@typescript-eslint/no-floating-promises` is on, which makes the "never `await` telemetry" rule in AGENTS.md enforceable: a deliberate fire-and-forget call must say so with `void`.

## Wizard workflows

See [the UI development guide](src/ui/README.md) for step modules, typed prompts, cancellation, and testing workflows with injected services.
