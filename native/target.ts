import { auditFingerprint } from "./fidelity.js";
import { HistoryList } from "./history-list.js";
import { HistorySpool } from "./history-spool.js";
import {
  projectTurnItemForWire,
  projectTurnItemForDetail,
} from "@t3-native/server/orchestration-v2/WireProjection.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  OrchestrationV2ProviderThread,
  ApplicationProjectEvent,
  ProviderInstanceConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  CodexSettings,
  ClaudeSettings,
  ProjectId,
  ThreadId,
  CommandId,
  resolveProviderInstanceEnabled,
  type OrchestrationV2DomainEvent as DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import { PiSettings } from "@t3tools/provider-pi/settings";
import * as EventSink from "@t3-native/server/orchestration-v2/EventSink.ts";
import * as EventStore from "@t3-native/server/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "@t3-native/server/orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "@t3-native/server/orchestration-v2/ProjectStore.ts";
import * as ProviderRuntime from "@t3-native/server/persistence/ProviderSessionRuntime.ts";
import type { UnsequencedProjectEvent } from "@t3-native/server/persistence/OrchestrationEventStore.ts";
import { runMigrations } from "@t3-native/server/persistence/Migrations.ts";
import { holdServerOwnershipLock } from "@t3-native/server/serverOwnership.ts";
import { resolveCodexHomeLayout } from "@t3-native/server/provider/Drivers/CodexHomeLayout.ts";
import { resolveManagedCodexHomeLayout } from "@t3-native/server/provider/CodexManagedHome.ts";
import { resolveClaudeHomePath } from "@t3-native/server/provider/Drivers/ClaudeHome.ts";
import { inferImageExtension, parseBase64DataUrl } from "@t3-native/server/imageMime.ts";
import type {
  NativeConversationView,
  NativeHistoryItem,
  NativeHistoryCollection,
  NativeTerminalStatus,
  NativeImportResult,
  NativeWriteOptions,
  NativeWriteResult,
  NativeThreadPlacement,
  NativeAuditManifest,
  NativeAuditEntry,
  JsonValue,
} from "../src/native/types.js";

const SUPPORTED = __T3_NATIVE_REFERENCE__.supportedMigrations;
const PREFIX = "t3-import-native:v1";
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const decodeStagedEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const uuid = (value: string) => {
  const bytes = hash(value).slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = ((parseInt(bytes[16]!, 16) & 3) | 8).toString(16);
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const workspaceKey = (value: string) =>
  normalizeProjectPathForComparison(existsSync(value) ? realpathSync(value) : resolve(value));
const at = (value: string) => {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid source timestamp: ${value}`);
  return DateTime.makeUnsafe(value);
};

function paths(home: string) {
  const state = join(resolve(home), "userdata");
  return {
    state,
    db: join(state, "statev2.sqlite"),
    runtime: join(state, "server-runtime.json"),
    assets: join(state, "attachments"),
    settings: join(state, "settings.json"),
  };
}

function liveRuntime(path: string): boolean {
  if (!existsSync(path)) return false;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot inspect T3 runtime state: ${path}`);
  }
  if (!value || typeof value !== "object") throw new Error(`Invalid T3 runtime state: ${path}`);
  const pid = (value as { pid?: unknown }).pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface NativeTargetInspection {
  target: string;
  exists: boolean;
  migration: number | null;
  integrity: string | null;
  supported: boolean;
  live: boolean;
  reason?: string;
}

export function inspectNativeTarget(t3Home: string): NativeTargetInspection {
  const p = paths(t3Home);
  const live = liveRuntime(p.runtime);
  if (!existsSync(p.db))
    return {
      target: p.db,
      exists: false,
      migration: null,
      integrity: null,
      supported: false,
      live,
      reason: "T3 V2 database is missing; start this T3 home once before importing.",
    };
  const db = new DatabaseSync(p.db, { readOnly: true });
  try {
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() ?? {})[0]);
    const migration = Number(
      db.prepare("SELECT MAX(migration_id) AS value FROM effect_sql_migrations").get()?.value ?? 0,
    );
    const required = [
      "orchestration_events",
      "orchestration_v2_projection_threads",
      "orchestration_v2_projection_runs",
      "orchestration_v2_projection_turn_items",
      "provider_session_runtime",
    ];
    const missing = required.filter(
      (table) =>
        !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
    );
    const supported = integrity === "ok" && SUPPORTED.includes(migration) && missing.length === 0;
    return {
      target: p.db,
      exists: true,
      migration,
      integrity,
      supported,
      live,
      ...(supported
        ? {}
        : {
            reason: missing.length
              ? `Missing T3 tables: ${missing.join(", ")}`
              : integrity !== "ok"
                ? `Database integrity check failed: ${integrity}`
                : `Unsupported T3 migration ${migration}; supported: ${SUPPORTED.join(", ")}.`,
          }),
    };
  } finally {
    db.close();
  }
}

/** Importer-owned opaque metadata, separate from T3's typed projections. */
export async function withNativeImportMetadata<T>(
  t3Home: string,
  threadId: string,
  use: (value: {
    sourceKey: string;
    threadId: string;
    records: NativeHistoryCollection<JsonValue>;
  }) => T | Promise<T>,
): Promise<T> {
  const inspection = inspectNativeTarget(t3Home);
  if (!inspection.supported) throw new Error(inspection.reason ?? "Unsupported T3 target.");
  const db = new DatabaseSync(paths(t3Home).db, { readOnly: true });
  try {
    const hasTable = (table: string) =>
      Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const imported = hasTable("t3_native_imports")
      ? db.prepare("SELECT source_key FROM t3_native_imports WHERE thread_id=?").get(threadId)
      : undefined;
    if (!imported) throw new Error(`Thread '${threadId}' has no native importer record.`);
    const sourceKey = String(imported.source_key);
    if (hasTable("t3_native_import_metadata_records")) {
      const count = Number(
        db
          .prepare(
            "SELECT COUNT(*) AS total FROM t3_native_import_metadata_records WHERE thread_id=?",
          )
          .get(threadId)?.total,
      );
      if (count) {
        const record = db.prepare(
          "SELECT record_json FROM t3_native_import_metadata_records WHERE thread_id=? AND record_index=?",
        );
        const records = new HistoryList<JsonValue>();
        for (let index = 0; index < count; index++) {
          records.append(() => {
            const row = record.get(threadId, index);
            if (!row) throw new Error(`Missing native metadata record '${index}'.`);
            return JSON.parse(String(row.record_json)) as JsonValue;
          });
        }
        return await use({ sourceKey, threadId, records });
      }
    }
    const row = hasTable("t3_native_import_metadata")
      ? db
          .prepare("SELECT records_json FROM t3_native_import_metadata WHERE thread_id=?")
          .get(threadId)
      : undefined;
    return await use({
      sourceKey,
      threadId,
      records: row ? (JSON.parse(String(row.records_json)) as JsonValue[]) : [],
    });
  } finally {
    db.close();
  }
}

export function readNativeImportAudit(t3Home: string, threadId: string): NativeAuditManifest {
  const inspection = inspectNativeTarget(t3Home);
  if (!inspection.supported) throw new Error(inspection.reason ?? "Unsupported T3 target.");
  const db = new DatabaseSync(paths(t3Home).db, { readOnly: true });
  try {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='t3_native_import_audits'",
        )
        .get()
    )
      throw new Error(
        "This import has no audit manifest; import into a fresh isolated target with the current importer.",
      );
    const row = db
      .prepare("SELECT report_json FROM t3_native_import_audits WHERE thread_id=?")
      .get(threadId);
    if (!row) throw new Error(`Thread '${threadId}' has no audit manifest.`);
    return JSON.parse(String(row.report_json)) as NativeAuditManifest;
  } finally {
    db.close();
  }
}

export function verifyNativeImportAssets(
  t3Home: string,
  manifest: NativeAuditManifest,
): Array<{ code: string; id: string }> {
  const issues: Array<{ code: string; id: string }> = [];
  for (const asset of manifest.assets) {
    if (basename(asset.name) !== asset.name) throw new Error("Invalid audit attachment name.");
    try {
      const p = paths(t3Home);
      const parts = asset.relativePath?.split(/[\\/]/u);
      if (
        parts &&
        (isAbsolute(asset.relativePath!) ||
          !["recorded-workspaces", "recorded-workspace-manifests"].includes(parts[0]!) ||
          parts.includes(".."))
      )
        throw new Error("Invalid recorded workspace asset path.");
      const bytes = readFileSync(
        asset.relativePath ? join(p.state, asset.relativePath) : join(p.assets, asset.name),
      );
      if (bytes.length !== asset.sizeBytes || hash(bytes) !== asset.sha256)
        issues.push({ code: "asset_changed", id: asset.name });
    } catch {
      issues.push({ code: "asset_missing", id: asset.name });
    }
  }
  return issues;
}

function runtimeLayer(dbPath: string, readonly = false) {
  return EventSink.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        EventStore.layer,
        ProjectionStore.layer,
        ProjectStore.layer,
        ProviderRuntime.layer,
        IdAllocator.layer,
      ),
    ),
    Layer.provideMerge(NodeSqlite.layer({ filename: dbPath, readonly })),
  );
}

export async function listNativeProjects(t3Home: string) {
  const inspection = inspectNativeTarget(t3Home);
  if (!inspection.supported) throw new Error(inspection.reason ?? "Unsupported T3 target.");
  return Effect.runPromise(
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      return yield* projects.list();
    }).pipe(Effect.provide(runtimeLayer(paths(t3Home).db, true)), Effect.scoped),
  );
}

/** Explicit fixture helper; ordinary import never runs T3 migrations. */
export async function initializeNativeTarget(t3Home: string, migration = 98): Promise<void> {
  if (!SUPPORTED.includes(migration)) throw new Error(`Unsupported fixture migration ${migration}`);
  const p = paths(t3Home);
  if (existsSync(p.db)) throw new Error("Refusing to initialize an existing T3 database.");
  mkdirSync(p.state, { recursive: true, mode: 0o700 });
  await Effect.runPromise(
    runMigrations({ toMigrationInclusive: migration }).pipe(
      Effect.provide(NodeSqlite.layer({ filename: p.db })),
    ),
  );
}

