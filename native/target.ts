import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
  DEFAULT_MODEL_BY_PROVIDER, OrchestrationV2DomainEvent, OrchestrationV2ProviderThread,
  ApplicationProjectEvent, ProviderInstanceConfig, ProviderDriverKind, ProviderInstanceId, CodexSettings, ClaudeSettings,
  ProjectId, ThreadId, CommandId,
  resolveProviderInstanceEnabled, type OrchestrationV2DomainEvent as DomainEvent,
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
  NativeConversation, NativeHistoryItem, NativeImportResult, NativeWriteOptions, NativeWriteResult,
} from "../src/native/types.js";

const SUPPORTED = __T3_NATIVE_REFERENCE__.supportedMigrations;
const PREFIX = "t3-import-native:v1";
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const uuid = (value: string) => {
  const bytes = hash(value).slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = ((parseInt(bytes[16]!, 16) & 3) | 8).toString(16);
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
  }
  return entry;
});
const workspaceKey = (value: string) => normalizeProjectPathForComparison(
  existsSync(value) ? realpathSync(value) : resolve(value),
);
const at = (value: string) => {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid source timestamp: ${value}`);
  return DateTime.makeUnsafe(value);
};

function paths(home: string) {
  const state = join(resolve(home), "userdata");
  return { state, db: join(state, "statev2.sqlite"), runtime: join(state, "server-runtime.json"), assets: join(state, "attachments"), settings: join(state, "settings.json") };
}

function liveRuntime(path: string): boolean {
  if (!existsSync(path)) return false;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`Cannot inspect T3 runtime state: ${path}`); }
  if (!value || typeof value !== "object") throw new Error(`Invalid T3 runtime state: ${path}`);
  const pid = (value as { pid?: unknown }).pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
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
  if (!existsSync(p.db)) return { target: p.db, exists: false, migration: null, integrity: null, supported: false, live, reason: "T3 V2 database is missing; start this T3 home once before importing." };
  const db = new DatabaseSync(p.db, { readOnly: true });
  try {
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() ?? {})[0]);
    const migration = Number(db.prepare("SELECT MAX(migration_id) AS value FROM effect_sql_migrations").get()?.value ?? 0);
    const required = ["orchestration_events", "orchestration_v2_projection_threads", "orchestration_v2_projection_runs", "orchestration_v2_projection_turn_items", "provider_session_runtime"];
    const missing = required.filter(table => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const supported = integrity === "ok" && SUPPORTED.includes(migration) && missing.length === 0;
    return { target: p.db, exists: true, migration, integrity, supported, live,
      ...(supported ? {} : { reason: missing.length ? `Missing T3 tables: ${missing.join(", ")}` : integrity !== "ok" ? `Database integrity check failed: ${integrity}` : `Unsupported T3 migration ${migration}; supported: ${SUPPORTED.join(", ")}.` }) };
  } finally { db.close(); }
}

function runtimeLayer(dbPath: string, readonly = false) {
  return EventSink.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer, ProviderRuntime.layer, IdAllocator.layer)),
    Layer.provideMerge(NodeSqlite.layer({ filename: dbPath, readonly })),
  );
}

export async function listNativeProjects(t3Home: string) {
  const inspection = inspectNativeTarget(t3Home);
  if (!inspection.supported) throw new Error(inspection.reason ?? "Unsupported T3 target.");
  return Effect.runPromise(Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    return yield* projects.list();
  }).pipe(Effect.provide(runtimeLayer(paths(t3Home).db, true)), Effect.scoped));
}

/** Explicit fixture helper; ordinary import never runs T3 migrations. */
export async function initializeNativeTarget(t3Home: string, migration = 98): Promise<void> {
  if (!SUPPORTED.includes(migration)) throw new Error(`Unsupported fixture migration ${migration}`);
  const p = paths(t3Home);
  if (existsSync(p.db)) throw new Error("Refusing to initialize an existing T3 database.");
  mkdirSync(p.state, { recursive: true, mode: 0o700 });
  await Effect.runPromise(runMigrations({ toMigrationInclusive: migration }).pipe(
    Effect.provide(NodeSqlite.layer({ filename: p.db })),
  ));
}

interface Asset {
  finalPath: string;
  bytes: Buffer;
}
interface Plan {
  conversation: NativeConversation;
  sourceKey: string;
  fingerprint: string;
  result: NativeWriteResult;
  projectEvent?: UnsequencedProjectEvent;
  providerThread: typeof OrchestrationV2ProviderThread.Type;
  events: DomainEvent[];
  assets: Asset[];
  runtime?: ProviderRuntime.ProviderSessionRuntime;
}

function providerSelection(conversation: NativeConversation, options: NativeWriteOptions) {
  const driver = ProviderDriverKind.make(conversation.driver);
  const instance = options.providerInstance ?? conversation.driver;
  const p = paths(options.t3Home);
  let settings: Record<string, unknown> = {};
  if (existsSync(p.settings)) {
    const parsed: unknown = JSON.parse(readFileSync(p.settings, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("T3 settings must be an object.");
    settings = parsed as Record<string, unknown>;
  }
  const instances = settings.providerInstances;
  const configured = instances && typeof instances === "object" && !Array.isArray(instances)
    ? (instances as Record<string, unknown>)[instance] : undefined;
  if (configured === undefined && instance !== conversation.driver) throw new Error(`T3 provider instance '${instance}' is not configured.`);
  if (configured !== undefined && (!configured || typeof configured !== "object" || Array.isArray(configured))) throw new Error(`Invalid T3 provider instance '${instance}'.`);
  const config = configured === undefined ? undefined : Schema.decodeUnknownSync(ProviderInstanceConfig)(configured);
  if (config && config.driver !== conversation.driver) throw new Error(`Provider instance '${instance}' uses '${config.driver}', expected '${conversation.driver}'.`);
  if (options.resume && !resolveProviderInstanceEnabled(config ?? { driver })) throw new Error(`Provider instance '${instance}' is disabled; enable it or use --no-resume.`);
  const environment = Effect.runSync(mergeProviderInstanceEnvironment(config?.environment, process.env));
  const environmentValue = (name: string): string | undefined => {
    const variable = config?.environment?.findLast(variable => process.platform === "win32" ? variable.name.toUpperCase() === name.toUpperCase() : variable.name === name);
    const value = variable?.value;
    if (value !== undefined && typeof value !== "string") throw new Error(`Cannot verify '${name}' from an unresolved secret reference; use --no-resume or a verifiable provider configuration.`);
    return environment[name];
  };
  if (options.resume && conversation.source === "codex" && conversation.sourceHome) {
    const nativeConfig = Schema.decodeUnknownSync(CodexSettings)(config?.config ?? {});
    const environmentHome = nativeConfig.setupMode === "managed" ? undefined : environmentValue("CODEX_HOME");
    const effectiveConfig = !nativeConfig.homePath.trim() && environmentHome?.trim()
      ? { ...nativeConfig, homePath: environmentHome } : nativeConfig;
    const layout = Effect.runSync((nativeConfig.setupMode === "managed"
      ? resolveManagedCodexHomeLayout(p.state, ProviderInstanceId.make(instance), nativeConfig)
      : resolveCodexHomeLayout(effectiveConfig)).pipe(Effect.provide(NodePath.layer)));
    const sourceHome = expandHomePath(conversation.sourceHome, homedir());
    const sameHome = workspaceKey(sourceHome) === workspaceKey(layout.sharedHomePath);
    const sourceHistory = join(sourceHome, "thread_history_1.sqlite");
    const targetHistory = join(layout.sharedHomePath, "thread_history_1.sqlite");
    const sharedDatabase = existsSync(sourceHistory) && existsSync(targetHistory) && realpathSync(sourceHistory) === realpathSync(targetHistory);
    if (!sameHome && !sharedDatabase) throw new Error(`Codex source home '${sourceHome}' does not match provider '${instance}' history home '${layout.sharedHomePath}'. Configure the matching instance or use --no-resume.`);
  }
  if (options.resume && conversation.source === "claude" && conversation.sourceHome) {
    const nativeConfig = Schema.decodeUnknownSync(ClaudeSettings)(config?.config ?? {});
    const environmentHome = environmentValue("CLAUDE_CONFIG_DIR");
    const targetHome = Effect.runSync(resolveClaudeHomePath(nativeConfig, {
      ...(environmentHome === undefined ? {} : { CLAUDE_CONFIG_DIR: environmentHome }),
    }).pipe(Effect.provide(NodePath.layer)));
    if (workspaceKey(expandHomePath(conversation.sourceHome, homedir())) !== workspaceKey(targetHome)) throw new Error(`Claude source home '${conversation.sourceHome}' does not match provider '${instance}' history home '${targetHome}'. Configure the matching instance or use --no-resume.`);
  }
  if (options.resume && conversation.source === "omp") {
    if (!config) throw new Error("OMP resume requires a configured Pi instance that launches omp; use --provider-instance or --no-resume.");
    const piConfig = Schema.decodeUnknownSync(PiSettings)(config.config ?? {});
    if (!/^(?:omp|t3-import-omp)(?:\.(?:exe|cmd|bat|js|mjs))?$/i.test(basename(expandHomePath(piConfig.binaryPath, homedir())))) {
      throw new Error(`Provider '${instance}' does not launch an identifiable omp executable; refusing to bind OMP history to ordinary Pi.`);
    }
    const profileArgument = tokenizeCliArgs(piConfig.launchArgs).some(argument => argument === "--profile" || argument.startsWith("--profile="));
    if (environmentValue("OMP_PROFILE") || environmentValue("PI_PROFILE") || profileArgument) {
      throw new Error(`OMP profile overrides cannot yet be verified for provider '${instance}'; use --no-resume to import its history without a continuation binding.`);
    }
    if (conversation.sourceHome) {
      const agentDirectory = environmentValue("PI_CODING_AGENT_DIR");
      if (environmentValue("PI_CONFIG_DIR") || (agentDirectory && !isAbsolute(agentDirectory))) {
        throw new Error(`OMP directory overrides cannot yet be verified for provider '${instance}'; use an absolute PI_CODING_AGENT_DIR without PI_CONFIG_DIR, or --no-resume.`);
      }
      const targetHome = agentDirectory || join(homedir(), ".omp", "agent");
      if (workspaceKey(expandHomePath(conversation.sourceHome, homedir())) !== workspaceKey(targetHome)) throw new Error(`OMP source home does not match provider '${instance}' agent directory. Configure PI_CODING_AGENT_DIR or use --no-resume.`);
    }
    const executable = expandHomePath(piConfig.binaryPath, homedir());
    const bundledBridge = fileURLToPath(new URL("./omp.js", import.meta.url));
    const isBridge = /^t3-import-omp(?:\.(?:exe|cmd|bat|js|mjs))?$/i.test(basename(executable)) || existsSync(executable) && existsSync(bundledBridge) && realpathSync(executable) === realpathSync(bundledBridge);
    if (!isBridge) throw new Error(`OMP 18.22.0 continuation requires the t3-import-omp RPC bridge as provider '${instance}' binary; native omp uses a settlement event incompatible with the pinned T3 Pi driver. Use --no-resume for history-only import.`);
  }
  return { instanceId: ProviderInstanceId.make(instance), model: conversation.model?.trim() || DEFAULT_MODEL_BY_PROVIDER[driver] || "default" };
}

function imageAttachments(item: NativeHistoryItem, threadId: string, p: ReturnType<typeof paths>, assets: Asset[], warnings: string[]) {
  const references: string[] = [];
  const attachments = (item.images ?? []).flatMap(image => {
    if (image.url) {
      warnings.push(`Image '${image.name}' remains a remote reference (${image.url}); it was not downloaded.`);
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
        warnings.push(`Historical image '${image.path}' is unavailable (${error instanceof Error ? error.message : String(error)}); its reference was retained.`);
        references.push(`[Unavailable image: ${image.path}]`);
        return [];
      }
    } else { throw new Error(`Image '${image.name}' has no local content.`); }
    const id = `native-${hash(threadId).slice(0, 24)}-${uuid(`${item.id}:${image.id}:${hash(bytes)}`)}`;
    assets.push({ finalPath: join(p.assets, `${id}${extension}`), bytes });
    return [{ type: "image" as const, id, name: basename(image.name) || `image${extension}`, mimeType: image.mimeType, sizeBytes: bytes.length }];
  });
  return { attachments, references };
}

function nativeEvent(threadId: string, key: string, type: string, occurredAt: DateTime.Utc, payload: unknown, extra: Record<string, unknown> = {}): DomainEvent {
  return decodeEvent({ id: `${PREFIX}:${hash(threadId).slice(0, 20)}:${key}`, threadId, type, occurredAt, payload, ...extra });
}

function createPlan(conversation: NativeConversation, options: NativeWriteOptions, allocator: IdAllocator.IdAllocatorV2["Service"], projectId: ProjectId, projectRoot: string, newProject: boolean): Plan {
  const provider = providerSelection(conversation, options);
  const driver = ProviderDriverKind.make(conversation.driver);
  const sourceKey = `${conversation.source}:${conversation.id}`;
  const threadId = allocator.derive.threadFromProviderThread({ driver, providerInstanceId: provider.instanceId, nativeThreadId: `${PREFIX}:${sourceKey}` });
  const providerThreadId = allocator.derive.providerThread({ driver, providerInstanceId: provider.instanceId, nativeThreadId: options.resume ? conversation.nativeSessionRef : `${PREFIX}:history-only:${sourceKey}` });
  const warnings = [...conversation.warnings];
  const createdAt = at(conversation.createdAt);
  const updatedAt = at(conversation.updatedAt);
  const events: DomainEvent[] = [];
  const assets: Asset[] = [];
  const push = (key: string, type: string, time: DateTime.Utc, payload: unknown, extra: Record<string, unknown> = {}) => events.push(nativeEvent(threadId, key, type, time, payload, extra));
  const appThread = {
    id: threadId, projectId, title: conversation.title.trim() || "Imported session", createdBy: "system", creationSource: "server",
    providerInstanceId: provider.instanceId, modelSelection: provider, runtimeMode: "full-access", interactionMode: "default",
    branch: null, worktreePath: workspaceKey(conversation.workspace) === workspaceKey(projectRoot) ? null : resolve(conversation.workspace), activeProviderThreadId: options.resume ? providerThreadId : null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }, forkedFrom: null,
    createdAt, updatedAt, archivedAt: null, deletedAt: null, settledOverride: "settled", settledAt: updatedAt,
    lastVisitedAt: null,
  };
  push("thread", "thread.created", createdAt, appThread, { providerInstanceId: provider.instanceId });
  const providerThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread)({
    id: providerThreadId, driver: conversation.driver, providerInstanceId: provider.instanceId, providerSessionId: null,
    appThreadId: threadId, ownerNodeId: null, nativeThreadRef: options.resume ? { driver: conversation.driver, nativeId: conversation.nativeSessionRef, strength: "strong" } : null,
    nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: conversation.turns.length ? 1 : null,
    lastRunOrdinal: conversation.turns.length || null, handoffIds: [], forkedFrom: null, pendingBackgroundTasks: [],
    createdAt, updatedAt,
  });
  push("provider-thread", "provider-thread.updated", updatedAt, providerThread, { driver: conversation.driver, providerInstanceId: provider.instanceId });
  let ordinal = 0;
  let providerOrdinal = 0;
  conversation.turns.forEach((turn, turnIndex) => {
    const runId = allocator.derive.run({ threadId, ordinal: turnIndex + 1 });
    const attemptId = allocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
    const rootNodeId = allocator.derive.rootNode({ runId });
    const idleMetadata = (item: NativeHistoryItem) => (item.kind === "system_notice" || item.kind === "compaction") && Date.parse(item.timestamp) > Date.parse(turn.completedAt);
    // One local user turn may contain assistant replies from different native models.
    // T3 stores executed models on provider turns, so preserve those model sections
    // within the same local run/attempt; only the first keeps the native turn ref.
    const sections: Array<{ model?: string; items: NativeHistoryItem[] }> = [{ ...(turn.model?.trim() ? { model: turn.model.trim() } : {}), items: [] }];
    for (const item of turn.items) {
      if (idleMetadata(item)) continue;
      const model = item.model?.trim();
      let current = sections[sections.length - 1]!;
      if (model && current.model && model !== current.model && current.items.length) {
        current = { model, items: [] };
        sections.push(current);
      } else if (model) current.model = model;
      current.items.push(item);
    }
    const sectionIds = sections.map((_, index) => allocator.derive.providerTurn({ driver,
      nativeTurnId: index === 0 ? `${sourceKey}:${turn.id}` : `${sourceKey}:${turn.id}:model-section:${index}` }));
    const providerTurnId = sectionIds[0]!;
    const itemProviderTurns = new Map(sections.flatMap((section, index) => section.items.map(item => [item.id, sectionIds[index]!] as const)));
    const startedAt = at(turn.startedAt);
    const completedAt = at(turn.completedAt);
    const firstUser = turn.items.find(item => item.kind === "user_message");
    const nativeItemKey = (id: string) => `${sourceKey}:${turn.id}:${id}`;
    const userMessageId = allocator.derive.messageFromProviderItem({ driver, nativeItemId: nativeItemKey(firstUser?.id ?? "missing-user-input") });
    if (!firstUser) warnings.push(`Turn '${turn.id}' has no visible user input; its run retains an unmaterialized input reference.`);
    const common = { runId, providerInstanceId: provider.instanceId };
    push(`run:${turnIndex}`, "run.created", startedAt, {
      id: runId, threadId, ordinal: turnIndex + 1, providerInstanceId: provider.instanceId, modelSelection: { ...provider, model: turn.model?.trim() || provider.model },
      providerThreadId, userMessageId, rootNodeId, activeAttemptId: attemptId, status: turn.status,
      requestedAt: startedAt, startedAt, completedAt, checkpointId: null, contextHandoffId: null,
    }, common);
    push(`attempt:${turnIndex}`, "run-attempt.updated", startedAt, {
      id: attemptId, nativeThreadId: conversation.nativeSessionRef, runId, attemptOrdinal: 1, rootNodeId,
      providerInstanceId: provider.instanceId, providerThreadId, providerTurnId, reason: "initial", status: turn.status,
      startedAt, completedAt,
    }, common);
    const rootNode = { id: rootNodeId, threadId, runId, parentNodeId: null, rootNodeId, kind: "root_turn", status: turn.status,
      countsForRun: true, providerThreadId, providerTurnId, nativeItemRef: null, runtimeRequestId: null, checkpointScopeId: null, startedAt, completedAt };
    push(`node:${turnIndex}`, "node.updated", startedAt, rootNode, { ...common, nodeId: rootNodeId });
    sections.forEach((section, index) => push(`provider-turn:${turnIndex}:${index}`, "provider-turn.updated", completedAt, {
      id: sectionIds[index], providerThreadId, nodeId: rootNodeId, runAttemptId: attemptId,
      nativeTurnRef: index === 0 ? { driver: conversation.driver, nativeId: turn.id, strength: "strong" } : null,
      ordinal: ++providerOrdinal, status: turn.status,
      startedAt: index === 0 ? startedAt : at(section.items[0]!.timestamp),
      completedAt: index === sections.length - 1 ? completedAt : at(section.items[section.items.length - 1]!.timestamp),
      ...(section.model ? { model: section.model } : {}),
    }, { ...common, nodeId: rootNodeId }));
    turn.items.forEach((item, itemIndex) => {
      const independent = idleMetadata(item);
      const providerTurnId = independent ? null : itemProviderTurns.get(item.id)!;
      const key = nativeItemKey(item.id);
      const itemId = allocator.derive.turnItemFromProviderItem({ driver, nativeItemId: key });
      const messageId = allocator.derive.messageFromProviderItem({ driver, nativeItemId: key });
      const nodeId = allocator.derive.nodeFromProviderItem({ driver, nativeItemId: key });
      const time = at(item.timestamp);
      const { attachments, references } = imageAttachments(item, threadId, paths(options.t3Home), assets, warnings);
      const nativeItemRef = { driver: conversation.driver, nativeId: item.id, strength: "strong" };
      const base = { id: itemId, threadId, runId: independent ? null : runId, nodeId: independent ? null : nodeId, providerThreadId, providerTurnId, nativeItemRef,
        parentItemId: null, ordinal: ++ordinal, status: item.status, title: item.title ?? null, startedAt: time, completedAt: time, updatedAt: time };
      const prefix = `item:${turnIndex}:${itemIndex}`;
      const content = { ...item.data };
      const reserved = ["id", "threadId", "runId", "nodeId", "providerThreadId", "providerTurnId", "nativeItemRef", "parentItemId", "ordinal", "type", "status", "title", "startedAt", "completedAt", "updatedAt", "messageId", "planId"];
      if (reserved.some(field => field in content)) throw new Error(`Source item '${item.id}' contains a reserved orchestration field.`);
      if (item.kind === "user_message" || item.kind === "assistant_message") {
        if (typeof content.text !== "string") throw new Error(`Source message '${item.id}' has no text.`);
        const role = item.kind === "user_message" ? "user" : "assistant";
        const creation = { createdBy: role === "user" ? "user" : "agent", creationSource: "server" };
        const text = [content.text, ...references].filter(Boolean).join("\n\n");
        push(`${prefix}:message`, "message.updated", time, {
          ...creation, id: messageId, threadId, runId, nodeId, role, text, attachments, streaming: false, createdAt: time, updatedAt: time,
          ...(typeof content.phase === "string" ? { phase: content.phase } : {}),
        }, { ...common, nodeId });
        content.text = text;
        Object.assign(content, { ...creation, messageId, attachments, ...(role === "user" ? { inputIntent: firstUser?.id === item.id ? "turn_start" : "steer" } : { streaming: false }) });
      } else if ((attachments.length || references.length) && item.kind === "dynamic_tool") {
        content.output = { nativeOutput: content.output ?? null, importedImageReferences: references, importedImages: attachments.map(attachment => ({ ...attachment,
          path: assets.find(asset => basename(asset.finalPath).startsWith(`${attachment.id}.`))!.finalPath,
        })) };
        if (attachments.length) warnings.push(`Tool images on '${item.id}' are preserved in output.importedImages with local asset paths.`);
      } else if (attachments.length) {
        warnings.push(`Images on '${item.id}' are retained as local assets; this T3 tool variant has no attachment field.`);
      }
      if (item.kind === "reasoning" || item.kind === "proposed_plan") content.streaming = false;
      if (item.kind === "compaction") content.driver = conversation.driver;
      if (item.kind === "proposed_plan" || item.kind === "todo_list") {
        const planId = `plan:${hash(key)}`;
        content.planId = planId;
        push(`${prefix}:plan`, "plan.updated", time, {
          id: planId, threadId, runId, nodeId, status: "completed", kind: item.kind,
          ...(item.kind === "proposed_plan" ? { markdown: content.markdown } : { steps: content.steps, ...(content.explanation === undefined ? {} : { explanation: content.explanation }) }),
        }, { ...common, nodeId });
      }
      const nodeKind = item.kind === "assistant_message" ? "assistant_message" : item.kind === "reasoning" ? "reasoning" : item.kind === "proposed_plan" ? "plan" : item.kind === "todo_list" ? "todo_list" : item.kind === "user_message" || item.kind === "system_notice" || item.kind === "compaction" ? "system" : "tool_call";
      if (!independent) push(`${prefix}:node`, "node.updated", time, { ...rootNode, id: nodeId, parentNodeId: rootNodeId, kind: nodeKind, status: item.status, countsForRun: false, nativeItemRef, startedAt: time, completedAt: time }, { ...common, nodeId });
      push(`${prefix}:turn-item`, "turn-item.updated", time, { ...content, ...base, type: item.kind }, independent ? { providerInstanceId: provider.instanceId } : { ...common, nodeId });
    });
  });
  const fingerprint = hash(stable({ conversation: { ...conversation, warnings: [] }, provider, resume: options.resume,
    assets: assets.map(asset => ({ name: basename(asset.finalPath), hash: hash(asset.bytes) })) }));
  return {
    conversation, sourceKey, fingerprint, providerThread, events, assets,
    result: { source: conversation.source, sourceId: conversation.id, threadId, projectId, status: options.dryRun ? "dry-run" : "imported",
      turns: conversation.turns.length, items: conversation.turns.reduce((sum, turn) => sum + turn.items.length, 0),
      messages: conversation.turns.reduce((sum, turn) => sum + turn.items.filter(item => item.kind === "user_message" || item.kind === "assistant_message").length, 0),
      resumable: options.resume, warnings },
    ...(newProject ? { projectEvent: (({ sequence: _sequence, ...event }) => event)(Schema.decodeUnknownSync(ApplicationProjectEvent)({ sequence: 0,
      eventId: `${PREFIX}:project:${hash(workspaceKey(projectRoot))}`, type: "project.created", aggregateKind: "project", aggregateId: projectId,
      occurredAt: conversation.createdAt, commandId: null, causationEventId: null, correlationId: null,
      metadata: {}, payload: { projectId, title: basename(projectRoot) || projectRoot, workspaceRoot: resolve(projectRoot),
        defaultModelSelection: null, scripts: [], createdAt: conversation.createdAt, updatedAt: conversation.updatedAt },
    })) } : {}),
    ...(options.resume ? { runtime: Schema.decodeUnknownSync(ProviderRuntime.ProviderSessionRuntime)({
      threadId, providerName: conversation.driver, providerInstanceId: provider.instanceId, adapterKey: conversation.driver,
      runtimeMode: "full-access", status: "stopped", lastSeenAt: conversation.updatedAt,
      resumeCursor: { threadId: conversation.nativeSessionRef }, runtimePayload: { cwd: resolve(conversation.workspace), model: provider.model, modelSelection: provider },
    }) } : {}),
  };
}

/** Preserve the native parent's relationship without inventing another user turn. */
function linkChildPlan(parent: Plan, child: Plan, allocator: IdAllocator.IdAllocatorV2["Service"]) {
  const parentThreadEvent = parent.events.find(event => event.type === "thread.created")!;
  const childThreadIndex = child.events.findIndex(event => event.type === "thread.created");
  const childThreadEvent = child.events[childThreadIndex]!;
  if (parentThreadEvent.type !== "thread.created" || childThreadEvent.type !== "thread.created") throw new Error("Missing imported thread creation.");
  const parentItem = child.conversation.parent?.nativeItemId ? parent.events.find(event => event.type === "turn-item.updated" && event.payload.nativeItemRef?.nativeId === child.conversation.parent?.nativeItemId) : undefined;
  const runEvent = parentItem?.runId === undefined ? undefined : parent.events.find(event => event.type === "run.created" && event.payload.id === parentItem.runId);
  const run = runEvent?.type === "run.created" ? runEvent.payload : undefined;
  const driver = ProviderDriverKind.make(child.conversation.driver);
  const nodeId = allocator.derive.nodeFromProviderItem({ driver, nativeItemId: `${PREFIX}:child-link:${parent.sourceKey}:${child.sourceKey}` });
  const itemId = allocator.derive.turnItemFromProviderItem({ driver, nativeItemId: `${PREFIX}:child-link:${parent.sourceKey}:${child.sourceKey}` });
  const now = at(child.conversation.updatedAt);
  const startedAt = at(child.conversation.createdAt);
  const parentScopeId = run?.rootNodeId ?? allocator.derive.nodeFromProviderItem({ driver: ProviderDriverKind.make(parent.conversation.driver), nativeItemId: `${PREFIX}:child-scope:${parent.sourceKey}` });
  if (!run && !parent.events.some(event => event.type === "node.updated" && event.payload.id === parentScopeId)) {
    const scopeTime = parentThreadEvent.payload.createdAt;
    parent.events.push(nativeEvent(parent.result.threadId, "children:scope", "node.updated", scopeTime, {
      id: parentScopeId, threadId: parent.result.threadId, runId: null, parentNodeId: null, rootNodeId: parentScopeId,
      kind: "system", status: "completed", countsForRun: false, providerThreadId: parent.providerThread.id, providerTurnId: null,
      nativeItemRef: null, runtimeRequestId: null, checkpointScopeId: null, startedAt: scopeTime, completedAt: scopeTime,
    }, { nodeId: parentScopeId, providerInstanceId: parentThreadEvent.payload.providerInstanceId }));
  }
  if (!run) child.result.warnings.push("Native child launch is unavailable in the selected parent history; thread lineage is preserved without inventing ownership by a parent run.");
  const status = child.conversation.turns[child.conversation.turns.length - 1]!.status;
  const prompt = child.conversation.turns.flatMap(turn => turn.items).find(item => item.kind === "user_message")?.data.text;
  const lastAssistant = child.conversation.turns.flatMap(turn => turn.items).findLast(item => item.kind === "assistant_message");
  const result = typeof lastAssistant?.data.text === "string" ? lastAssistant.data.text : null;
  const childThread = makeSubagentChildThread({
    parentThread: parentThreadEvent.payload, childThreadId: ThreadId.make(child.result.threadId), parentNodeId: nodeId,
    activeProviderThreadId: childThreadEvent.payload.activeProviderThreadId, providerInstanceId: childThreadEvent.payload.providerInstanceId,
    modelSelection: childThreadEvent.payload.modelSelection, title: child.conversation.title, now: startedAt,
    // Imported snapshots keep historical app runs and are not live provider-owned children.
    createdBy: "system", creationSource: "server",
  });
  child.events[childThreadIndex] = nativeEvent(child.result.threadId, "thread", "thread.created", startedAt, {
    ...childThread, projectId: childThreadEvent.payload.projectId, worktreePath: childThreadEvent.payload.worktreePath, branch: childThreadEvent.payload.branch, updatedAt: now, settledOverride: "settled", settledAt: now,
  }, { providerInstanceId: childThread.providerInstanceId });
  const common = { ...(run ? { runId: run.id } : {}), nodeId, providerInstanceId: childThread.providerInstanceId };
  const key = `child:${hash(child.sourceKey)}`;
  const nativeTaskRef = child.conversation.parent?.nativeItemId ? { driver: parent.conversation.driver, nativeId: child.conversation.parent.nativeItemId, strength: "strong" } : null;
  parent.events.push(nativeEvent(parent.result.threadId, `${key}:node`, "node.updated", now, {
    id: nodeId, threadId: parent.result.threadId, runId: run?.id ?? null, parentNodeId: parentScopeId, rootNodeId: parentScopeId,
    kind: "subagent", status, countsForRun: false, providerThreadId: child.providerThread.id, providerTurnId: null,
    nativeItemRef: nativeTaskRef, runtimeRequestId: null, checkpointScopeId: null, startedAt, completedAt: now,
  }, common));
  const subagent = {
    id: nodeId, threadId: parent.result.threadId, runId: run?.id ?? null, parentNodeId: parentScopeId,
    origin: "provider_native", createdBy: "agent", driver, providerInstanceId: childThread.providerInstanceId,
    providerThreadId: child.providerThread.id, childThreadId: child.result.threadId, nativeTaskRef,
    prompt: typeof prompt === "string" ? prompt : "", title: child.conversation.title, model: child.conversation.model ?? null,
    modelSelection: childThread.modelSelection, status, result, startedAt, completedAt: now, updatedAt: now,
  };
  parent.events.push(nativeEvent(parent.result.threadId, `${key}:subagent`, "subagent.updated", now, subagent, common));
  const turnItems = parent.events.filter(event => event.type === "turn-item.updated");
  parent.events.push(nativeEvent(parent.result.threadId, `${key}:item`, "turn-item.updated", now, {
    id: itemId, threadId: parent.result.threadId, runId: run?.id ?? null, nodeId,
    providerThreadId: parent.providerThread.id, providerTurnId: run && parentItem?.type === "turn-item.updated" ? parentItem.payload.providerTurnId : null,
    nativeItemRef: nativeTaskRef, parentItemId: parentItem?.type === "turn-item.updated" ? parentItem.payload.id : null,
    ordinal: Math.max(0, ...turnItems.map(event => event.payload.ordinal)) + 1, type: "subagent", subagentId: nodeId,
    origin: "provider_native", driver, providerInstanceId: childThread.providerInstanceId, childThreadId: child.result.threadId,
    prompt: subagent.prompt, result, status, title: child.conversation.title, startedAt, completedAt: now, updatedAt: now,
  }, common));
}

function flattenConversations(input: NativeConversation[]): NativeConversation[] {
  const result: NativeConversation[] = [];
  const ancestry = new Set<NativeConversation>();
  const visit = (conversation: NativeConversation, parent?: NativeConversation) => {
    if (ancestry.has(conversation)) throw new Error("Cyclic native child history.");
    if (parent && conversation.parent && conversation.parent.sourceId !== parent.id) throw new Error("Native child declares a different parent.");
    ancestry.add(conversation);
    result.push({ ...conversation, ...(parent && !conversation.parent ? { parent: { sourceId: parent.id } } : {}) });
    for (const child of conversation.children ?? []) visit(child, conversation);
    ancestry.delete(conversation);
  };
  for (const conversation of input) visit(conversation);
  return result;
}

function readMarker(dbPath: string, sourceKey: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='t3_native_imports'").get()) return undefined;
    return db.prepare("SELECT * FROM t3_native_imports WHERE source_key=?").get(sourceKey) as { fingerprint: string; thread_id: string; last_sequence: number } | undefined;
  } finally { db.close(); }
}

function planAll(conversations: NativeConversation[], options: NativeWriteOptions) {
  return Effect.gen(function* () {
    if (options.projectRoot !== undefined && options.projectId !== undefined) throw new Error("Choose either --project-root or --project-id.");
    if (options.projectRoot !== undefined && !options.projectRoot.trim()) throw new Error("Project root must not be empty.");
    const allocator = yield* IdAllocator.IdAllocatorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const activeProjects = yield* projects.list();
    const selectedProject = options.projectId === undefined ? undefined : activeProjects.find(project => project.projectId === options.projectId);
    if (options.projectId !== undefined && !selectedProject) throw new Error(`T3 project '${options.projectId}' was not found or is deleted. Use the projects command to list destination projects.`);
    const created = new Set<string>();
    const plans: Plan[] = [];
    for (const conversation of conversations) {
      const projectRoot = selectedProject?.workspaceRoot ?? options.projectRoot ?? conversation.workspace;
      const workspace = workspaceKey(projectRoot);
      const matches = activeProjects.filter(project => workspaceKey(project.workspaceRoot) === workspace);
      if (!selectedProject && matches.length > 1) throw new Error(`Multiple T3 projects share directory '${projectRoot}'; choose --project-id explicitly.`);
      const project = selectedProject ?? matches[0];
      const projectId = project?.projectId ?? ProjectId.make(`native-project:${hash(workspace)}`);
      const effectiveOptions = { ...options, resume: options.resume && conversation.resumeSupported !== false };
      const plan = createPlan(conversation, effectiveOptions, allocator, projectId, project?.workspaceRoot ?? projectRoot, project === undefined && !created.has(projectId));
      if (options.resume && !effectiveOptions.resume) plan.result.warnings.push("This native child history cannot resume independently; imported as history-only.");
      created.add(projectId);
      plans.push(plan);
    }
    const linked = new Set<string>();
    const linking = new Set<string>();
    const link = (plan: Plan): void => {
      if (linked.has(plan.sourceKey)) return;
      if (linking.has(plan.sourceKey)) throw new Error(`Cyclic native parent relation for '${plan.sourceKey}'.`);
      linking.add(plan.sourceKey);
      if (plan.conversation.parent) {
        const key = `${plan.conversation.source}:${plan.conversation.parent.sourceId}`;
        const parent = plans.find(candidate => candidate.sourceKey === key);
        if (!parent) throw new Error(`Native parent '${key}' must be included in this import.`);
        link(parent);
        linkChildPlan(parent, plan, allocator);
      }
      linking.delete(plan.sourceKey);
      linked.add(plan.sourceKey);
    };
    plans.forEach(link);
    for (const plan of plans) {
      // Lineage and parent link records are part of the replay identity too.
      plan.fingerprint = hash(stable({ source: plan.fingerprint, relationships: plan.events.filter(event => event.type === "subagent.updated" || event.type === "thread.created") }));
      const marker = readMarker(paths(options.t3Home).db, plan.sourceKey);
      const thread = yield* projections.findThread(ThreadId.make(plan.result.threadId));
      if (marker) {
        if (marker.fingerprint !== plan.fingerprint) throw new Error(`Imported source '${plan.sourceKey}' changed. Native sync/replace is not implemented; history was not overwritten.`);
        if (!thread || marker.thread_id !== plan.result.threadId || thread.deletedAt !== null) throw new Error(`Imported target '${plan.sourceKey}' was deleted or rebound; refusing to recreate it.`);
        const latest = yield* eventStore.latestSequence({ threadId: ThreadId.make(plan.result.threadId) });
        if (latest !== marker.last_sequence) throw new Error(`Imported target '${plan.sourceKey}' contains newer T3 activity; history was not overwritten.`);
        plan.result.status = "already-imported";
      } else if (thread) { throw new Error(`Target thread '${plan.result.threadId}' already exists without this importer's marker.`); }
    }
    return plans;
  });
}

