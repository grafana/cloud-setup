import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", ".agents/skills/synthetic-monitoring-checks/", ".claude/skills/synthetic-monitoring-checks/"],
  },

  // Type-aware, so rules like no-floating-promises can see real types.
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
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],

      "no-useless-assignment": "off",

      // React Compiler rules; this app does not run the compiler.
      // See CONTRIBUTING.md before re-enabling.
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/static-components": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },

  // Color has to come from the tokens in ui/shared.tsx. A literal at a call
  // site is an absolute value that ignores the user's terminal theme, which
  // is how `accent ?? "white"` came to paint the focused row white under
  // NO_COLOR. shared.tsx owns the tokens; authPage.ts is a real web page
  // with its own background, so absolute values are correct there; and
  // cliStyle.ts writes one raw ANSI escape by hand.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/ui/shared.tsx", "src/harness/authPage.ts", "src/cliStyle.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/^(#[0-9A-Fa-f]{3,8}|white|black|red|green|blue|yellow|cyan|magenta|gray|grey|blackBright)$/]",
          message:
            "Import a color token from ui/shared.tsx instead of naming a color here — a literal ignores the terminal theme.",
        },
      ],
    },
  },

  {
    files: ["tests/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node, sourceType: "module" },
  },

  {
    files: ["*.js", "*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node, sourceType: "module" },
  },

  // Last, so it wins over stylistic rules above.
  prettier,
);