interface Asset {
  finalPath: string;
  read: () => Buffer;
  sha256: string;
  sizeBytes: number;
  auditRelativePath?: string;
}
type AssetInput = Pick<Asset, "finalPath" | "auditRelativePath"> & { bytes: Buffer };
type ThreadCreated = Extract<DomainEvent, { type: "thread.created" }>;
type ItemUpdated = Extract<DomainEvent, { type: "turn-item.updated" }>;
type RunCreated = Extract<DomainEvent, { type: "run.created" }>;
type Launch = Pick<ItemUpdated["payload"], "id" | "nodeId" | "providerTurnId" | "ordinal"> & {
  runId: ItemUpdated["runId"];
};
type PlannedEvent = { read: () => DomainEvent; sizeBytes: number };
type InsertedEvents = { ordinal: number; events: PlannedEvent[]; links: PlannedEvent[] };

function stageValue<T>(spool: HistorySpool | undefined, value: T): () => T {
  return spool?.json(value) ?? (() => value);
}

function stageEvent(spool: HistorySpool | undefined, event: DomainEvent): PlannedEvent {
  if (!spool) return { read: () => event, sizeBytes: 0 };
  const bytes = Buffer.from(JSON.stringify(event));
  return storedEvent(spool.bytes(bytes), bytes.length);
}

function storedEvent(read: () => Buffer, sizeBytes: number): PlannedEvent {
  return { read: () => decodeStagedEvent(JSON.parse(read().toString("utf8"))), sizeBytes };
}

interface Plan {
  conversation: NativeConversationView;
  sourceKey: string;
  fingerprint: string;
  historyFingerprint: () => string;
  result: NativeWriteResult;
  projectEvent?: UnsequencedProjectEvent;
  providerThread: typeof OrchestrationV2ProviderThread.Type;
  creation: ThreadCreated;
  events: PlannedEvent[];
  recordEvent: (event: DomainEvent) => PlannedEvent;
  launches: Map<string, Launch>;
  runRoots: Map<RunCreated["payload"]["id"], RunCreated["payload"]["rootNodeId"]>;
  createdChildScope: boolean;
  lastStatus: NativeTerminalStatus;
  emptyTranscript: boolean;
  lastActivityAt: number;
  prompt: () => string;
  answer: () => string | null;
  assets: Asset[];
  metadata: HistoryList<JsonValue>;
  projectRoot: string;
  escrowedFields: number;
  childThreadIds?: string[];
  childInsertions: Map<string, InsertedEvents>;
  detachedLinks: PlannedEvent[];
  runtime?: ProviderRuntime.ProviderSessionRuntime;
}

