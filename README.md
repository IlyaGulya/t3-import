# t3-import

Import rich Codex, Oh My Pi and Claude Code history into current T3 Code using the tools that own the formats:

- Codex's `app-server` reads sessions, turns and items through T3's typed client.
- Oh My Pi's installed package reads its own entries, branches, compactions and image blobs.
- Claude Agent SDK reads selected session histories and native child-agent transcripts.
- T3's pinned `EventSink` and repositories write events, projections and native resume bindings.

There is no independent rollout parser or copy of T3's projection SQL. This version replaces the old importer; it supports **T3 migrations 96–98**, not the earlier 40–53 schemas. The CLI provides `list`, `show`, `projects`, `doctor` and `import`. It does not include the old TUI, parsers, `sync` or `replace` commands.

## Build

Requires Node.js 26+, Git and npm. OMP reading additionally needs Bun and the installed `@oh-my-pi/pi-coding-agent@18.22.0` package. The build uses a pinned T3 checkout; the built Codex CLI does not need that checkout at runtime.

```sh
git clone --filter=blob:none https://github.com/pingdotgg/t3code.git repos/t3code
git -C repos/t3code checkout ea6d3fc30fb066635f31326f49b85cdee8fbf8d7
bun add --global @oh-my-pi/pi-coding-agent@18.22.0
npm ci
npm run build
node dist/cli.js --help
```

An existing sibling `../t3code` checkout is also detected. Set `T3_NATIVE_REFERENCE_REPO` to use another checkout. The builder rejects the wrong commit and tracked source edits so a new upstream version cannot silently change the persistence code.

## Codex

List and inspect history while T3 is running:

```sh
node dist/cli.js list --source codex --workspace /path/to/project
node dist/cli.js show --source codex --workspace /path/to/project --thread SESSION_ID
node dist/cli.js doctor
```

Review an import without writing, then close the T3 application/server before writing:

```sh
node dist/cli.js import --source codex --workspace /path/to/project --thread SESSION_ID --dry-run
node dist/cli.js import --source codex --workspace /path/to/project --thread SESSION_ID --yes
```

Repeat `--thread` to select several sessions, or use `--all` with `--workspace`. `--since ISO_TIMESTAMP` filters by updated time. `--archived` selects archived Codex sessions. `--source-home` selects another Codex home; `--binary` selects the Codex executable. The reader pages through full native history and never starts/resumes a model turn.

## Project grouping

By default, all three sources reuse the same T3 project when their working directories resolve to the same canonical directory. Existing symlink aliases are resolved. Subdirectories, worktrees and separate clones stay separate; matching repository names or Git remotes do not merge projects automatically. `--workspace` selects source sessions and does not change their destination grouping.

Use the same `--project-root` for each import to group sessions from different directories under one project. The project is reused or created for that root:

```sh
node dist/cli.js import --source codex --workspace /repo/worktrees/fix --thread SESSION_ID --project-root /repo --no-resume --dry-run
node dist/cli.js import --source omp --workspace /repo/packages/app --thread SESSION_ID --project-root /repo --no-resume --dry-run
node dist/cli.js import --source claude --workspace /another/clone --thread SESSION_ID --project-root /repo --no-resume --dry-run
```

List destination projects with `node dist/cli.js projects --t3-home /path/to/isolated-t3`, then use `--project-id PROJECT_ID` to select one explicitly. `--project-root` and `--project-id` are mutually exclusive. If several existing projects have the same canonical root, an explicit ID is required. A repeat import with a changed destination is rejected; this does not move previously imported threads.

Grouping keeps each session's original directory, including child-agent directories. T3 stores a differing directory in the thread's native `worktreePath` field so later execution uses that directory. Some T3 controls may label such a directory as a worktree even when it is an ordinary folder; the importer does not invent a Git branch or create a worktree.

## Oh My Pi

OMP's installed source package is loaded by a small Bun helper. Its read-only loader, native tree index, format migrations and blob resolver supply the history. It does not open a writable SessionManager or launch an OMP agent.

Turn timing ends at the native terminal response. Later idle model changes and compaction records retain their original timestamps as session activity outside that response. Displayed durations are elapsed native response times, not a measurement of billable compute or active CPU time.

```sh
node dist/cli.js list --source omp --workspace /path/to/project
node dist/cli.js show --source omp --workspace /path/to/project --thread SESSION_ID
node dist/cli.js import --source omp --workspace /path/to/project --thread SESSION_ID --no-resume --dry-run
```

For OMP, `--source-home` is the **agent directory**, normally `~/.omp/agent`, containing `sessions` and `blobs`. `--omp-package` selects an installed package directory explicitly; `--bun-binary` selects Bun. The installed package remains a runtime dependency of the OMP helper; its supported version is checked before reading.

To continue an imported OMP session in T3, configure an enabled **Pi driver instance that runs `t3-import-omp`**, with the matching OMP agent directory, then pass its instance ID:

```sh
node dist/cli.js import --source omp --workspace /path/to/project --thread SESSION_ID --provider-instance omp --dry-run
```

The Pi/RPC binding uses the original session file path. OMP's ACP binding uses a different contract and is not used here. `--no-resume` imports visible history without attaching a native session.

`t3-import-omp` is bundled with this package (the executable file is `dist/omp.js`). It launches the installed native `omp` and translates its `session_settled` RPC frame to T3 Pi's `agent_settled`; all commands and other frames pass through unchanged. Without this compatibility step, OMP 18.22.0 can answer correctly while T3 keeps its run in `running`. Set `T3_IMPORT_OMP_BINARY` in that provider instance's environment if the native `omp` executable is not on its PATH. The bridge checks the native version before starting, and currently supports only 18.22.0. Direct native `omp` continuation bindings are rejected; history-only imports do not need the bridge.