function validateConversations(conversations: NativeConversation[]) {
  const seen = new Set<string>();
  if (!conversations.length) throw new Error("Select at least one source conversation.");
  for (const conversation of conversations) {
    const key = `${conversation.source}:${conversation.id}`;
    if (seen.has(key)) throw new Error(`Duplicate source conversation '${key}'.`);
    seen.add(key);
    if (conversation.active) throw new Error(`Source '${key}' has an active or indeterminate turn; settle it before importing.`);
    if (!conversation.id.trim() || !conversation.nativeSessionRef.trim() || !conversation.workspace.trim()) throw new Error(`Source '${key}' lacks its stable identity or workspace.`);
    if (conversation.source === "codex" && conversation.driver !== "codex" || conversation.source === "omp" && conversation.driver !== "pi" || conversation.source === "claude" && conversation.driver !== "claudeAgent") throw new Error(`Source '${key}' has a mismatched native driver.`);
    if (!conversation.turns.length) throw new Error(`Source '${key}' has no terminal history to import.`);
    const turns = new Set<string>();
    for (const turn of conversation.turns) {
      if (!turn.id.trim() || turns.has(turn.id)) throw new Error(`Duplicate or empty turn id in '${key}'.`);
      turns.add(turn.id);
      if (!["completed", "interrupted", "failed"].includes(turn.status)) throw new Error(`Source '${key}' has a non-terminal turn.`);
      const items = new Set<string>();
      for (const item of turn.items) {
        if (!item.id.trim() || items.has(item.id)) throw new Error(`Duplicate or empty item id in turn '${turn.id}'.`);
        items.add(item.id);
      }
    }
  }
}