function providerSelection(conversation: NativeConversationView, options: NativeWriteOptions) {
  const driver = ProviderDriverKind.make(conversation.driver);
  const instance = options.providerInstance ?? conversation.driver;
  const p = paths(options.t3Home);
  let settings: Record<string, unknown> = {};
  if (existsSync(p.settings)) {
    const parsed: unknown = JSON.parse(readFileSync(p.settings, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("T3 settings must be an object.");
    settings = parsed as Record<string, unknown>;
  }
  const instances = settings.providerInstances;
  const configured =
    instances && typeof instances === "object" && !Array.isArray(instances)
      ? (instances as Record<string, unknown>)[instance]
      : undefined;
  if (configured === undefined && instance !== conversation.driver)
    throw new Error(`T3 provider instance '${instance}' is not configured.`);
  if (
    configured !== undefined &&
    (!configured || typeof configured !== "object" || Array.isArray(configured))
  )
    throw new Error(`Invalid T3 provider instance '${instance}'.`);
  const config =
    configured === undefined
      ? undefined
      : Schema.decodeUnknownSync(ProviderInstanceConfig)(configured);
  if (config && config.driver !== conversation.driver)
    throw new Error(
      `Provider instance '${instance}' uses '${config.driver}', expected '${conversation.driver}'.`,
    );
  if (options.resume && !resolveProviderInstanceEnabled(config ?? { driver }))
    throw new Error(`Provider instance '${instance}' is disabled; enable it or use --no-resume.`);
  const environment = Effect.runSync(
    mergeProviderInstanceEnvironment(config?.environment, process.env),
  );
  const environmentValue = (name: string): string | undefined => {
    const variable = config?.environment?.findLast((variable) =>
      process.platform === "win32"
        ? variable.name.toUpperCase() === name.toUpperCase()
        : variable.name === name,
    );
    const value = variable?.value;
    if (value !== undefined && typeof value !== "string")
      throw new Error(
        `Cannot verify '${name}' from an unresolved secret reference; use --no-resume or a verifiable provider configuration.`,
      );
    return environment[name];
  };
  if (options.resume && conversation.source === "codex" && conversation.sourceHome) {
    const nativeConfig = Schema.decodeUnknownSync(CodexSettings)(config?.config ?? {});
    const environmentHome =
      nativeConfig.setupMode === "managed" ? undefined : environmentValue("CODEX_HOME");
    const effectiveConfig =
      !nativeConfig.homePath.trim() && environmentHome?.trim()
        ? { ...nativeConfig, homePath: environmentHome }
        : nativeConfig;
    const layout = Effect.runSync(
      (nativeConfig.setupMode === "managed"
        ? resolveManagedCodexHomeLayout(p.state, ProviderInstanceId.make(instance), nativeConfig)
        : resolveCodexHomeLayout(effectiveConfig)
      ).pipe(Effect.provide(NodePath.layer)),
    );
    const sourceHome = expandHomePath(conversation.sourceHome, homedir());
    const sameHome = workspaceKey(sourceHome) === workspaceKey(layout.sharedHomePath);
    const sourceHistory = join(sourceHome, "thread_history_1.sqlite");
    const targetHistory = join(layout.sharedHomePath, "thread_history_1.sqlite");
    const sharedDatabase =
      existsSync(sourceHistory) &&
      existsSync(targetHistory) &&
      realpathSync(sourceHistory) === realpathSync(targetHistory);
    if (!sameHome && !sharedDatabase)
      throw new Error(
        `Codex source home '${sourceHome}' does not match provider '${instance}' history home '${layout.sharedHomePath}'. Configure the matching instance or use --no-resume.`,
      );
  }
  if (options.resume && conversation.source === "claude" && conversation.sourceHome) {
    const nativeConfig = Schema.decodeUnknownSync(ClaudeSettings)(config?.config ?? {});
    const environmentHome = environmentValue("CLAUDE_CONFIG_DIR");
    const targetHome = Effect.runSync(
      resolveClaudeHomePath(
        nativeConfig,
        environmentHome === undefined ? {} : { CLAUDE_CONFIG_DIR: environmentHome },
      ).pipe(Effect.provide(NodePath.layer)),
    );
    if (
      workspaceKey(expandHomePath(conversation.sourceHome, homedir())) !== workspaceKey(targetHome)
    )
      throw new Error(
        `Claude source home '${conversation.sourceHome}' does not match provider '${instance}' history home '${targetHome}'. Configure the matching instance or use --no-resume.`,
      );
  }
  if (options.resume && conversation.source === "omp") {
    if (!config)
      throw new Error(
        "OMP resume requires a configured Pi instance that launches omp; use --provider-instance or --no-resume.",
      );
    const piConfig = Schema.decodeUnknownSync(PiSettings)(config.config ?? {});
    if (
      !/^(?:omp|t3-import-omp)(?:\.(?:exe|cmd|bat|js|mjs))?$/i.test(
        basename(expandHomePath(piConfig.binaryPath, homedir())),
      )
    ) {
      throw new Error(
        `Provider '${instance}' does not launch an identifiable omp executable; refusing to bind OMP history to ordinary Pi.`,
      );
    }
    const profileArgument = tokenizeCliArgs(piConfig.launchArgs).some(
      (argument) => argument === "--profile" || argument.startsWith("--profile="),
    );
    if (environmentValue("OMP_PROFILE") || environmentValue("PI_PROFILE") || profileArgument) {
      throw new Error(
        `OMP profile overrides cannot yet be verified for provider '${instance}'; use --no-resume to import its history without a continuation binding.`,
      );
    }
    if (conversation.sourceHome) {
      const agentDirectory = environmentValue("PI_CODING_AGENT_DIR");
      if (environmentValue("PI_CONFIG_DIR") || (agentDirectory && !isAbsolute(agentDirectory))) {
        throw new Error(
          `OMP directory overrides cannot yet be verified for provider '${instance}'; use an absolute PI_CODING_AGENT_DIR without PI_CONFIG_DIR, or --no-resume.`,
        );
      }
      const targetHome = agentDirectory || join(homedir(), ".omp", "agent");
      if (
        workspaceKey(expandHomePath(conversation.sourceHome, homedir())) !==
        workspaceKey(targetHome)
      )
        throw new Error(
          `OMP source home does not match provider '${instance}' agent directory. Configure PI_CODING_AGENT_DIR or use --no-resume.`,
        );
    }
    const executable = expandHomePath(piConfig.binaryPath, homedir());
    const bundledBridge = fileURLToPath(new URL("./omp.js", import.meta.url));
    const isBridge =
      /^t3-import-omp(?:\.(?:exe|cmd|bat|js|mjs))?$/i.test(basename(executable)) ||
      (existsSync(executable) &&
        existsSync(bundledBridge) &&
        realpathSync(executable) === realpathSync(bundledBridge));
    if (!isBridge)
      throw new Error(
        `OMP 18.22.0 continuation requires the t3-import-omp RPC bridge as provider '${instance}' binary; native omp uses a settlement event incompatible with the pinned T3 Pi driver. Use --no-resume for history-only import.`,
      );
  }
  return {
    instanceId: ProviderInstanceId.make(instance),
    model: conversation.model?.trim() || DEFAULT_MODEL_BY_PROVIDER[driver] || "default",
  };
}

function imageAttachments(
  item: NativeHistoryItem,
  threadId: string,
  p: ReturnType<typeof paths>,
  addAsset: (asset: AssetInput) => void,
  warnings: string[],
) {
  const references: string[] = [];
  const attachments = (item.images ?? []).flatMap((image) => {
    if (image.url) {
      warnings.push(
        `Image '${image.name}' remains a remote reference (${image.url}); it was not downloaded.`,
      );
      references.push(`[Remote image: ${image.url}]`);
      return [];
    }
    const extension = inferImageExtension({ mimeType: image.mimeType, fileName: image.name });
    if (extension === ".bin") throw new Error(`Unsupported image MIME type: ${image.mimeType}`);
    let bytes: Buffer;
    if (image.base64 !== undefined) {
      const parsed = parseBase64DataUrl(`data:${image.mimeType};base64,${image.base64}`);
      if (!parsed) throw new Error(`Invalid image base64: ${image.name}`);
      bytes = Buffer.from(parsed.base64, "base64");
    } else if (image.path !== undefined) {
      try {
        if (!statSync(image.path).isFile()) throw new Error("not a regular file");
        bytes = readFileSync(image.path);
      } catch (error) {
        warnings.push(
          `Historical image '${image.path}' is unavailable (${error instanceof Error ? error.message : String(error)}); its reference was retained.`,
        );
        references.push(`[Unavailable image: ${image.path}]`);
        return [];
      }
    } else {
      throw new Error(`Image '${image.name}' has no local content.`);
    }
    const id = `native-${hash(threadId).slice(0, 24)}-${uuid(`${item.id}:${image.id}:${hash(bytes)}`)}`;
    const finalPath = join(p.assets, `${id}${extension}`);
    addAsset({ finalPath, bytes });
    if (bytes.length > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
      warnings.push(
        `Image '${image.name}' exceeds T3's file attachment limit; the original is retained as a local asset.`,
      );
      references.push(`[Original image: ${finalPath}]`);
      return [];
    }
    const type = bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ? "file" : "image";
    if (type === "file")
      warnings.push(
        `Image '${image.name}' exceeds T3's inline image limit and is retained as a file attachment.`,
      );
    return [
      {
        type,
        id,
        name: basename(image.name) || `image${extension}`,
        mimeType: image.mimeType,
        sizeBytes: bytes.length,
      },
    ];
  });
  return { attachments, references };
}

function nativeEvent(
  threadId: string,
  key: string,
  type: string,
  occurredAt: DateTime.Utc,
  payload: unknown,
  extra: Record<string, unknown> = {},
): DomainEvent {
  return decodeEvent({
    id: `${PREFIX}:${hash(threadId).slice(0, 20)}:${key}`,
    threadId,
    type,
    occurredAt,
    payload,
    ...extra,
  });
}

function createPlan(
  conversation: NativeConversationView,
  options: NativeWriteOptions,
  allocator: IdAllocator.IdAllocatorV2["Service"],
  projectId: ProjectId,
  projectRoot: string,
  newProject: boolean,
  launchIds: ReadonlySet<string> | undefined,
  spool?: HistorySpool,
): Plan {
  const provider = providerSelection(conversation, options);
  const driver = ProviderDriverKind.make(conversation.driver);
  const sourceKey = `${conversation.source}:${conversation.id}`;
  const threadId = allocator.derive.threadFromProviderThread({
    driver,
    providerInstanceId: provider.instanceId,
    nativeThreadId: `${PREFIX}:${sourceKey}`,
  });
  const providerThreadId = allocator.derive.providerThread({
    driver,
    providerInstanceId: provider.instanceId,
    nativeThreadId: options.resume
      ? conversation.nativeSessionRef
      : `${PREFIX}:history-only:${sourceKey}`,
  });
  const p = paths(options.t3Home);
  const warnings = [...conversation.warnings];
  const createdAt = at(conversation.createdAt);
  const updatedAt = at(conversation.updatedAt);
  const events: PlannedEvent[] = [];
  const recordEvent = (event: DomainEvent) => stageEvent(spool, event);
  const assets: Asset[] = [];
  const addAsset = ({ bytes, ...asset }: AssetInput) => {
    assets.push({
      ...asset,
      read: options.dryRun
        ? () => {
            throw new Error("Cannot read an asset from a dry-run.");
          }
        : (spool?.bytes(bytes) ?? (() => bytes)),
      sha256: hash(bytes),
      sizeBytes: bytes.length,
    });
  };
  const metadata = new HistoryList<JsonValue>();
  const addMetadata = (record: JsonValue) => {
    if (!options.dryRun) metadata.append(stageValue(spool, record));
  };
  if (!options.dryRun) for (const record of conversation.nativeMetadata ?? []) addMetadata(record);
  if (options.restoreWorkspace && options.resume)
    throw new Error("Recorded workspaces require history-only import.");
  const displayWorkspace = options.restoreWorkspace
    ? join(p.state, "recorded-workspaces", hash(sourceKey).slice(0, 24))
    : conversation.workspace;
  if (options.restoreWorkspace) {
    const captured: JsonValue[] = [];
    for (const file of conversation.fileSnapshots ?? []) {
      const path = relative(resolve(conversation.workspace), resolve(file.path));
      if (!path || isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
        warnings.push(
          `recorded_file_outside_workspace: '${file.path}' remains in native history and was not materialized.`,
        );
        continue;
      }
      const finalPath = join(displayWorkspace, path);
      addAsset({
        finalPath,
        bytes: Buffer.from(file.content),
        auditRelativePath: relative(p.state, finalPath),
      });
      captured.push({ path, nativeItemId: file.nativeItemId, timestamp: file.timestamp });
    }
    const provenance = {
      type: "recorded_workspace",
      sourceWorkspace: conversation.workspace,
      displayWorkspace,
      completeProject: false,
      files: captured,
    };
    addMetadata(provenance);
    const finalPath = join(
      p.state,
      "recorded-workspace-manifests",
      `${hash(sourceKey).slice(0, 24)}.json`,
    );
    addAsset({
      finalPath,
      bytes: Buffer.from(JSON.stringify(provenance, null, 2)),
      auditRelativePath: relative(p.state, finalPath),
    });
    warnings.push(
      `recorded_workspace: ${captured.length} recorded file versions restored; this is a partial historical workspace, not a complete checkout.`,
    );
  } else if (!existsSync(conversation.workspace))
    warnings.push(
      "workspace_unavailable: original directory does not exist; use --restore-workspace for recorded files.",
    );
  let escrowedFields = 0;
  const launches = new Map<string, Launch>();
  const runRoots: Plan["runRoots"] = new Map();
  const push = (
    key: string,
    type: string,
    time: DateTime.Utc,
    payload: unknown,
    extra: Record<string, unknown> = {},
  ) => {
    const event = nativeEvent(threadId, key, type, time, payload, extra);
    if (!options.dryRun) events.push(recordEvent(event));
    if (event.type === "run.created") runRoots.set(event.payload.id, event.payload.rootNodeId);
    if (event.type === "turn-item.updated") {
      const { id, nativeItemRef, nodeId, providerTurnId, ordinal } = event.payload;
      if (
        nativeItemRef?.nativeId &&
        launchIds?.has(nativeItemRef.nativeId) &&
        !launches.has(nativeItemRef.nativeId)
      )
        launches.set(nativeItemRef.nativeId, {
          id,
          nodeId,
          providerTurnId,
          ordinal,
          runId: event.runId,
        });
    }
    return event;
  };
  const archived = !conversation.parent && conversation.archived === true;
  const settled = !archived && (options.settled === true || conversation.historyMetadataOnly);
  if (archived)
    warnings.push(
      "The source confirms archival without a timestamp; T3 uses the last source update time.",
    );
  const appThread = {
    id: threadId,
    projectId,
    title: conversation.title.trim() || "Imported session",
    createdBy: "system",
    creationSource: "server",
    providerInstanceId: provider.instanceId,
    modelSelection: provider,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath:
      workspaceKey(displayWorkspace) === workspaceKey(projectRoot)
        ? null
        : resolve(displayWorkspace),
    activeProviderThreadId: options.resume ? providerThreadId : null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt,
    archivedAt: archived ? updatedAt : null,
    deletedAt: null,
    settledOverride: archived ? null : settled ? "settled" : "active",
    settledAt: settled ? updatedAt : null,
    lastVisitedAt: null,
  };
  const creation = nativeEvent(threadId, "thread", "thread.created", createdAt, appThread, {
    providerInstanceId: provider.instanceId,
  }) as ThreadCreated;
  const providerThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread)({
    id: providerThreadId,
    driver: conversation.driver,
    providerInstanceId: provider.instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: options.resume
      ? { driver: conversation.driver, nativeId: conversation.nativeSessionRef, strength: "strong" }
      : null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: conversation.turns.length ? 1 : null,
    lastRunOrdinal: conversation.turns.length || null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt,
    updatedAt,
  });
  push("provider-thread", "provider-thread.updated", updatedAt, providerThread, {
    driver: conversation.driver,
    providerInstanceId: provider.instanceId,
  });
  let ordinal = 0;
  let providerOrdinal = 0;
  let turnIndex = 0;
  let messages = 0;
  let lastStatus: NativeTerminalStatus = "completed";
  let lastActivityAt = -Infinity;
  let allTurnsCompleted = true;
  let prompt: string | undefined;
  let answer: string | null = null;
  const turnIds = new Set<string>();
  for (const turn of conversation.turns) {
    if (!turn.id.trim() || turnIds.has(turn.id))
      throw new NativeImportPlanError(`Duplicate or empty turn id in '${sourceKey}'.`);
    turnIds.add(turn.id);
    if (!["completed", "interrupted", "failed"].includes(turn.status))
      throw new NativeImportPlanError(`Source '${sourceKey}' has a non-terminal turn.`);
    lastStatus = turn.status;
    if (turn.status !== "completed") {
      allTurnsCompleted = false;
      lastActivityAt = Math.max(lastActivityAt, Date.parse(turn.completedAt));
    }
    const runId = allocator.derive.run({ threadId, ordinal: turnIndex + 1 });
    const attemptId = allocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
    const rootNodeId = allocator.derive.rootNode({ runId });
    const idleMetadata = (item: NativeHistoryItem) =>
      (item.kind === "system_notice" || item.kind === "compaction") &&
      (Date.parse(item.timestamp) > Date.parse(turn.completedAt) ||
        Date.parse(item.timestamp) < Date.parse(turn.startedAt));
    // One local user turn may contain assistant replies from different native models.
    // T3 stores executed models on provider turns, so preserve those model sections
    // within the same local run/attempt; only the first keeps the native turn ref.
    const firstModel = turn.model?.trim();
    const sections: Array<{ model?: string; firstAt?: string; lastAt?: string }> = [
      firstModel ? { model: firstModel } : {},
    ];
    const itemSections = new Map<string, number>();
    let firstUserId: string | undefined;
    for (const item of turn.items) {
      if (!item.id.trim() || itemSections.has(item.id))
        throw new NativeImportPlanError(`Duplicate or empty item id in turn '${turn.id}'.`);
      if (item.kind === "user_message") firstUserId ??= item.id;
      if (idleMetadata(item)) {
        itemSections.set(item.id, -1);
        continue;
      }
      const model = item.model?.trim();
      let current = sections[sections.length - 1]!;
      if (model && current.model && model !== current.model && current.firstAt !== undefined) {
        current = { model };
        sections.push(current);
      } else if (model) current.model = model;
      current.firstAt ??= item.timestamp;
      current.lastAt = item.timestamp;
      itemSections.set(item.id, sections.length - 1);
    }
    const sectionIds = sections.map((_, index) =>
      allocator.derive.providerTurn({
        driver,
        nativeTurnId:
          index === 0
            ? `${sourceKey}:${turn.id}`
            : `${sourceKey}:${turn.id}:model-section:${index}`,
      }),
    );
    const providerTurnId = sectionIds[0]!;
    const startedAt = at(turn.startedAt);
    const completedAt = at(turn.completedAt);
    const nativeItemKey = (id: string) => `${sourceKey}:${turn.id}:${id}`;
    const userMessageId = allocator.derive.messageFromProviderItem({
      driver,
      nativeItemId: nativeItemKey(firstUserId ?? "missing-user-input"),
    });
    if (firstUserId === undefined)
      warnings.push(
        `Turn '${turn.id}' has no visible user input; its run retains an unmaterialized input reference.`,
      );
    const common = { runId, providerInstanceId: provider.instanceId };
    push(
      `run:${turnIndex}`,
      "run.created",
      startedAt,
      {
        id: runId,
        threadId,
        ordinal: turnIndex + 1,
        providerInstanceId: provider.instanceId,
        modelSelection: { ...provider, model: turn.model?.trim() || provider.model },
        providerThreadId,
        userMessageId,
        rootNodeId,
        activeAttemptId: attemptId,
        status: turn.status,
        requestedAt: startedAt,
        startedAt,
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      },
      common,
    );
    push(
      `attempt:${turnIndex}`,
      "run-attempt.updated",
      startedAt,
      {
        id: attemptId,
        nativeThreadId: conversation.nativeSessionRef,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: provider.instanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial",
        status: turn.status,
        startedAt,
        completedAt,
      },
      common,
    );
    const rootNode = {
      id: rootNodeId,
      threadId,
      runId,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: turn.status,
      countsForRun: true,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt,
      completedAt,
    };
    push(`node:${turnIndex}`, "node.updated", startedAt, rootNode, {
      ...common,
      nodeId: rootNodeId,
    });
    sections.forEach((section, index) =>
      push(
        `provider-turn:${turnIndex}:${index}`,
        "provider-turn.updated",
        completedAt,
        {
          id: sectionIds[index],
          providerThreadId,
          nodeId: rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef:
            index === 0
              ? { driver: conversation.driver, nativeId: turn.id, strength: "strong" }
              : null,
          ordinal: ++providerOrdinal,
          status: turn.status,
          startedAt: index === 0 ? startedAt : at(section.firstAt!),
          completedAt: index === sections.length - 1 ? completedAt : at(section.lastAt!),
          ...(section.model ? { model: section.model } : {}),
        },
        { ...common, nodeId: rootNodeId },
      ),
    );
    let itemIndex = 0;
    for (const item of turn.items) {
      const section = itemSections.get(item.id)!;
      const independent = section < 0;
      const providerTurnId = independent ? null : sectionIds[section]!;
      const key = nativeItemKey(item.id);
      const itemId = allocator.derive.turnItemFromProviderItem({ driver, nativeItemId: key });
      const messageId = allocator.derive.messageFromProviderItem({ driver, nativeItemId: key });
      const nodeId = allocator.derive.nodeFromProviderItem({ driver, nativeItemId: key });
      const time = at(item.timestamp);
      const { attachments, references } = imageAttachments(
        item,
        threadId,
        paths(options.t3Home),
        addAsset,
        warnings,
      );
      const nativeItemRef = { driver: conversation.driver, nativeId: item.id, strength: "strong" };
      const base = {
        id: itemId,
        threadId,
        runId: independent ? null : runId,
        nodeId: independent ? null : nodeId,
        providerThreadId,
        providerTurnId,
        nativeItemRef,
        parentItemId: null,
        ordinal: ++ordinal,
        status: item.status,
        title: item.title ?? null,
        startedAt: at(item.startedAt ?? item.timestamp),
        completedAt: at(item.completedAt ?? item.timestamp),
        updatedAt: at(item.completedAt ?? item.timestamp),
      };
      if (DateTime.toEpochMillis(base.completedAt) < DateTime.toEpochMillis(base.startedAt))
        throw new Error(`Native item '${item.id}' ends before it starts.`);
      if (!independent && item.kind !== "compaction")
        lastActivityAt = Math.max(
          lastActivityAt,
          DateTime.toEpochMillis(base.completedAt),
          DateTime.toEpochMillis(completedAt),
        );
      const prefix = `item:${turnIndex}:${itemIndex++}`;
      const content = { ...item.data };
      const reserved = [
        "id",
        "threadId",
        "runId",
        "nodeId",
        "providerThreadId",
        "providerTurnId",
        "nativeItemRef",
        "parentItemId",
        "ordinal",
        "type",
        "status",
        "title",
        "startedAt",
        "completedAt",
        "updatedAt",
        "messageId",
        "planId",
      ];
      if (reserved.some((field) => field in content))
        throw new Error(`Source item '${item.id}' contains a reserved orchestration field.`);
      if (item.kind === "user_message" || item.kind === "assistant_message") {
        if (typeof content.text !== "string")
          throw new Error(`Source message '${item.id}' has no text.`);
        const role = item.kind === "user_message" ? "user" : "assistant";
        if (conversation.parent) {
          if (role === "user") prompt ??= content.text;
          else answer = content.text;
        }
        messages++;
        const creation = {
          createdBy: role === "user" ? "user" : "agent",
          creationSource: "server",
        };
        const text = [content.text, ...references].filter(Boolean).join("\n\n");
        push(
          `${prefix}:message`,
          "message.updated",
          time,
          {
            ...creation,
            id: messageId,
            threadId,
            runId,
            nodeId,
            role,
            text,
            attachments,
            streaming: false,
            createdAt: time,
            updatedAt: time,
            ...(typeof content.phase === "string" ? { phase: content.phase } : {}),
          },
          { ...common, nodeId },
        );
        content.text = text;
        Object.assign(content, {
          ...creation,
          messageId,
          attachments,
          ...(role === "user"
            ? { inputIntent: firstUserId === item.id ? "turn_start" : "steer" }
            : { streaming: false }),
        });
      } else if ((attachments.length || references.length) && item.kind === "dynamic_tool") {
        content.output = {
          nativeOutput: content.output ?? null,
          importedImageReferences: references,
          importedImages: attachments.map((attachment) => ({
            ...attachment,
            path: assets.find((asset) => basename(asset.finalPath).startsWith(`${attachment.id}.`))!
              .finalPath,
          })),
        };
        if (attachments.length)
          warnings.push(
            `Tool images on '${item.id}' are preserved in output.importedImages with local asset paths.`,
          );
      } else if (attachments.length) {
        warnings.push(
          `Images on '${item.id}' are retained as local assets; this T3 tool variant has no attachment field.`,
        );
      }
      if (item.kind === "reasoning" || item.kind === "proposed_plan") content.streaming = false;
      if (item.kind === "compaction") content.driver = conversation.driver;
      if (item.kind === "proposed_plan" || item.kind === "todo_list") {
        const planId = `plan:${hash(key)}`;
        content.planId = planId;
        push(
          `${prefix}:plan`,
          "plan.updated",
          time,
          {
            id: planId,
            threadId,
            runId,
            nodeId,
            status: "completed",
            kind: item.kind,
            ...(item.kind === "proposed_plan"
              ? { markdown: content.markdown }
              : {
                  steps: content.steps,
                  ...(content.explanation === undefined
                    ? {}
                    : { explanation: content.explanation }),
                }),
          },
          { ...common, nodeId },
        );
      }
      const nodeKind =
        item.kind === "assistant_message"
          ? "assistant_message"
          : item.kind === "reasoning"
            ? "reasoning"
            : item.kind === "proposed_plan"
              ? "plan"
              : item.kind === "todo_list"
                ? "todo_list"
                : item.kind === "user_message" ||
                    item.kind === "system_notice" ||
                    item.kind === "run_interrupt_result" ||
                    item.kind === "compaction"
                  ? "system"
                  : "tool_call";
      if (!independent)
        push(
          `${prefix}:node`,
          "node.updated",
          time,
          {
            ...rootNode,
            id: nodeId,
            parentNodeId: rootNodeId,
            kind: nodeKind,
            status: item.status,
            countsForRun: false,
            nativeItemRef,
            startedAt: base.startedAt,
            completedAt: base.completedAt,
          },
          { ...common, nodeId },
        );
      const stored = push(
        `${prefix}:turn-item`,
        "turn-item.updated",
        time,
        { ...content, ...base, type: item.kind },
        independent ? { providerInstanceId: provider.instanceId } : { ...common, nodeId },
      );
      const storedPayload = stored.payload as unknown as Record<string, unknown>;
      const exposedPayload =
        stored.type === "turn-item.updated"
          ? (projectTurnItemForDetail(stored.payload) as unknown as Record<string, unknown>)
          : storedPayload;
      const removed = Object.fromEntries(
        Object.entries(item.data).filter(
          ([field, value]) =>
            auditFingerprint(value) !== auditFingerprint(storedPayload[field]) ||
            auditFingerprint(value) !== auditFingerprint(exposedPayload[field]),
        ),
      );
      if (Object.keys(removed).length) {
        escrowedFields += Object.keys(removed).length;
        addMetadata({
          type: "t3_import_preserved_fields",
          uuid: item.id,
          kind: item.kind,
          fields: removed,
        });
      }
    }
    turnIndex++;
  }
  const readPrompt = stageValue(spool, prompt ?? "");
  const readAnswer = stageValue(spool, answer);
  const emptyTranscript =
    turnIndex > 0 &&
    ordinal === 0 &&
    allTurnsCompleted &&
    conversation.sourceCoverage?.selectedRecords === 0;
  return {
    conversation,
    sourceKey,
    fingerprint: "",
    historyFingerprint: () => {
      const { archived: sourceArchived, ...history } = conversation;
      return auditFingerprint({
        conversation: { ...history, ...(sourceArchived ? { archived: true } : {}), warnings: [] },
        provider,
        resume: options.resume,
        assets: assets.map((asset) => ({ name: basename(asset.finalPath), hash: asset.sha256 })),
      });
    },
    providerThread,
    creation,
    events,
    recordEvent,
    launches,
    runRoots,
    createdChildScope: false,
    lastStatus,
    emptyTranscript,
    lastActivityAt:
      Number.isFinite(lastActivityAt) || (conversation.parent && emptyTranscript)
        ? lastActivityAt
        : DateTime.toEpochMillis(updatedAt),
    prompt: readPrompt,
    answer: readAnswer,
    assets,
    metadata,
    projectRoot,
    escrowedFields,
    childInsertions: new Map(),
    detachedLinks: [],
    result: {
      source: conversation.source,
      sourceId: conversation.id,
      threadId,
      projectId,
      status: options.dryRun ? "dry-run" : "imported",
      turns: conversation.turns.length,
      items: ordinal,
      messages,
      resumable: options.resume,
      placement: initialPlacement(conversation, options),
      ...(conversation.historyMetadataOnly
        ? { historyMetadataOnly: conversation.historyMetadataOnly }
        : {}),
      ...(conversation.retainedChildMetadata
        ? { retainedChildMetadata: conversation.retainedChildMetadata }
        : {}),
      quality: {
        targetSchema: "validated",
        serverVerification: "not-run",
        metadataEscrowedFields: escrowedFields,
        ...(conversation.sourceCoverage ? { sourceCoverage: conversation.sourceCoverage } : {}),
      },
      warnings,
    },
    ...(newProject
      ? {
          projectEvent: (({ sequence: _sequence, ...event }) => event)(
            Schema.decodeUnknownSync(ApplicationProjectEvent)({
              sequence: 0,
              eventId: `${PREFIX}:project:${hash(workspaceKey(projectRoot))}`,
              type: "project.created",
              aggregateKind: "project",
              aggregateId: projectId,
              occurredAt: conversation.createdAt,
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: {
                projectId,
                title: basename(projectRoot) || projectRoot,
                workspaceRoot: resolve(projectRoot),
                defaultModelSelection: null,
                scripts: [],
                createdAt: conversation.createdAt,
                updatedAt: conversation.updatedAt,
              },
            }),
          ),
        }
      : {}),
    ...(options.resume
      ? {
          runtime: Schema.decodeUnknownSync(ProviderRuntime.ProviderSessionRuntime)({
            threadId,
            providerName: conversation.driver,
            providerInstanceId: provider.instanceId,
            adapterKey: conversation.driver,
            runtimeMode: "full-access",
            status: "stopped",
            lastSeenAt: conversation.updatedAt,
            resumeCursor: { threadId: conversation.nativeSessionRef },
            runtimePayload: {
              cwd: resolve(conversation.workspace),
              model: provider.model,
              modelSelection: provider,
            },
          }),
        }
      : {}),
  };
}

/** Preserve the native parent's relationship without inventing another user turn. */
function linkChildPlan(parent: Plan, child: Plan, allocator: IdAllocator.IdAllocatorV2["Service"]) {
  const parentThreadEvent = parent.creation;
  const childThreadEvent = child.creation;
  const parentItem = child.conversation.parent?.nativeItemId
    ? parent.launches.get(child.conversation.parent.nativeItemId)
    : undefined;
  const runId = parentItem?.runId;
  const runRoot = runId === undefined ? undefined : parent.runRoots.get(runId);
  (parent.childThreadIds ??= []).push(child.result.threadId);
  if (child.conversation.parent?.relationship === "fork") {
    const forkNodeId = parentItem?.nodeId;
    child.creation = nativeEvent(
      child.result.threadId,
      "thread",
      "thread.created",
      childThreadEvent.payload.createdAt,
      {
        ...childThreadEvent.payload,
        createdBy: "system",
        creationSource: "server",
        lineage: {
          parentThreadId: parentThreadEvent.payload.id,
          rootThreadId: parentThreadEvent.payload.lineage.rootThreadId,
          relationshipToParent: "fork",
        },
        forkedFrom: forkNodeId ? { type: "node", nodeId: forkNodeId } : null,
        settledOverride: "settled",
        settledAt: childThreadEvent.payload.updatedAt,
      },
      { providerInstanceId: childThreadEvent.payload.providerInstanceId },
    ) as ThreadCreated;
    return;
  }
  const driver = ProviderDriverKind.make(child.conversation.driver);
  const nodeId = allocator.derive.nodeFromProviderItem({
    driver,
    nativeItemId: `${PREFIX}:child-link:${parent.sourceKey}:${child.sourceKey}`,
  });
  const itemId = allocator.derive.turnItemFromProviderItem({
    driver,
    nativeItemId: `${PREFIX}:child-link:${parent.sourceKey}:${child.sourceKey}`,
  });
  const now = at(child.conversation.updatedAt);
  const startedAt = at(child.conversation.createdAt);
  const parentScopeId =
    runRoot ??
    allocator.derive.nodeFromProviderItem({
      driver: ProviderDriverKind.make(parent.conversation.driver),
      nativeItemId: `${PREFIX}:child-scope:${parent.sourceKey}`,
    });
  if (!runRoot && !parent.createdChildScope) {
    parent.createdChildScope = true;
    const scopeTime = parentThreadEvent.payload.createdAt;
    parent.events.push(
      parent.recordEvent(
        nativeEvent(
          parent.result.threadId,
          "children:scope",
          "node.updated",
          scopeTime,
          {
            id: parentScopeId,
            threadId: parent.result.threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: parentScopeId,
            kind: "system",
            status: "completed",
            countsForRun: false,
            providerThreadId: parent.providerThread.id,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: scopeTime,
            completedAt: scopeTime,
          },
          {
            nodeId: parentScopeId,
            providerInstanceId: parentThreadEvent.payload.providerInstanceId,
          },
        ),
      ),
    );
  }
  if (!runRoot)
    child.result.warnings.push(
      "Native child launch is unavailable in the selected parent history; thread lineage is preserved without inventing ownership by a parent run.",
    );
  const status = child.conversation.historyMetadataOnly ? "idle" : child.lastStatus;
  const lifecycleStartedAt = status === "idle" ? null : startedAt;
  const lifecycleCompletedAt = status === "idle" ? null : now;
  const prompt = child.prompt();
  const result = child.answer();
  const childThread = makeSubagentChildThread({
    parentThread: parentThreadEvent.payload,
    childThreadId: ThreadId.make(child.result.threadId),
    parentNodeId: nodeId,
    activeProviderThreadId: childThreadEvent.payload.activeProviderThreadId,
    providerInstanceId: childThreadEvent.payload.providerInstanceId,
    modelSelection: childThreadEvent.payload.modelSelection,
    title: child.conversation.title,
    now: startedAt,
    // Imported snapshots keep historical app runs and are not live provider-owned children.
    createdBy: "system",
    creationSource: "server",
  });
  child.creation = nativeEvent(
    child.result.threadId,
    "thread",
    "thread.created",
    startedAt,
    {
      ...childThread,
      projectId: childThreadEvent.payload.projectId,
      worktreePath: childThreadEvent.payload.worktreePath,
      branch: childThreadEvent.payload.branch,
      updatedAt: now,
      settledOverride: "settled",
      settledAt: now,
    },
    { providerInstanceId: childThread.providerInstanceId },
  ) as ThreadCreated;
  const common = {
    ...(runRoot ? { runId } : {}),
    nodeId,
    providerInstanceId: childThread.providerInstanceId,
  };
  const key = `child:${hash(child.sourceKey)}`;
  const nativeTaskRef = child.conversation.parent?.nativeItemId
    ? {
        driver: parent.conversation.driver,
        nativeId: child.conversation.parent.nativeItemId,
        strength: "strong",
      }
    : null;
  const node = parent.recordEvent(
    nativeEvent(
      parent.result.threadId,
      `${key}:node`,
      "node.updated",
      now,
      {
        id: nodeId,
        threadId: parent.result.threadId,
        runId: runRoot ? runId : null,
        parentNodeId: parentScopeId,
        rootNodeId: parentScopeId,
        kind: "subagent",
        status,
        countsForRun: false,
        providerThreadId: child.providerThread.id,
        providerTurnId: null,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: lifecycleStartedAt,
        completedAt: lifecycleCompletedAt,
      },
      common,
    ),
  );
  const subagent = {
    id: nodeId,
    threadId: parent.result.threadId,
    runId: runRoot ? runId : null,
    parentNodeId: parentScopeId,
    origin: "provider_native",
    createdBy: "agent",
    driver,
    providerInstanceId: childThread.providerInstanceId,
    providerThreadId: child.providerThread.id,
    childThreadId: child.result.threadId,
    nativeTaskRef,
    prompt,
    title: child.conversation.title,
    model: child.conversation.model ?? null,
    modelSelection: childThread.modelSelection,
    status,
    result,
    startedAt: lifecycleStartedAt,
    completedAt: lifecycleCompletedAt,
    updatedAt: now,
  };
  const link = parent.recordEvent(
    nativeEvent(
      parent.result.threadId,
      `${key}:subagent`,
      "subagent.updated",
      now,
      subagent,
      common,
    ),
  );
  const item = parent.recordEvent(
    nativeEvent(
      parent.result.threadId,
      `${key}:item`,
      "turn-item.updated",
      now,
      {
        id: itemId,
        threadId: parent.result.threadId,
        runId: runRoot ? runId : null,
        nodeId,
        providerThreadId: parent.providerThread.id,
        providerTurnId: runRoot ? (parentItem?.providerTurnId ?? null) : null,
        nativeItemRef: nativeTaskRef,
        parentItemId: parentItem?.id ?? null,
        ordinal: parent.result.items + parent.detachedLinks.length + 1,
        type: "subagent",
        subagentId: nodeId,
        origin: "provider_native",
        driver,
        providerInstanceId: childThread.providerInstanceId,
        childThreadId: child.result.threadId,
        prompt: subagent.prompt,
        result,
        status,
        title: child.conversation.title,
        startedAt: lifecycleStartedAt,
        completedAt: lifecycleCompletedAt,
        updatedAt: now,
      },
      common,
    ),
  );
  if (parentItem) {
    const group = parent.childInsertions.get(parentItem.id) ?? {
      ordinal: parentItem.ordinal,
      events: [],
      links: [],
    };
    group.events.push(node, link, item);
    group.links.push(link);
    parent.childInsertions.set(parentItem.id, group);
  } else {
    parent.events.push(node, link, item);
    parent.detachedLinks.push(link);
  }
}

export class NativeImportPlanError extends Error {}

function flattenConversations(input: NativeConversationView[]): NativeConversationView[] {
  const result: NativeConversationView[] = [];
  const ancestry = new Set<NativeConversationView>();
  const visit = (conversation: NativeConversationView, parent?: NativeConversationView) => {
    if (ancestry.has(conversation)) throw new NativeImportPlanError("Cyclic native child history.");
    if (parent && conversation.parent && conversation.parent.sourceId !== parent.id)
      throw new NativeImportPlanError("Native child declares a different parent.");
    ancestry.add(conversation);
    result.push({
      ...conversation,
      ...(parent && !conversation.parent ? { parent: { sourceId: parent.id } } : {}),
    });
    for (const child of conversation.children ?? []) visit(child, conversation);
    ancestry.delete(conversation);
  };
  for (const conversation of input) visit(conversation);
  return result;
}

function readMarker(dbPath: string, sourceKey: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='t3_native_imports'")
        .get()
    )
      return undefined;
    return db.prepare("SELECT * FROM t3_native_imports WHERE source_key=?").get(sourceKey) as
      | { fingerprint: string; thread_id: string; last_sequence: number }
      | undefined;
  } finally {
    db.close();
  }
}

