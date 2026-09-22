import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", ".agents/skills/synthetic-monitoring-checks/", ".claude/skills/synthetic-monitoring-checks/"],
  },

  // The TypeScript sources, type-aware so rules like no-floating-promises and
  // no-base-to-string can actually see through to the real types.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked, reactHooks.configs.flat.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      // Underscore-prefixed bindings are the escape hatch for a parameter that
      // has to exist for position but is not used, e.g. Ink's
      // useInput((_input, key) => ...).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Telemetry and the effect bodies in SetupApp/FrontendApp are deliberately
      // fire-and-forget, but they have to say so with an explicit `void`.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],

      // Off on purpose: flags `let x = 0` that is always overwritten before it
      // is read. Several of those initializers exist so a value can outlive the
      // try block that computes it, which reads better than a bare `let x:
      // number` relying on definite-assignment analysis.
      "no-useless-assignment": "off",

      // The rules below ship in eslint-plugin-react-hooks v7 and encode React
      // Compiler's requirements. This is an Ink app that does not run the
      // compiler, and satisfying them means restructuring SetupApp.tsx and
      // FrontendApp.tsx (nested render functions, refs read during render,
      // Date.now() in a useRef initializer). Worth revisiting as its own
      // change; not something to hold linting hostage to.
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/static-components": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },

  // The test suite is plain ESM JavaScript run by node:test, so it is outside
  // tsconfig and gets the untyped rule set.
  {
    files: ["tests/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node, sourceType: "module" },
  },

  // Config files at the repo root.
  {
    files: ["*.js", "*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node, sourceType: "module" },
  },

  // Last, so it can switch off anything Prettier already decides.
  prettier,
);
