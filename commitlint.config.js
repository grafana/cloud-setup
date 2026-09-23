// Mirrors the config bundled in grafana/shared-workflows/actions/lint-pr-title,
// with one deliberate difference: subject-case is inverted so subjects start
// with a capital. release-please copies the commit subject verbatim into
// CHANGELOG.md, and this repo prefers "* Add a --dry-run flag" over
// "* add a --dry-run flag".
//
// Stated as `never` against the other cases rather than `always sentence-case`,
// because commitlint's sentence-case check only looks at the first character
// and so would also accept "ADD A FLAG" and "Add A Flag".
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-leading-blank": [1, "always"],
    "body-max-line-length": [2, "always", 100],
    "footer-leading-blank": [1, "always"],
    "footer-max-line-length": [2, "always", 100],
    "header-max-length": [2, "always", 128],
    "subject-case": [2, "never", ["lower-case", "start-case", "pascal-case", "upper-case"]],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "type-case": [2, "always", "lower-case"],
    "type-empty": [2, "never"],
    "type-enum": [
      2,
      "always",
      ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"],
    ],
  },
};