type PlanningOptions = NativeWriteOptions & { placementCutoff: number };

function initialPlacement(
  conversation: NativeConversationView,
  options: NativeWriteOptions,
): NativeThreadPlacement {
  if (conversation.archived === true) return { state: "archived", reason: "source-archive" };
  if (conversation.parent) return { state: "settled", reason: "historical-child" };
  if (options.settled) return { state: "settled", reason: "requested-settle" };
  if (conversation.historyMetadataOnly) return { state: "settled", reason: "metadata-only" };
  return { state: "active", reason: "recent-family" };
}

function applyPlacement(plan: Plan, familyLastActivityAt: number, options: PlanningOptions) {
  const placement = plan.result.placement;
  const conversation = plan.conversation;
  const inactive = familyLastActivityAt < options.placementCutoff;
  if (!conversation.parent)
    placement.familyLastActivityAt = new Date(familyLastActivityAt).toISOString();
  if (inactive && options.oldFamilyAction === "archive" && placement.state !== "archived") {
    placement.state = "archived";
    placement.reason = "inactive-family";
  } else if (inactive && placement.state === "active") {
    if (options.oldFamilyAction === "keep") placement.reason = "inactive-family-kept";
    else {
      placement.state = "settled";
      placement.reason = "inactive-family";
    }
  } else if (
    options.archiveEmptyChildren !== false &&
    placement.reason === "historical-child" &&
    conversation.parent?.relationship !== "fork" &&
    !plan.childThreadIds?.length &&
    !conversation.retainedChildMetadata?.length &&
    plan.emptyTranscript
  ) {
    placement.state = "archived";
    placement.reason = "empty-subagent";
  }
  const payload = plan.creation.payload;
  plan.creation = {
    ...plan.creation,
    payload: {
      ...payload,
      archivedAt: placement.state === "archived" ? payload.updatedAt : null,
      settledOverride: placement.state === "archived" ? null : placement.state,
      settledAt: placement.state === "settled" ? payload.updatedAt : null,
    },
  };
}

