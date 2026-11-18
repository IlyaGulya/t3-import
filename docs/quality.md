# Quality checks

The importer uses standalone Oxfmt 0.74.0, Oxlint 1.89.0 and `@oxlint/plugins`
1.89.0, pinned in the lockfile. They run without T3's Vite+/pnpm workspace.

- `npm run fmt` formats owned files. Generated output, references, private research
  artifacts, dependencies and the lockfile are excluded.
- `npm run lint` combines the architecture checker with actual Oxlint, treating
  correctness diagnostics and warnings as failures.
- `npm run test:quality` tests real check commands against temporary negative and
  positive projects. It does not mock the linter or inspect private rule functions.
- `npm run verify` runs format, lint, quality tests/types, native types and native
  tests sequentially. The native test runner already builds the packed CLI paths.
- `npm run verify:changed` reads staged, unstaged, deleted and untracked files against
  HEAD. Any code/configuration change gets the full test suite; documentation-only
  changes run format/lint. No Git/HEAD means a conservative full fallback.
- Append `-- --plan --json` to either verification command to inspect its steps.

Architecture checks use the TypeScript AST and resolver, including local aliases,
`.js`→`.ts` resolution, re-export barrels and literal dynamic imports. They enforce
runtime-free normalized contracts, reader/CLI/writer ownership, native Codex RPC
method types, named Claude history imports and the writer's pinned T3 source imports.
Obvious T3-table SQL mutations must go through EventSink. Importer ledger/metadata
SQL, backups, inspection and explicit fixture migrations remain allowed.

These are guardrails, not a complete proof of read-only behavior. Intentional OMP
runtime loading remains supported. A malicious/incorrect computed dependency, SDK
method alias, generated SQL or child process can require additional review/tests.

The minimal suppression rule is vendored with its upstream MIT license and exact
source pin in `quality/README.md`. It checks lint/TypeScript suppressions; standalone
Effect directives/config-level disables still need review. Unused lint disables fail.
The local node:test policy rejects focused/unconditional skipped tests and requires
fixed test clocks or an explicit real-subprocess integration explanation. Real-time
sleeps (including timer import aliases) must use observable process/protocol milestones. Conditional
capability/platform skips and bounded integration timeouts remain legitimate.

Integration tests read results from real isolated T3 servers when its executable is
installed. CI's ordinary cross-platform lane does not install that binary, so any
capability skips remain reported. Release verification must separately record an
actual real-server run, rather than treating a skipped case as that evidence.