OMP profile overrides (`OMP_PROFILE`, `PI_PROFILE` or `--profile` in the provider launch arguments) can redirect settings and blob storage independently of `PI_CODING_AGENT_DIR`. Continuation bindings with these overrides are currently rejected; import their history with `--no-resume`.

Continuation also requires an absolute effective `PI_CODING_AGENT_DIR` when overridden, and rejects custom `PI_CONFIG_DIR` roots until native directory resolution can be verified. These restrictions do not prevent history-only imports.

## Claude Code

The pinned `@anthropic-ai/claude-agent-sdk@0.3.321` supplies `listSessions`, `getSessionInfo`, `getSessionMessages`, `listSubagents` and `getSubagentMessages`. A Node helper gives the SDK its own `CLAUDE_CONFIG_DIR`; it never starts a query or a model process.

```sh
node dist/cli.js list --source claude --workspace /path/to/project
node dist/cli.js show --source claude --thread SESSION_ID
node dist/cli.js import --source claude --workspace /path/to/project --thread SESSION_ID --no-resume --dry-run
```

`--source-home` selects the Claude config directory, normally `~/.claude`. Native child and grandchild histories become linked historical T3 threads. Claude's subagent history API does not supply an independent resumable session, so those children remain history-only even when root continuation is enabled.

When a native child has no matching launch item in the selected parent history, its thread relationship is retained without assigning it to a guessed parent turn. Its historical activity stays outside unrelated response durations.

Old Claude archives may end in an unanswered user request or unfinished tool call. The default importer rejects these indeterminate tails. To keep them deliberately as interrupted historical snapshots, use `--snapshot --no-resume`, preferably against a copied, stable Claude config directory:

```sh
node dist/cli.js import --source claude --source-home /path/to/copied-claude --workspace /path/to/project --thread SESSION_ID --snapshot --no-resume --dry-run
```

Snapshot mode preserves native IDs, contents and unfinished tool calls; it creates no continuation binding and fabricates no completed result. The flag is Claude-only and requires `--no-resume`. Root source changes detected during reading still reject the import. The native SDK has no live-process ownership probe, so snapshot mode does not claim that the original process has stopped.

The SDK exposes less information than the raw store: some system records lack their payload, and it has no live-process ownership probe. Available compaction summaries and native timestamps are preserved. Missing system payloads and legacy text replies without a stop reason are reported. A stable text-only historical reply with no unfinished tool call is treated as settled; an unfinished tool tail is blocked.

Document and other non-image input blocks retain a visible reference and their complete native payload as historical tool content. T3's image attachment presentation cannot render them as native document attachments; the importer reports that limitation.

## What is preserved

Terminal runs and their native references; all visible user/assistant messages, including steers in the same run; visible reasoning; command output/status; file changes; tools; plans; compaction markers; supported local/inline images. There is no 30-day window, 200-message tail or representative-tool compaction policy. Source APIs may omit data they no longer retain; the importer reports unsupported visible records and media rather than claiming a raw byte-for-byte archive.

OMP imports the native selected branch and follows native transcript visibility rules, excluding hidden bookkeeping. Its model changes are preserved per run and per assistant response, including switches inside one run. Codex currently exposes only its current thread model; unavailable historical model provenance is explicitly reported.

Codex and Claude child histories become linked T3 threads when supplied by the native API. Original spawn tool records remain visible. These are terminal historical records; the importer does not start live child agents or invent historical Git checkpoints.

## Storage and repeat imports

`--t3-home` selects the target home (default `T3CODE_HOME`, then `~/.t3`). The target is `userdata/statev2.sqlite`. Initialize that home with T3 itself before importing; normal import does not migrate or create a T3 database.

- `--dry-run` uses read-only target access and does not stage files, write a ledger or create backups.
- Real writes hold T3's native ownership lock and require the server to be stopped.
- Each write creates a SQLite backup and verifies its integrity first.
- Events, projections, resume binding and import fingerprint are committed atomically; failed batches clean up their new image files.
- No execution effects or provider workers are started by the writer.
- Re-importing identical history reports `already-imported` without adding events or a backup.
- Changed source history, deleted/edited target history or a native session already owned by another T3 thread produce a conflict. Incremental synchronization and replacement are not implemented in this version.
- Resume checks the configured provider driver, enabled state and source home. OMP also requires an OMP executable. The importer does not switch providers or accounts automatically.

Remote images are retained as references and are not downloaded. Source blobs that are missing or unsupported produce a diagnostic. Image presentation for tool variants may be limited by T3; any such omission is reported.

`--json` prints one JSON result on stdout. `show --full` includes the normalized conversation content, so use it only when that output is wanted. The built artifact includes the pinned T3 reference and its MIT notice.

## Validation

```sh
npm run typecheck
npm test
npm run build
npm pack
```

Type checking checks this importer's files against actual pinned T3 source types; it does not re-check the T3 monorepo. Tests bundle native T3 modules and exercise isolated databases at every supported migration, dry-run immutability, rich history, model switches, linked children, repeat imports, conflicts, ownership locks and transaction rollback. Reader tests use the native source libraries and literal source fixtures. Codex protocol tests also use a fake app-server with T3's real client.

The real-server integration test uses an installed T3 executable (`~/.t3/bin/t3`, or `T3_TEST_SERVER_BINARY`) with a fresh home, disabled providers and its own loopback port. It checks HTTP history pagination, native RPC tool details, models and linked child threads, then stops its captured child process. It skips when that executable is unavailable. OMP tests require the supported installed package and Bun.

See [compatibility and native dependency boundaries](docs/compatibility.md).
