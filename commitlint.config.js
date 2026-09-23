// Exists only to relax two rules from the config bundled in
// grafana/shared-workflows/actions/lint-pr-title. Everything else, including
// the parser that understands the `!` breaking-change marker, comes from
// @commitlint/config-conventional via `extends`.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Match the org's limit rather than config-conventional's 100.
    "header-max-length": [2, "always", 128],

    // Deliberately unenforced. The bundled config requires a lower-case
    // subject, and release-please copies the subject verbatim into
    // CHANGELOG.md, so that rule decides how the changelog reads. Sentence
    // case is preferred here and used in every example in CONTRIBUTING.md, but
    // it is a preference, not a gate: rejecting a PR title over its first
    // letter costs more than the inconsistency is worth.
    "subject-case": [0],
  },
};