export function countNativePlacement(results: NativeWriteResult[]) {
  const counts = { active: 0, settled: 0, archived: 0 };
  for (const result of results) counts[result.placement.state]++;
  return counts;
}

function planAll(
  conversations: NativeConversationView[],
  options: PlanningOptions,
  spool?: HistorySpool,
) {
  return Effect.gen(function* () {
    if (options.projectRoot !== undefined && options.projectId !== undefined)
      throw new NativeImportPlanError("Choose either --project-root or --project-id.");
    if (options.projectRoot !== undefined && !options.projectRoot.trim())
      throw new NativeImportPlanError("Project root must not be empty.");
    const allocator = yield* IdAllocator.IdAllocatorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const activeProjects = yield* projects.list();
    const selectedProject =
      options.projectId === undefined
        ? undefined
        : activeProjects.find((project) => project.projectId === options.projectId);
    if (options.projectId !== undefined && !selectedProject)
      throw new NativeImportPlanError(
        `T3 project '${options.projectId}' was not found or is deleted. Use the projects command to list destination projects.`,
      );
    const created = new Set<string>();
    const plans: Plan[] = [];
    const launchIds = new Map<string, Set<string>>();
    for (const { source, parent } of conversations) {
      if (!parent?.nativeItemId) continue;
      const key = `${source}:${parent.sourceId}`;
      const ids = launchIds.get(key) ?? new Set<string>();
      ids.add(parent.nativeItemId);
      launchIds.set(key, ids);
    }
    for (const conversation of conversations) {
      const projectRoot =
        selectedProject?.workspaceRoot ?? options.projectRoot ?? conversation.workspace;
      const workspace = workspaceKey(projectRoot);
      const matches = activeProjects.filter(
        (project) => workspaceKey(project.workspaceRoot) === workspace,
      );
      if (!selectedProject && matches.length > 1)
        throw new NativeImportPlanError(
          `Multiple T3 projects share directory '${projectRoot}'; choose --project-id explicitly.`,
        );
      const project = selectedProject ?? matches[0];
      const projectId = project?.projectId ?? ProjectId.make(`native-project:${hash(workspace)}`);
      const effectiveOptions = {
        ...options,
        resume: options.resume && conversation.resumeSupported !== false,
      };
      const plan = createPlan(
        conversation,
        effectiveOptions,
        allocator,
        projectId,
        project?.workspaceRoot ?? projectRoot,
        project === undefined && !created.has(projectId),
        launchIds.get(`${conversation.source}:${conversation.id}`),
        spool,
      );
      if (options.resume && !effectiveOptions.resume)
        plan.result.warnings.push(
          conversation.parent
            ? "This native child history cannot resume independently; imported as history-only."
            : "This native snapshot cannot resume; imported as history-only.",
        );
      created.add(projectId);
      plans.push(plan);
    }
    const linked = new Set<string>();
    const linking = new Set<string>();
    const bySource = new Map(plans.map((plan) => [plan.sourceKey, plan]));
    const link = (plan: Plan): void => {
      if (linked.has(plan.sourceKey)) return;
      if (linking.has(plan.sourceKey))
        throw new NativeImportPlanError(`Cyclic native parent relation for '${plan.sourceKey}'.`);
      linking.add(plan.sourceKey);
      if (plan.conversation.parent) {
        const key = `${plan.conversation.source}:${plan.conversation.parent.sourceId}`;
        const parent = bySource.get(key);
        if (!parent)
          throw new NativeImportPlanError(
            `Native parent '${key}' must be included in this import.`,
          );
        link(parent);
        linkChildPlan(parent, plan, allocator);
      }
      linking.delete(plan.sourceKey);
      linked.add(plan.sourceKey);
    };
    plans.forEach(link);
    const familyActivity = new Map<ThreadId, number>();
    for (const plan of plans) {
      const root = plan.creation.payload.lineage.rootThreadId;
      familyActivity.set(
        root,
        Math.max(familyActivity.get(root) ?? -Infinity, plan.lastActivityAt),
      );
    }
    for (const plan of plans) {
      const marker = readMarker(paths(options.t3Home).db, plan.sourceKey);
      // Lineage and parent link records are part of the replay identity too.
      if (marker || !options.dryRun) {
        const relationships = new HistoryList<DomainEvent>();
        relationships.append(() => plan.creation);
        const insertions = [...plan.childInsertions.values()].sort((a, b) => a.ordinal - b.ordinal);
        for (const { links } of insertions)
          for (const link of links) relationships.append(link.read);
        for (const link of plan.detachedLinks) relationships.append(link.read);
        plan.fingerprint = auditFingerprint({ source: plan.historyFingerprint(), relationships });
      }
      const thread = yield* projections.findThread(ThreadId.make(plan.result.threadId));
      if (marker) {
        if (marker.fingerprint !== plan.fingerprint)
          throw new NativeImportPlanError(
            `Imported source '${plan.sourceKey}' changed. Native sync/replace is not implemented; history was not overwritten.`,
          );
        if (!thread || marker.thread_id !== plan.result.threadId || thread.deletedAt !== null)
          throw new NativeImportPlanError(
            `Imported target '${plan.sourceKey}' was deleted or rebound; refusing to recreate it.`,
          );
        const latest = yield* eventStore.latestSequence({
          threadId: ThreadId.make(plan.result.threadId),
        });
        if (latest !== marker.last_sequence)
          throw new NativeImportPlanError(
            `Imported target '${plan.sourceKey}' contains newer T3 activity; history was not overwritten.`,
          );
        plan.result.status = "already-imported";
        plan.result.placement = {
          state:
            thread.archivedAt !== null
              ? "archived"
              : thread.settledOverride === "settled"
                ? "settled"
                : "active",
          reason: "already-imported",
        };
      } else if (thread) {
        throw new NativeImportPlanError(
          `Target thread '${plan.result.threadId}' already exists without this importer's marker.`,
        );
      } else {
        // Placement is an import-time choice. Keep the historical replay identity stable.
        applyPlacement(
          plan,
          familyActivity.get(plan.creation.payload.lineage.rootThreadId)!,
          options,
        );
      }
    }
    return plans;
  });
}

