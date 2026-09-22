# Contributing

```sh
npm install        # also installs the pre-commit hook, via `prepare`
npm run build      # tsc, src -> dist
npm run typecheck  # tsc, no output written
npm run lint       # eslint (type-aware, so it needs no build first)
npm run lint:fix   # eslint --fix
npm run format     # prettier --write
npm test           # builds, then runs tests/*.test.mjs
npm run check      # typecheck + lint + format:check + test, same as CI
```

`npm run check` is the whole gate. If it passes locally, CI should agree.

A `pre-commit` hook runs lint-staged (`eslint --fix`, then `prettier --write`, on staged files) followed by a whole-project typecheck. The typecheck is whole-project on purpose: a type error usually surfaces in a file the commit does not touch. It takes well under a second, so it stays in the hook rather than waiting for CI. `npm install` installs it through the `prepare` script, so a fresh clone gets it without a separate step.

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
