# t3-import

This fork of [CarlosGtrz/t3-import](https://github.com/CarlosGtrz/t3-import) uses the npm package name `@ilyagulya/t3-import`. The CLI commands are `t3-import` and `t3-import-omp`.

Import rich Codex, Oh My Pi and Claude Code history into current T3 Code using the tools that own the formats:

- Codex's `app-server` reads sessions, turns and items through T3's typed client.
- Oh My Pi's installed package reads its own entries, branches, compactions and image blobs.
- Claude Agent SDK reads selected session histories and native child-agent transcripts.
- T3's pinned `EventSink` and repositories write events, projections and native resume bindings.

There is no independent rollout parser or copy of T3's projection SQL. This version replaces the old importer; it supports **T3 migrations 96–98**, not the earlier 40–53 schemas. The CLI provides `list`, `show`, `projects`, `doctor`, `import` and `import-all`. It does not include the old TUI, parsers, `sync` or `replace` commands.

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

## Publishing

To register a new package, an authenticated maintainer can [stage a release](https://docs.npmjs.com/staged-publishing/). npm creates the `0.0.0-stage` placeholder. Once the package exists, add a [Trusted Publisher](https://docs.npmjs.com/trusted-publishers/) in its npm settings. Select GitHub Actions, owner `IlyaGulya`, repository `t3-import`, workflow `publish.yml`, and permission to run `npm publish`. Leave the environment field empty.

Run **Publish to npm** from `main` in GitHub Actions. The default run verifies and packs the build. Select **Publish the verified package to npm** for an unused version that should become `latest`. After adding a trusted publisher, complete a successful OIDC publish within two days to validate the connection.

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

Repeat `--thread` to select several sessions, or use `--all` with `--workspace`. `--since ISO_TIMESTAMP` filters by updated time. `--source-home` selects another Codex home; `--binary` selects the Codex executable. The reader pages through full native history and never starts/resumes a model turn.

Root sessions go into the normal T3 project list and stay visible when T3's automatic settlement runs. Use `--settled` to put them on the Settled shelf instead. A confirmed source archive always goes to T3 Archived, using the last source update time when the archive time is unavailable. `--archived` selects confirmed Codex archives or OMP cold archives. An explicit session ID can also find a source archive without that flag. Codex can confirm an unlisted thread from the rollout path returned by its native history API. Claude Code's SDK cannot establish archive status, so its sessions follow the normal import placement. These choices apply when creating imported threads; existing threads keep their state.

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

Nested, gzip-compressed and advisor histories follow OMP's native export layout and are decoded one transcript at a time by the installed OMP package. They become linked historical child threads. Malformed or changing families fail closed, and native aborted-session markers preserve interrupted tails. Cold archives created by OMP GC in `archive/sessions` are imported as history only.

OMP history is streamed in individual records and staged in private temporary storage. The whole family has no transport byte limit. Each helper record is limited to 256 MiB. T3 writes use batches inside one transaction for the family. Dry-run stages and validates the history without writing to the target.

Turn timing ends at the native terminal response. Later idle model changes and compaction records retain their original timestamps as session activity outside that response. Displayed durations are elapsed native response times, not a measurement of billable compute or active CPU time.

A new ordinary request before any assistant/tool activity supersedes the unanswered request as an interrupted historical run (`superseded_unanswered_request`). Native `steering: true` remains a steer even before work starts; later steers after actual work remain in the same run. No user-abort event is invented for a superseded request.

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

The pinned `@anthropic-ai/claude-agent-sdk@0.3.321` supplies `listSessions`, `getSessionInfo`, `getSessionMessages`, `importSessionToStore`, `listSubagents` and `getSubagentMessages`. A Node helper gives the SDK its own `CLAUDE_CONFIG_DIR`; it never starts a query or a model process.

```sh
node dist/cli.js list --source claude --workspace /path/to/project
node dist/cli.js show --source claude --thread SESSION_ID
node dist/cli.js import --source claude --workspace /path/to/project --thread SESSION_ID --no-resume --dry-run
```

`--source-home` selects the Claude config directory, normally `~/.claude`. Native child and grandchild histories become linked historical T3 threads. Claude's subagent history API does not supply an independent resumable session, so those children remain history-only even when root continuation is enabled.

When a native child has no matching launch item in the selected parent history, its thread relationship is retained without assigning it to a guessed parent turn. Its historical activity stays outside unrelated response durations.

Saved pre-compaction epochs are read through the SDK using native compaction anchors. The SDK resolves each epoch's branch; missing saved heads produce `native_history_gap` instead of invented records. Exact native task IDs link older child launches to their original tool calls. Inherited copies of parent context are preserved as metadata rather than repeated as new child work; native history forks use T3 fork lineage.

Native interruption markers become T3 interruption items. A partial reply preceding an interruption remains an assistant reply with interrupted status. Local slash-command envelopes and command stdout remain metadata, preventing empty work folds and spurious user requests. Idle acknowledgements do not extend a completed response.

Old Claude archives may end in an unanswered user request or unfinished tool call. The default importer rejects these indeterminate tails. To keep them deliberately as interrupted historical snapshots, use `--snapshot --no-resume`, preferably against a copied, stable Claude config directory:

```sh
node dist/cli.js import --source claude --source-home /path/to/copied-claude --workspace /path/to/project --thread SESSION_ID --snapshot --no-resume --dry-run
```

Snapshot mode preserves native IDs, contents and unfinished tool calls and creates no continuation binding. `import --snapshot` supports Claude and OMP and requires `--no-resume`. Source changes detected during reading still reject the import. Claude's SDK has no live-process ownership probe. OMP snapshots still require a confirmed absence of a live lease.

The SDK selects the conversation branch. Its official `importSessionToStore` API supplements selected record IDs with system payloads and structured tool results, one native history at a time. `turn_duration` records remain metadata; compaction boundaries become native T3 cards and merge with their summaries. Idle compaction and notices do not extend the preceding response duration. Unknown opaque records are retained as metadata with a warning; meaningful native notification text remains visible.

Edit/Write/MultiEdit/NotebookEdit use T3 file-change cards, TodoWrite uses todo lists, and WebSearch/WebFetch use web-search cards. Read/search labels and MCP presentation use the pinned T3 helpers. Structured file patches and search results are preserved when supplied by the SDK; the importer does not reconstruct missing file contents from the current workspace. Complete tool input/results and selected system metadata are stored transactionally in the importer-owned `t3_native_import_metadata` table, separate from T3's typed projections. Inspect them using the destination T3 thread ID:

```sh
node dist/cli.js metadata --t3-home /path/to/isolated-t3 --thread T3_THREAD_ID --json
```

Both native store APIs are pinned, including the alpha store API. Child histories use the SDK's full history reader over a scoped native store, anchored to the child API's selected head. This restores system events and earlier messages separated by them, while the SDK continues to resolve branches and compaction. The native metadata API supplies each child's actual directory. There is no live-process ownership probe. Legacy text replies without a stop reason are reported: a stable historical reply with no unfinished tool call is treated as settled; an unfinished tool tail is blocked.

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

Remote images are retained as references. Original images that exceed T3's inline limit are kept as file attachments when within the file limit, or as local assets with a reference in the history. Missing or unsupported blobs and tool image presentation limits produce diagnostics.

Historical file links use their original directories. A deleted file or moved project can therefore fail to open even when the history was imported correctly. The importer does not silently redirect these paths. Optional `--restore-workspace --no-resume` materializes captured Claude text files inside the isolated T3 home's `userdata/recorded-workspaces`, with provenance and a `completeProject: false` manifest in the separate `userdata/recorded-workspace-manifests` directory. Only complete recorded writes/reads and safe edits of a known snapshot are eligible; this is a partial historical workspace, not a restored checkout. The original directory is never created or modified. This option is disabled by default.

`--json` prints one JSON result on stdout. `show --full` includes the normalized conversation content, so use it only when that output is wanted. The built artifact includes the pinned T3 reference and its MIT notice.

## Bulk offline import

`import-all` discovers all workspaces exposed by the local Codex, Claude Code and OMP history APIs, including Codex and OMP archives. It imports history without continuation bindings and keeps each family of linked threads in one transaction. Use `--source codex`, `--source claude` or `--source omp` to limit the run.

```sh
node dist/cli.js import-all --dry-run --snapshot
# Quit T3 Code and stop any separate server before applying.
node dist/cli.js import-all --yes --snapshot
```

`--snapshot` preserves unfinished Claude tails and OMP tails without a live lease as interrupted history. `--dry-run` can run alongside T3. It reads and validates the selected history without writing. `--yes` checks that T3 is stopped, acquires its ownership lock and checks the database schema and integrity before opening any source reader. It holds the lock until the run ends. The first batch that writes creates one verified SQLite backup for the run. Dry runs and runs with nothing new to write create no backup.

Source errors and rejected families are listed under `failures` and produce a nonzero exit status. Independent families can still import. Unexpected target errors stop the run and report the backup path if one was created. After resolving the reported problem, rerun the same command. A committed, unchanged family reports `already-imported`. Conflicts leave existing history intact. The SQLite backup covers the database. For a full rollback that also restores settings and attachments, make a separate copy of `userdata` with T3 stopped before applying.

## Automatic import audit

After starting the isolated target, run `t3-import audit --t3-home HOME --server http://127.0.0.1:PORT --thread DESTINATION_T3_THREAD_ID --json`. A read-only T3 access token is read from `T3_IMPORT_AUDIT_TOKEN` (or the variable selected by `--token-env`). The report compares source accounting and saved hashes against real server records, hydrated tool bodies, models, child links, project/directory identity, opaque metadata and attachment bytes. Missing/changed content fails even if counts match. `--structure-only` reports partial verification and exits nonzero. See [audit setup, exact checks and limits](docs/import-audit.md).

## Validation

```sh
npm run fmt
npm run verify:changed
npm run verify
npm pack
```

See [quality checks](docs/quality.md) for standalone formatting/lint, architecture enforcement and deterministic regression rules, and the [browser review checklist](docs/browser-review.md) for all adapters. CI and release validation use `npm run verify`; code changes conservatively run the complete suite.

Type checking checks this importer's files against actual pinned T3 source types; it does not re-check the T3 monorepo. Tests bundle native T3 modules and exercise isolated databases at every supported migration, dry-run immutability, rich history, model switches, linked children, repeat imports, conflicts, ownership locks and transaction rollback. Reader tests use the native source libraries and literal source fixtures. Codex protocol tests also use a fake app-server with T3's real client.

The real-server integration test uses an installed T3 executable (`~/.t3/bin/t3`, or `T3_TEST_SERVER_BINARY`) with a fresh home, disabled providers and its own loopback port. It checks HTTP history pagination, native RPC tool details, models and linked child threads, then stops its captured child process. It skips when that executable is unavailable. OMP tests require the supported installed package and Bun.

See [compatibility and native dependency boundaries](docs/compatibility.md).
