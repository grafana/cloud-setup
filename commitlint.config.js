// Overrides two rules from the config bundled in
// grafana/shared-workflows/actions/lint-pr-title. See CONTRIBUTING.md.
//
// `extends` is required: without it the parser does not recognise the `!`
// breaking-change marker and rejects `feat!: ...` as type-empty.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 128],
    "subject-case": [0],
  },
};
