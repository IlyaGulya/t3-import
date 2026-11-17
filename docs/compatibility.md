# Compatibility

The importer builds against T3 commit `ea6d3fc30fb066635f31326f49b85cdee8fbf8d7`. The supported database migration heads are 96, 97 and 98. T3 owns its migration history: the normal writer inspects an existing database and never upgrades it. A missing, damaged or unsupported target is rejected.

The bundled source uses T3's current application event format and `EventSink`, which commits events and projections together. Writing legacy events then asking T3 to rebuild on startup is not supported. Older V1 schemas and the old importer's compatibility fixtures have been removed.

T3 code is bundled from the pinned source checkout through its workspace exports. Runtime Effect packages match that checkout. Private T3 modules are not a stable published SDK; updating the pin requires the native writer tests at all supported migrations and a review of contracts, source APIs and resume bindings.

The Codex reader uses `effect-codex-app-server` from that checkout. Native pagination is preferred. Only a native method-not-found response permits falling back to the native legacy `thread/read` API; parse, authentication and transport failures do not enable a separate file parser.

OMP runs its own source loaders in Bun. The package's read-only entry loader, tree index, format migration, transcript builder and blob resolver remain responsible for the source format. The writable SessionManager opening path is deliberately not used. OMP package versions are checked by the helper; a different version needs native fixture validation before its support range is expanded.

Claude uses the pinned official Agent SDK history APIs, including native subagent discovery and loading. The SDK's selected-chain behavior owns branch resolution. No raw transcript parser is substituted when the SDK omits system payloads. Its native timestamps, available compaction summaries and per-message model identifiers are mapped into T3; unsupported metadata is reported. Historical child snapshots without a native independent resume target are explicitly history-only.

T3 provider-turn records carry executed model provenance. Model switches inside one native user turn therefore create several terminal provider-turn sections within the same imported run and attempt. Linked subagent histories use T3's native child-thread construction and lineage contracts.

Missing child-launch items do not imply ownership by the first parent run. Such children use a terminal thread-scope lineage anchor and nullable run references; their native timestamps remain intact without inflating an unrelated turn's duration.

An import stores display history and references to the source runtime. The original native store is still required for resume. T3 Git checkpoints, erased provider data, encrypted/private reasoning and live child-agent execution cannot be reconstructed from a display transcript.

The test suite starts no model turns. Database tests use throwaway homes and native T3 modules. A real source smoke test must use an explicit copied native home when repeatability or source isolation is required; modern Codex history can depend on its native history database as well as rollout files.