function validateConversations(conversations: NativeConversationView[]) {
  const seen = new Set<string>();
  if (!conversations.length)
    throw new NativeImportPlanError("Select at least one source conversation.");
  for (const conversation of conversations) {
    const key = `${conversation.source}:${conversation.id}`;
    if (seen.has(key)) throw new NativeImportPlanError(`Duplicate source conversation '${key}'.`);
    seen.add(key);
    if (conversation.active)
      throw new NativeImportPlanError(
        `Source '${key}' has an active or indeterminate turn; settle it before importing.`,
      );
    if (
      !conversation.id.trim() ||
      !conversation.nativeSessionRef.trim() ||
      !conversation.workspace.trim()
    )
      throw new NativeImportPlanError(`Source '${key}' lacks its stable identity or workspace.`);
    if (
      (conversation.source === "codex" && conversation.driver !== "codex") ||
      (conversation.source === "omp" && conversation.driver !== "pi") ||
      (conversation.source === "claude" && conversation.driver !== "claudeAgent")
    )
      throw new NativeImportPlanError(`Source '${key}' has a mismatched native driver.`);
    if (conversation.historyMetadataOnly) {
      if (
        conversation.turns.length ||
        !conversation.nativeMetadata?.length ||
        conversation.resumeSupported !== false
      )
        throw new NativeImportPlanError(`Source '${key}' has inconsistent metadata-only history.`);
    } else if (!conversation.turns.length)
      throw new NativeImportPlanError(`Source '${key}' has no terminal history to import.`);
  }
}

