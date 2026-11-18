# Importer development

Use Node 26 and the T3/OMP source versions pinned by `native/t3-reference.json`
and `scripts/typecheck-native.mjs`. Do not change pins merely to make a check pass.

## Ownership

- `src/native` contains normalized contracts and declarations, with no runtime dependencies.
- Readers call native history APIs. Codex requests are limited to history methods
  and initialization; Claude imports are limited to the SDK history surface.
  OMP deliberately loads its version-checked package through Bun at runtime.
- Readers never write source history or depend on the target writer/test harness.
  Do not replace native history APIs with a JSONL parser.
- `native/cli.ts` selects readers and calls the writer; it does not decode native
  source files or write databases.
- `native/target.ts` owns persistence. T3 events and projections go through EventSink;
  importer-owned ledger/metadata SQL, inspection, backup and fixture initialization
  remain explicit exceptions. Keep the transaction and ownership lock intact.
- Tests and `native/server.ts` use temporary isolated homes. Never write the user's
  production T3 database or run paid model turns from the ordinary test suite.

`scripts/check-architecture.mjs` enforces import edges, the Codex request allowlist,
Claude history imports and obvious direct T3-table mutations. Review configuration
or allowlist relaxations as architecture changes. Static checks complement tests;
computed code, process invocations and SDK internals still need review.

## Checks

Run `npm run fmt` for mechanical formatting, then `npm run verify:changed` after edits.
Run `npm run verify` before handing off a release. CI uses that same full command.
Inspect a plan with `npm run verify:changed -- --plan --json`.

Verification runs formatting, lint/architecture, quality-tool tests/types, real native
source types and the native integration suite sequentially. Code/configuration changes
use the full test fallback; deleted and untracked code count. Documentation-only changes
skip code tests. If Git comparison is unavailable, validation falls back to full checks.

## Tests and exceptions

Use the agreed seams: native history → CLI import → a real isolated T3 server.
Write one failing behavior test before implementing each slice. Use fixed source
IDs/timestamps, assert selected branches and idempotence, await observable process/
protocol milestones, and clean up resources in `finally`. Capability/platform skips
remain visible; focused and unconditional skipped tests fail lint. A missing optional
T3 executable must not be reported as a successful real-server verification.

Lint and TS suppressions must explain why; unused lint disables fail. Real subprocess
clock reads in tests need an adjacent `Integration clock: reason` comment. Such an
exception is for readiness/deadlines, never for inventing historical source timestamps.
Keep exceptions narrow and test any new architecture or quality-rule behavior through
its public check command. See `docs/quality.md` and `quality/README.md` for provenance.
