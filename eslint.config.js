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

  // Color and icons come from src/theme.ts. A literal at a call site is a
  // value that ignores the terminal theme, which is how `accent ?? "white"`
  // came to paint the focused row white under NO_COLOR; a stray glyph is how
  // the tree ended up using both U+2716 and U+2717 for one failure state.
  // authPage.ts is a real web page with its own background, so absolute
  // colors are correct there.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/theme.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/^(#[0-9A-Fa-f]{3,8}|white|black|red|green|blue|yellow|cyan|magenta|gray|grey|blackBright)$/]",
          message: "Import a color from theme.ts instead of naming one here — a literal ignores the terminal theme.",
        },
        {
          selector: "Literal[value=/[\\u2713\\u2714\\u2716\\u2717\\u25CB\\u25CF\\u203A\\u23CE\\u2191\\u2193]/]",
          message: "Use an ICONS entry from theme.ts instead of writing the glyph, so the set stays consistent.",
        },
        {
          selector: "JSXText[value=/[\\u2713\\u2714\\u2716\\u2717\\u25CB\\u25CF\\u203A\\u23CE\\u2191\\u2193]/]",
          message: "Use an ICONS entry from theme.ts instead of writing the glyph, so the set stays consistent.",
        },
        {
          selector:
            "TemplateElement[value.raw=/[\\u2713\\u2714\\u2716\\u2717\\u25CB\\u25CF\\u203A\\u23CE\\u2191\\u2193]/]",
          message: "Use an ICONS entry from theme.ts instead of writing the glyph, so the set stays consistent.",
        },
      ],
    },
  },

  // authPage.ts builds an HTML document, where absolute colors are correct.
  {
    files: ["src/harness/authPage.ts"],
    rules: { "no-restricted-syntax": "off" },
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