async function verifiedBackup(dbPath: string): Promise<string> {
  const directory = join(dirname(dbPath), "t3-import-backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = join(
    directory,
    `statev2-native-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.sqlite`,
  );
  const staging = `${destination}.partial`;
  const source = new DatabaseSync(dbPath, { readOnly: true });
  // Node 26 can leave SQLite backup promise callbacks pending while a native reader's pipes are idle.
  const wakeBackup = setInterval(() => {}, 250).unref();
  try {
    await backup(source, staging);
    chmodSync(staging, 0o600);
    const check = new DatabaseSync(staging, { readOnly: true });
    try {
      if (Object.values(check.prepare("PRAGMA integrity_check").get() ?? {})[0] !== "ok")
        throw new Error(`Backup integrity check failed: ${destination}`);
    } finally {
      check.close();
    }
    renameSync(staging, destination);
  } finally {
    clearInterval(wakeBackup);
    source.close();
    rmSync(staging, { force: true });
  }
  return destination;
}

function stageAssets(plans: Plan[], directory: string) {
  const created: string[] = [];
  const staging = join(directory, `.native-import-${randomUUID()}`);
  const assets = new Map(
    plans.flatMap((plan) => plan.assets.map((asset) => [asset.finalPath, asset] as const)),
  );
  if (!assets.size) return { created, cleanup: () => {} };
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const asset of assets.values()) {
      if (existsSync(asset.finalPath)) {
        if (hash(readFileSync(asset.finalPath)) !== asset.sha256)
          throw new Error(`Existing attachment differs from imported content: ${asset.finalPath}`);
        continue;
      }
      const staged = join(staging, basename(asset.finalPath));
      writeFileSync(staged, asset.read(), { flag: "wx", mode: 0o600 });
      if (hash(readFileSync(staged)) !== asset.sha256)
        throw new Error("Attachment staging verification failed.");
      mkdirSync(dirname(asset.finalPath), { recursive: true, mode: 0o700 });
      renameSync(staged, asset.finalPath);
      created.push(asset.finalPath);
    }
    return { created, cleanup: () => rmSync(staging, { recursive: true, force: true }) };
  } catch (error) {
    for (const path of created) rmSync(path, { force: true });
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function auditEntry(value: unknown): NativeAuditEntry {
  const row = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return { id: String(row.id), fields: Object.keys(row).sort(), sha256: auditFingerprint(row) };
}
function createAuditManifest(
  plan: Plan,
  canonicalEvents: Iterable<DomainEvent>,
): NativeAuditManifest {
  let threadProjection = ProjectionStore.emptyProjection(plan.creation);
  const names: Record<string, string> = {
    "thread.created": "thread",
    "provider-thread.updated": "providerThreads",
    "message.updated": "messages",
    "run.created": "runs",
    "run.updated": "runs",
    "provider-turn.updated": "providerTurns",
    "turn-item.updated": "turnItems",
    "plan.updated": "plans",
    "subagent.updated": "subagents",
  };
  const collections = new Map<string, Map<string, NativeAuditEntry>>(
    Object.values(names).map((name) => [name, new Map()]),
  );
  const details = new Map<string, NativeAuditEntry>();
  const children = new Set<string>(plan.childThreadIds ?? []);
  const warnings = [...plan.result.warnings];
  for (const event of canonicalEvents) {
    if (event.type === "thread.created") continue;
    if (event.type.startsWith("thread.") || event.type.startsWith("provider-thread."))
      threadProjection = ProjectionStore.applyToProjection(threadProjection, event);
    const name = names[event.type];
    if (!name) continue;
    if (event.type === "turn-item.updated") {
      const wire = projectTurnItemForWire(event.payload);
      const detail = projectTurnItemForDetail(event.payload);
      const wireEntry = auditEntry(wire),
        detailEntry = auditEntry(detail);
      collections.get(name)!.set(wireEntry.id, wireEntry);
      if (wireEntry.sha256 !== detailEntry.sha256) details.set(detailEntry.id, detailEntry);
      for (const field of ["text", "output", "input", "diffStr", "oldStr", "newStr"] as const) {
        const full = (event.payload as unknown as Record<string, unknown>)[field];
        const exposed = (detail as unknown as Record<string, unknown>)[field];
        if (full !== undefined && auditFingerprint(full) !== auditFingerprint(exposed))
          warnings.push(
            `server_detail_bounded: item '${event.payload.nativeItemRef?.nativeId ?? event.payload.id}' field '${field}' is omitted or bounded by T3's public detail API; full body verification through this API is unavailable.`,
          );
      }
    } else {
      let payload: unknown = event.payload;
      if (event.type === "provider-thread.updated") {
        const fields = ["id", "driver", "providerInstanceId", "appThreadId", "nativeThreadRef"];
        payload = Object.fromEntries(
          fields.map((field) => [
            field,
            (event.payload as unknown as Record<string, unknown>)[field],
          ]),
        );
      }
      const entry = auditEntry(payload);
      collections.get(name)!.set(entry.id, entry);
    }
    if (event.type === "subagent.updated" && event.payload.childThreadId)
      children.add(event.payload.childThreadId);
  }
  const threadFields = [
    "id",
    "projectId",
    "title",
    "modelSelection",
    "providerInstanceId",
    "worktreePath",
    "lineage",
    "forkedFrom",
    "activeProviderThreadId",
  ] as const;
  const thread = auditEntry(
    Object.fromEntries(threadFields.map((field) => [field, threadProjection.thread[field]])),
  );
  collections.get("thread")!.set(thread.id, thread);
  if (plan.escrowedFields)
    warnings.push(
      `metadata_only_fields: ${plan.escrowedFields} source fields are preserved outside T3's typed presentation.`,
    );
  if (!plan.conversation.sourceCoverage)
    warnings.push(
      "source_record_coverage_unmeasured: source API to normalized record accounting was not supplied by this reader.",
    );
  return {
    schemaVersion: 1,
    threadId: plan.result.threadId,
    source: plan.conversation.source,
    sourceId: plan.conversation.id,
    children: [...children].sort(),
    warnings: [...new Set(warnings)],
    escrowedFields: plan.escrowedFields,
    project: { id: plan.result.projectId, workspaceRoot: plan.projectRoot },
    ...(plan.conversation.sourceCoverage
      ? { sourceCoverage: plan.conversation.sourceCoverage }
      : {}),
    collections: Object.fromEntries(
      [...collections].map(([key, rows]) => [key, [...rows.values()]]),
    ),
    details: [...details.values()],
    assets: [
      ...new Map(
        plan.assets.map((asset) => [
          asset.auditRelativePath ?? basename(asset.finalPath),
          {
            name: basename(asset.finalPath),
            ...(asset.auditRelativePath ? { relativePath: asset.auditRelativePath } : {}),
            sha256: asset.sha256,
            sizeBytes: asset.sizeBytes,
          },
        ]),
      ).values(),
    ],
    metadataDigest: auditFingerprint(plan.metadata),
    metadataRecords: plan.metadata.length,
  };
}

function resultFor(
  plans: Plan[],
  target: string,
  migration: number,
  dryRun: boolean,
  backup: string | null,
): NativeImportResult {
  const statuses = new Set(plans.map((plan) => plan.result.status));
  return {
    schemaVersion: 1,
    status: dryRun
      ? "dry-run"
      : statuses.size > 1
        ? "mixed"
        : statuses.has("imported")
          ? "imported"
          : "already-imported",
    target,
    migration,
    backup,
    placementCounts: countNativePlacement(plans.map((plan) => plan.result)),
    results: plans.map((plan) => plan.result),
  };
}

export async function withNativeImportRun<T>(
  options: NativeWriteOptions,
  run: (target: {
    importBatch: (conversations: NativeConversationView[]) => Promise<NativeImportResult>;
    readonly backup: string | null;
    readonly path: string;
    readonly migration: number;
  }) => Promise<T>,
): Promise<T> {
  const p = paths(options.t3Home);
  const oldFamilyDays = options.oldFamilyDays ?? 30;
  if (!Number.isSafeInteger(oldFamilyDays) || oldFamilyDays < 1)
    throw new NativeImportPlanError("The old family threshold must be a positive integer.");
  const planningOptions = {
    ...options,
    placementCutoff: Date.now() - oldFamilyDays * 86_400_000,
  };
  if (options.initialize && !existsSync(p.db)) {
    if (options.dryRun) throw new Error("Dry-run never initializes a missing target.");
    await initializeNativeTarget(options.t3Home);
  }
  if (!options.dryRun && liveRuntime(p.runtime))
    throw new Error("T3 is running. Close it before importing with the offline native writer.");
  if (!existsSync(p.db))
    throw new Error("T3 V2 database is missing; start this T3 home once before importing.");

  const execute = async () => {
    const inspection = inspectNativeTarget(options.t3Home);
    if (inspection.live && !options.dryRun)
      throw new Error("T3 is running. Close it before importing with the offline native writer.");
    if (!inspection.supported || inspection.migration === null)
      throw new Error(inspection.reason ?? "Unsupported T3 target.");
    const migration = inspection.migration;
    let savedBackup: string | null = null;
    let pendingBackup: Promise<string> | undefined;
    return run({
      path: p.db,
      migration,
      importBatch: (conversations) =>
        writeNativeBatch(conversations, planningOptions, migration, () => {
          return (pendingBackup ??= verifiedBackup(p.db).then((path) => (savedBackup = path)));
        }),
      get backup() {
        return savedBackup;
      },
    });
  };

  if (options.dryRun) return execute();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* holdServerOwnershipLock(p.runtime);
      return yield* Effect.tryPromise({
        try: execute,
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
    }).pipe(Effect.scoped),
  );
}

