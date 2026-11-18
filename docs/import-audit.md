# Import fidelity checks

An import now commits a verification manifest alongside the native T3 events, metadata and assets. It records source-selected record accounting, native IDs, field hashes, tool bodies, child links, model sections, project/directory identity and attachment hashes. The verifier reads the result from a real running T3 server; it does not declare success from database row counts alone.

## Run an audit

Stop T3 while importing, then start that same isolated home. Use a read-only local T3 token through an environment variable:

```sh
export T3_IMPORT_AUDIT_TOKEN="$(/path/to/t3 auth session issue --base-dir /path/to/isolated-t3 --scope orchestration:read --ttl 1h --token-only)"
t3-import audit --t3-home /path/to/isolated-t3 --server http://127.0.0.1:PORT --thread DESTINATION_T3_THREAD_ID --json
```

The default checks the complete imported family. `--no-family` scopes the report to one thread. The token is not a command-line argument or report field; `--token-env NAME` selects another environment variable. Only loopback server origins are supported. Auditing does not launch providers or write conversation history.

The report contains per-thread dimensions and explicit missing/extra/changed/skipped counts:

- Source record accounting from the owning native reader. An importer-visible selected record with no preserved representation rejects the import.
- User/assistant text, native item IDs and types, runs/statuses, actual tool intervals, provider-turn models, plans and subagent links.
- Thread identity, model/provider selection, project ID and directory, original child worktree directories and provider-thread identity.
- Full on-demand tool/message bodies through T3's native WebSocket RPC, reusing one connection.
- Exact opaque metadata digest and imported attachment bytes.
- Presentation constraints: child launch/run ownership and ordering, late child cards, empty initial work folds before steers, interruption confirmations attached to completed runs, and leaked prompt markup or mistaken warning styling on known routine events.

`verified` means the measured dimensions agree. `verified-with-limitations` additionally lists native API limitations or metadata-only presentation. `partial` means an explicitly incomplete check; `--structure-only` deliberately skips hydrated bodies and returns this state. `failed` identifies missing/changed records, assets, metadata or unusable evidence. `partial` and `failed` exit with code 4; setup/transport errors also fail the command. There is no invented overall percentage.

Presentation diagnostics are adapter-independent. `presentation_unplaced_subagent`, `presentation_late_subagent` and `presentation_empty_initial_work` require review and make the result partial. `presentation_invalid_launch_position` and `presentation_interrupted_run_completed` fail it. An honest missing native launch can therefore remain partial even when all available content is preserved. These constraints detect known structural causes of UI defects; they do not prove pixel fidelity. Follow the [browser checklist](browser-review.md) after a successful audit. Missing historical directories remain external source warnings, not evidence of corrupted import.

Inspect retained data with:

```sh
t3-import metadata --t3-home /path/to/isolated-t3 --thread DESTINATION_T3_THREAD_ID --json
```

Normal import JSON also identifies source coverage, schema validation, preserved extra fields and `serverVerification: "not-run"`. A successful offline write is not presented as a successful server audit.

## Native boundaries

The source readers still own format decoding and selected-branch semantics. Claude system-inclusive child histories are obtained by supplying one scoped native store to the official full history API, anchored to the child API's selected head. The SDK resolves compaction/branches; the importer does not implement a JSONL parser or parent-chain traversal. The same scoped native metadata API supplies the child's actual cwd. A divergent native head is rejected.

If a very long first Claude message exceeds the SDK file-metadata sampling window, metadata falls back to a scoped SDK store with shortened display text only. The history reader retains the original bodies. This case reports `native_session_metadata_fallback` and uses the last native record time for metadata; no current-time timestamp is fabricated. All Claude reads compare per-stream native record digests across two SDK family replays, including children, sidecars and additions/removals. A changed family rejects even snapshot import before writing target events.

OMP uses its native `collectSubSessions`, including nested, compressed and advisor histories. Aborted snapshots stay interrupted, malformed/unreadable families fail closed, and native model/compaction/visibility behavior is reused. A child card is anchored when exactly one selected task launch result names its allocated agent ID. Child snapshots have no independent continuation binding.

When an inactive OMP allocation has no transcript and no descendant history to display, its header, known launch reference and retained records go into the parent thread's native metadata. The parent's original task record remains visible.

For large Claude families, unique child histories reuse the SDK's scoped store reader instead of rediscovering every file for every child. Duplicate IDs retain the SDK's global first-path selection. Private binary IPC sends individual conversations rather than creating one family-sized JavaScript string; `show --full` also streams its JSON output. The helper has a ten-minute total deadline, a 256 MiB frame budget and a 2 GiB total response budget; exceeding a limit fails before any import rather than producing truncated history. These limits apply to decoded transport data, not the source directory's size.

The writer detects source fields removed or bounded by T3's typed/public representation and preserves them in importer metadata (`t3_import_preserved_fields`). Source usage/error metadata is retained when available. Codex history APIs do not expose historical token usage or per-turn model provenance; those remain explicit limitations.

T3's native EventSink owns ordinal normalization. The manifest uses its canonical returned events. A separate comparison rejects changes to source-owned item fields during this native normalization; only native ordinal assignment is exempted. Thread expectations use T3's exported projection reducer, preserving native provider-thread semantics.

## Limits of the evidence

The report checks the native API-selected history and the saved import snapshot, not every hidden or discarded provider branch. Provider-private reasoning, erased source data and missing historical image bytes cannot be restored by hashes. Remote images remain references with a diagnostic. Source processes should be settled; stable copied native homes are recommended because the Claude SDK has no live-process ownership probe.

T3 can bound or omit bodies in its public detail API. Such fields are retained in metadata and reported as `server_detail_bounded`; the audit verifies the server-visible form and the opaque metadata separately. It does not claim that an unexposed tail was read back through T3.

The pinned T3 browser has another independent limit: paging older turn items does not necessarily hydrate their subagent metadata into its bounded thread snapshot. A child card can open correctly while its model tooltip says `Not reported`; the full server projection still contains the native model and model selection. The full audit verifies those fields, but does not certify this tooltip. Browser review must distinguish missing persisted metadata from metadata the client did not load. Fixing that client behavior requires lazy hydration in T3 itself rather than changing a provider-native child into a different relationship or guessing a model.

Run audits before continuing/editing the imported history. Later user changes can correctly produce divergence from the recorded snapshot. Ordinary viewing/settlement timestamps are excluded from identity checks. Older imports without a manifest are unverified; the tool does not manufacture past evidence.

## Regression checks for the verifier

Real-server tests intentionally preserve counts while changing message text, remove a hydrated tool result, corrupt an attachment, and change a thread title/worktree. These must fail with record/detail/asset identity diagnostics. Additional cases check child-family traversal, opaque metadata, strict project identity, partial-mode exit status and credential-safe endpoint failures. Source fixtures separately cover system events across child compaction, native alternate branches, compressed OMP descendants, model changes, raw Codex diff forms and genuine native intervals.
