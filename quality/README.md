# Quality rules

`require-suppression-reason.ts` is copied from T3 Code's
`oxlint-plugin-t3code/rules/require-suppression-reason.ts` at
`ea6d3fc30fb066635f31326f49b85cdee8fbf8d7`. It is licensed under the accompanying
MIT license in `LICENSE-T3`. The small local entry point avoids importing T3's
private workspace package or its unrelated UI rules.

The rule requires a reason for lint and TypeScript suppressions. Unused lint
disables also fail. Presence of a comment is a review aid, not proof that the
exception is justified. Effect diagnostic directives are not checked by this rule.

`node-test-policy.ts` is importer-owned and adapts T3's deterministic-test
principles to node:test: no focus or unconditional skips, explicit integration-clock
exceptions, and observable milestones instead of real-time sleeps.