async function verifiedBackup(dbPath: string): Promise<string> {
  const directory = join(dirname(dbPath), "t3-import-backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `statev2-native-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.sqlite`);
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try { await backup(source, destination); }
  finally { source.close(); }
  chmodSync(destination, 0o600);
  const check = new DatabaseSync(destination, { readOnly: true });
  try {
    if (Object.values(check.prepare("PRAGMA integrity_check").get() ?? {})[0] !== "ok") throw new Error(`Backup integrity check failed: ${destination}`);
  } finally { check.close(); }
  return destination;
}

function stageAssets(plans: Plan[], directory: string) {
  const created: string[] = [];
  const staging = join(directory, `.native-import-${randomUUID()}`);
  const assets = new Map(plans.flatMap(plan => plan.assets.map(asset => [asset.finalPath, asset] as const)));
  if (!assets.size) return { created, cleanup: () => {} };
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const asset of assets.values()) {
      if (existsSync(asset.finalPath)) {
        if (hash(readFileSync(asset.finalPath)) !== hash(asset.bytes)) throw new Error(`Existing attachment differs from imported content: ${asset.finalPath}`);
        continue;
      }
      const staged = join(staging, basename(asset.finalPath));
      writeFileSync(staged, asset.bytes, { flag: "wx", mode: 0o600 });
      if (hash(readFileSync(staged)) !== hash(asset.bytes)) throw new Error("Attachment staging verification failed.");
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

function resultFor(plans: Plan[], target: string, migration: number, dryRun: boolean, backup: string | null): NativeImportResult {
  const statuses = new Set(plans.map(plan => plan.result.status));
  return { schemaVersion: 1, status: dryRun ? "dry-run" : statuses.size > 1 ? "mixed" : statuses.has("imported") ? "imported" : "already-imported", target, migration, backup, results: plans.map(plan => plan.result) };
}

export async function importNativeConversations(conversations: NativeConversation[], options: NativeWriteOptions): Promise<NativeImportResult> {
  conversations = flattenConversations(conversations);
  validateConversations(conversations);
  const p = paths(options.t3Home);
  if (options.initialize && !existsSync(p.db)) {
    if (options.dryRun) throw new Error("Dry-run never initializes a missing target.");
    await initializeNativeTarget(options.t3Home);
  }
  const inspection = inspectNativeTarget(options.t3Home);
  if (!inspection.supported || inspection.migration === null) throw new Error(inspection.reason ?? "Unsupported T3 target.");
  if (inspection.live && !options.dryRun) throw new Error("T3 is running. Close it before importing with the offline native writer.");
  const preview = await Effect.runPromise(planAll(conversations, options).pipe(Effect.provide(runtimeLayer(p.db, true))));
  if (options.dryRun || preview.every(plan => plan.result.status === "already-imported")) return resultFor(preview, p.db, inspection.migration, options.dryRun, null);
  return Effect.runPromise(Effect.gen(function* () {
    yield* holdServerOwnershipLock(p.runtime);
    if (liveRuntime(p.runtime)) throw new Error("T3 started while preparing import. Close it and retry.");
    const plans = yield* Effect.promise(() => Effect.runPromise(planAll(conversations, options).pipe(Effect.provide(runtimeLayer(p.db, true)))));
    const pending = plans.filter(plan => plan.result.status !== "already-imported");
    if (!pending.length) return resultFor(plans, p.db, inspection.migration!, false, null);
    const savedBackup = yield* Effect.promise(() => verifiedBackup(p.db));
    let committed = false;
    yield* Effect.acquireRelease(
      Effect.sync(() => stageAssets(pending, p.assets)),
      assets => Effect.sync(() => {
        if (!committed) for (const path of assets.created) rmSync(path, { force: true });
        assets.cleanup();
      }),
    );
    yield* Effect.promise(() => Effect.runPromise(Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const runtimes = yield* ProviderRuntime.ProviderSessionRuntimeRepository;
        const eventStore = yield* EventStore.EventStoreV2;
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS t3_native_imports (
            source_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE,
            last_sequence INTEGER NOT NULL, imported_at TEXT NOT NULL
          )`;
          for (const plan of pending) {
            if (plan.projectEvent) {
              yield* sink.commitProjectCommand({ commandId: CommandId.make(`${PREFIX}:project-command:${hash(plan.result.projectId)}`),
                projectId: ProjectId.make(plan.result.projectId), commandType: "project.create", acceptedAt: at(plan.conversation.createdAt), event: plan.projectEvent });
            }
            const stored = yield* sink.write({
              ...(plan.runtime ? { unlessNativeThreadOwned: plan.providerThread } : {}),
              events: plan.events,
            });
            if (!stored.length) throw new Error(`Native session '${plan.sourceKey}' already belongs to another T3 thread.`);
            if (plan.runtime) yield* runtimes.upsert(plan.runtime, { onConflict: "ignore" });
            const latest = yield* eventStore.latestSequence({ threadId: ThreadId.make(plan.result.threadId) });
            yield* sql`INSERT INTO t3_native_imports (source_key, fingerprint, thread_id, last_sequence, imported_at)
              VALUES (${plan.sourceKey}, ${plan.fingerprint}, ${plan.result.threadId}, ${latest}, ${new Date().toISOString()})`;
          }
        }));
    }).pipe(Effect.provide(runtimeLayer(p.db)))));
    committed = true;
    return resultFor(plans, p.db, inspection.migration!, false, savedBackup);
  }).pipe(Effect.scoped));
}
