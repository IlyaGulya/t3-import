# Native importer validation

Validated on macOS on 2026-11-17 with Node 26, Bun 1.4.4, the installed T3 0.1.10 server (migration 96), Codex 0.169.0, OMP 18.22.0 and Claude Agent SDK 0.3.321. The writer builds against T3 commit `ea6d3fc30fb066635f31326f49b85cdee8fbf8d7`; native writer tests also cover migrations 97 and 98.

## Automated checks

All 68 tests passed locally with zero skips. Typechecking checked 21 importer files against the actual pinned upstream types. A packed installation in a temporary directory read all three native sources and exercised the OMP RPC bridge without access to the T3 source checkout.

The integration path includes native history APIs, the public import CLI, and reads from a separate real T3 server. Coverage includes model switches, compaction, attachments, selected branches, tool results, child histories, unfinished snapshots, pagination, repeated imports, directory grouping and preserved per-thread working directories.

Tests that need an installed T3 server use `T3_TEST_SERVER_BINARY`, falling back to `~/.t3/bin/t3`, and report a skip if it is absent. Executable Unix fixtures report a skip on Windows. Ordinary tests never start model turns; live continuation checks are separate manual runs.

## Real continuation

Short sessions were created with each native tool in isolated source homes, imported with native continuation bindings, then continued through a separate T3 server. Codex, Claude and OMP each returned an exact random marker from the preceding native conversation and reached a completed T3 run. These checks used copied authentication/configuration and temporary workspaces.

Reading each original native session again confirmed that the new responses were persisted under the original native session IDs.

Direct OMP 18.22.0 RPC preserved context but exposed a runtime incompatibility: OMP emits `session_settled`, while T3 Pi expects `agent_settled`. The bundled version-checked `t3-import-omp` bridge translates that event. The live OMP check completed with the bridge; direct continuation bindings are rejected to prevent a permanently running T3 turn.

## Real archives

The browser demo contains 72 threads and 30,557 projected history items across all three sources. Native server reads verified every root history page. Browser checks confirmed rendered Markdown tables, no horizontal overflow or false live-child status, and the corrected OMP response duration of 1 minute 36 seconds. A later idle model change remains visible without extending that response.

A separate large Claude archive contained a 201 MB root and approximately 1.66 GB across its family. The native SDK listed 2346 agent IDs, including 33 duplicates: all 2313 unique children plus the root imported as 2314 threads, with 2378 turns, 81,687 native items and 5086 messages. The import took 285 seconds and peaked at approximately 2.48 GB RSS; repeating it returned `already-imported` for every thread.

The real T3 server read all 2314 imported thread projections, including 84,000 projected items (native items plus child links), all 12 root history pages and native-text samples from 25 threads. Browser inspection exposed missing launch references being incorrectly assigned to the first parent run. A separate real-server regression now covers both absent and named-but-missing launch references; their histories remain linked at thread scope with no guessed run ownership.

The isolated previews were corrected through native EventSink maintenance, preserving the already verified histories and import ledgers. The large preview detached 1243 orphan links while retaining 1070 confirmed launches; its parent response spans are at most 175.629 seconds. The smaller preview detached 35 Claude links while retaining 34 confirmed Codex launches. Native IDs, payload hashes, timestamps, lineage and fork references remained intact. Browser checks confirmed corrected parent timing and accessible child history without false live status or horizontal overflow. Ordinary replay protection correctly refuses to overwrite these maintenance events; the successful full no-op check was performed before maintenance, and fresh-import idempotence is covered separately by the regression suite.

Durations follow stored source timestamps and can include real pauses inside a native history. They do not measure active compute time; genuine source gaps are retained.

The large archive has unanswered native tails, so its default import correctly rejects an indeterminate source. The explicit `--snapshot --no-resume` check retains those tails as interrupted history with their original IDs. Snapshot mode does not disable source-change checks or claim to detect a live Claude process.

Private source copies, transcripts, access credentials and detailed verification evidence stay in ignored `artifacts/`; they are excluded from Git and the package. The production T3 database was not used as an import target.