export async function importNativeConversations(
  conversations: NativeConversationView[],
  options: NativeWriteOptions,
): Promise<NativeImportResult> {
  return withNativeImportRun(options, (target) => target.importBatch(conversations));
}

async function writeNativeBatch(
  conversations: NativeConversationView[],
  options: PlanningOptions,
  migration: number,
  getBackup: () => Promise<string>,
): Promise<NativeImportResult> {
  conversations = flattenConversations(conversations);
  for (const conversation of conversations)
    if (conversation.sourceCoverage?.missingRecordIds.length)
      throw new NativeImportPlanError(
        `Native selected records were not preserved for '${conversation.source}:${conversation.id}': ${conversation.sourceCoverage.missingRecordIds.join(", ")}`,
      );
  validateConversations(conversations);
  const spool = conversations.some((conversation) => conversation.turns instanceof HistoryList)
    ? new HistorySpool()
    : undefined;
  try {
    return await writePlannedBatch(conversations, options, migration, getBackup, spool);
  } finally {
    spool?.close();
  }
}

function* eventBatches(plan: Plan, staged: boolean): Generator<DomainEvent[]> {
  let events: DomainEvent[] = [plan.creation];
  let sizeBytes = 0;
  for (const record of plan.events) {
    const event = record.read();
    // Keep each linked child immediately after its native launch in commit order.
    const inserted =
      event.type === "turn-item.updated" ? plan.childInsertions.get(event.payload.id) : undefined;
    events.push(event);
    sizeBytes += record.sizeBytes;
    for (const child of inserted?.events ?? []) {
      events.push(child.read());
      sizeBytes += child.sizeBytes;
      if (staged && (sizeBytes >= 16 * 1024 * 1024 || events.length >= 512)) {
        yield events;
        events = [];
        sizeBytes = 0;
      }
    }
    if (staged && (sizeBytes >= 16 * 1024 * 1024 || events.length >= 512)) {
      yield events;
      events = [];
      sizeBytes = 0;
    }
  }
  if (events.length) yield events;
}

async function writePlannedBatch(
  conversations: NativeConversationView[],
  options: PlanningOptions,
  migration: number,
  getBackup: () => Promise<string>,
  spool?: HistorySpool,
): Promise<NativeImportResult> {
  const p = paths(options.t3Home);
  const plans = await Effect.runPromise(
    planAll(conversations, options, spool).pipe(Effect.provide(runtimeLayer(p.db, true))),
  );
  const pending = plans.filter((plan) => plan.result.status !== "already-imported");
  if (options.dryRun || !pending.length)
    return resultFor(plans, p.db, migration, options.dryRun, null);
  const savedBackup = await getBackup();
  return Effect.runPromise(
    Effect.gen(function* () {
      let committed = false;
      yield* Effect.acquireRelease(
        Effect.sync(() => stageAssets(pending, p.assets)),
        (assets) =>
          Effect.sync(() => {
            if (!committed) for (const path of assets.created) rmSync(path, { force: true });
            assets.cleanup();
          }),
      );
      yield* Effect.promise(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            const runtimes = yield* ProviderRuntime.ProviderSessionRuntimeRepository;
            const eventStore = yield* EventStore.EventStoreV2;
            const sql = yield* SqlClient.SqlClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`CREATE TABLE IF NOT EXISTS t3_native_imports (
            source_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE,
            last_sequence INTEGER NOT NULL, imported_at TEXT NOT NULL
          )`;
                yield* sql`CREATE TABLE IF NOT EXISTS t3_native_import_metadata (
            thread_id TEXT PRIMARY KEY, records_json TEXT NOT NULL
          )`;
                if (spool)
                  yield* sql`CREATE TABLE IF NOT EXISTS t3_native_import_metadata_records (
              thread_id TEXT NOT NULL, record_index INTEGER NOT NULL, record_json TEXT NOT NULL,
              PRIMARY KEY (thread_id, record_index)
            )`;
                yield* sql`CREATE TABLE IF NOT EXISTS t3_native_import_audits (thread_id TEXT PRIMARY KEY, report_json TEXT NOT NULL)`;
                for (const plan of pending) {
                  if (plan.projectEvent) {
                    yield* sink.commitProjectCommand({
                      commandId: CommandId.make(
                        `${PREFIX}:project-command:${hash(plan.result.projectId)}`,
                      ),
                      projectId: ProjectId.make(plan.result.projectId),
                      commandType: "project.create",
                      acceptedAt: at(plan.conversation.createdAt),
                      event: plan.projectEvent,
                    });
                  }
                  const canonicalEvents = new HistoryList<DomainEvent>();
                  for (const events of eventBatches(plan, spool !== undefined)) {
                    const sourceItemShapes = new Map(
                      events
                        .filter((event) => event.type === "turn-item.updated")
                        .map((event) => {
                          const { ordinal: _ordinal, ...content } = event.payload;
                          return [String(event.id), auditFingerprint(content)] as const;
                        }),
                    );
                    const stored = yield* sink.write({
                      ...(plan.runtime ? { unlessNativeThreadOwned: plan.providerThread } : {}),
                      events,
                    });
                    if (!stored.length)
                      throw new Error(
                        `Native session '${plan.sourceKey}' already belongs to another T3 thread.`,
                      );
                    // T3 owns run-scoped item positions. Reuse its canonical events,
                    // and fail closed if native normalization changes source content.
                    for (const { event } of stored) {
                      if (event.type === "turn-item.updated") {
                        const expected = sourceItemShapes.get(String(event.id));
                        const { ordinal: _ordinal, ...content } = event.payload;
                        if (expected && expected !== auditFingerprint(content))
                          throw new Error(
                            `Native T3 normalization changed source-owned item fields: ${event.payload.nativeItemRef?.nativeId ?? event.payload.id}`,
                          );
                      }
                      canonicalEvents.append(plan.recordEvent(event).read);
                    }
                  }
                  if (plan.runtime) yield* runtimes.upsert(plan.runtime, { onConflict: "ignore" });
                  const latest = yield* eventStore.latestSequence({
                    threadId: ThreadId.make(plan.result.threadId),
                  });
                  yield* sql`INSERT INTO t3_native_imports (source_key, fingerprint, thread_id, last_sequence, imported_at)
              VALUES (${plan.sourceKey}, ${plan.fingerprint}, ${plan.result.threadId}, ${latest}, ${new Date().toISOString()})`;
                  if (spool) {
                    let index = 0;
                    for (const record of plan.metadata)
                      yield* sql`INSERT INTO t3_native_import_metadata_records (thread_id, record_index, record_json)
                VALUES (${plan.result.threadId}, ${index++}, ${JSON.stringify(record)})`;
                  } else if (plan.metadata.length)
                    yield* sql`INSERT INTO t3_native_import_metadata (thread_id, records_json)
              VALUES (${plan.result.threadId}, ${JSON.stringify(Array.from(plan.metadata))})`;
                  yield* sql`INSERT INTO t3_native_import_audits (thread_id, report_json)
              VALUES (${plan.result.threadId}, ${JSON.stringify(
                createAuditManifest(plan, canonicalEvents),
              )})`;
                }
              }),
            );
          }).pipe(Effect.provide(runtimeLayer(p.db))),
        ),
      );
      committed = true;
      return resultFor(plans, p.db, migration, false, savedBackup);
    }).pipe(Effect.scoped),
  );
}
