import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import { ThreadId, EventId, isProviderNativeSubagentThread } from "@t3tools/contracts";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import * as EventSink from "@t3-native/server/orchestration-v2/EventSink.ts";
import * as EventStore from "@t3-native/server/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "@t3-native/server/orchestration-v2/ProjectionStore.ts";
import { deriveLatestThreadRun } from "@t3tools/client-runtime/state/thread-execution";
import { importNativeConversations, initializeNativeTarget, inspectNativeTarget } from "./target.ts";
import type { NativeConversation, NativeHistoryItem } from "../src/native/types.js";

const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const time = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
function conversation(): NativeConversation {
  const item = (id: string, kind: NativeHistoryItem["kind"], second: number, data: NativeHistoryItem["data"]): NativeHistoryItem => ({ id, kind, timestamp: time(second), status: "completed", data });
  return {
    source: "codex", id: "11111111-1111-4111-8111-111111111111", nativeSessionRef: "11111111-1111-4111-8111-111111111111",
    driver: "codex", title: "Rich native history", workspace: "/synthetic/native-import", model: "gpt-test",
    createdAt: time(0), updatedAt: time(30), warnings: [], active: false,
    turns: [
      { id: "native-turn-1", status: "completed", startedAt: time(0), completedAt: time(20), items: [
        { ...item("user", "user_message", 0, { text: "Question" }), images: [{ id: "picture", name: "picture.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCboAAAAASUVORK5CYII=" }] },
        item("commentary", "assistant_message", 1, { text: "Starting", phase: "commentary" }),
        item("steer", "user_message", 2, { text: "Keep all tools" }),
        item("command", "command_execution", 3, { input: "pwd", output: "/synthetic/native-import", exitCode: 0 }),
        item("reasoning", "reasoning", 4, { text: "Visible reasoning" }),
        item("file", "file_change", 5, { fileName: "example.ts", diffStr: "+native import\n" }),
        item("web", "web_search", 6, { patterns: ["native import"], results: [{ title: "Official docs", url: "https://example.com/docs" }] }),
        item("plan", "proposed_plan", 7, { markdown: "1. Import\n2. Verify" }),
        item("todo", "todo_list", 8, { steps: [{ id: "step-1", text: "Import", status: "completed" }] }),
        item("tool", "dynamic_tool", 9, { toolName: "native_tool", input: { mode: "read" }, output: { text: "Native output" } }),
        item("compact", "compaction", 10, { summary: "Compacted native context" }),
        item("notice", "system_notice", 11, { message: "Imported native marker" }),
        item("final", "assistant_message", 20, { text: "Done", phase: "final_answer" }),
      ] },
      { id: "native-turn-2", status: "interrupted", startedAt: time(21), completedAt: time(30), items: [
        item("user-2", "user_message", 21, { text: "Second question" }),
        { ...item("interrupted-tool", "command_execution", 29, { input: "long task", output: "Partial output" }), status: "interrupted" },
      ] },
    ],
  };
}
function targetPath(home: string) { return join(home, "userdata", "statev2.sqlite"); }
function sqlRead<T>(home: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(targetPath(home), { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
function count(home: string, table: string): number {
  return sqlRead(home, db => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n));
}
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]).sort();
}

for (const migration of [96, 97, 98]) test(`native T3 migration ${migration}: rich initial import, replay safety and native resume binding`, async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-target-"));
  try {
    await initializeNativeTarget(home, migration);
    const input = conversation();
    const before = digest(targetPath(home));
    const beforeFiles = files(home);
    const dry = await importNativeConversations([input], { t3Home: home, dryRun: true, resume: true });
    assert.equal(dry.status, "dry-run");
    assert.equal(dry.results[0]!.items, 15);
    assert.equal(dry.results[0]!.messages, 5);
    assert.equal(digest(targetPath(home)), before);
    assert.deepEqual(files(home), beforeFiles);
    const imported = await importNativeConversations([input], { t3Home: home, dryRun: false, resume: true });
    assert.equal(imported.status, "imported");
    assert.equal(imported.migration, migration);
    assert.ok(imported.backup && existsSync(imported.backup));
    assert.equal(count(home, "orchestration_v2_projection_threads"), 1);
    assert.equal(count(home, "orchestration_v2_projection_runs"), 2);
    assert.equal(count(home, "orchestration_v2_projection_run_attempts"), 2);
    assert.equal(count(home, "orchestration_v2_projection_provider_turns"), 2);
    assert.equal(count(home, "orchestration_v2_projection_turn_items"), 15);
    assert.equal(count(home, "orchestration_v2_projection_messages"), 5);
    assert.equal(count(home, "orchestration_v2_projection_plans"), 2);
    assert.equal(count(home, "orchestration_v2_effect_outbox"), 0);
    assert.equal(count(home, "orchestration_v2_projection_checkpoints"), 0);
    sqlRead(home, db => {
      const runs = db.prepare("SELECT status FROM orchestration_v2_projection_runs ORDER BY ordinal").all();
      assert.deepEqual(runs.map(row => row.status), ["completed", "interrupted"]);
      const steers = db.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE type='user_message'").all().map(row => JSON.parse(String(row.payload_json)));
      assert.equal(steers.filter(item => item.inputIntent === "steer").length, 1);
      const runtime = db.prepare("SELECT * FROM provider_session_runtime").get()!;
      assert.deepEqual(JSON.parse(String(runtime.resume_cursor_json)), { threadId: input.nativeSessionRef });
      assert.equal(runtime.provider_name, "codex");
      assert.equal(runtime.status, "stopped");
      const project = db.prepare("SELECT workspace_root FROM projection_projects").get()!;
      assert.equal(project.workspace_root, input.workspace);
    });
    assert.equal(readdirSync(join(home, "userdata", "attachments")).filter(file => file.endsWith(".png")).length, 1);
    const countAfter = count(home, "orchestration_events");
    const snapshot = digest(targetPath(home));
    const allFiles = files(home);
    const again = await importNativeConversations([input], { t3Home: home, dryRun: false, resume: true });
    assert.equal(again.status, "already-imported");
    assert.equal(again.backup, null);
    assert.equal(count(home, "orchestration_events"), countAfter);
    assert.equal(digest(targetPath(home)), snapshot);
    assert.deepEqual(files(home), allFiles);
    const changed = structuredClone(input);
    changed.turns[0]!.items[0]!.data.text = "Edited source history";
    await assert.rejects(importNativeConversations([changed], { t3Home: home, dryRun: false, resume: true }), /changed/);
    assert.equal(count(home, "orchestration_events"), countAfter);
    assert.equal(digest(targetPath(home)), snapshot);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("active/invalid inputs and native-session ownership conflict cannot partially write a batch", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-target-safety-"));
  try {
    await initializeNativeTarget(home);
    const input = conversation();
    const before = digest(targetPath(home));
    await assert.rejects(importNativeConversations([{ ...input, active: true }], { t3Home: home, dryRun: false, resume: true }), /active/);
    const invalid = structuredClone(input);
    invalid.turns[1]!.items[0]!.data.id = "injected-orchestration-id";
    await assert.rejects(importNativeConversations([invalid], { t3Home: home, dryRun: false, resume: true }), /reserved/);
    assert.equal(digest(targetPath(home)), before);
    assert.equal(count(home, "orchestration_events"), 0);
    const duplicateNative = { ...structuredClone(input), id: "different-source-identity", title: "Second source owns same native session" };
    await assert.rejects(importNativeConversations([input, duplicateNative], { t3Home: home, dryRun: false, resume: true }), /already belongs/);
    assert.equal(count(home, "orchestration_events"), 0);
    assert.equal(count(home, "projection_projects"), 0);
    assert.equal(count(home, "orchestration_v2_effect_outbox"), 0);
    assert.equal(existsSync(join(home, "userdata", "attachments")) ? readdirSync(join(home, "userdata", "attachments")).length : 0, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("native ownership locks block writes; a live runtime permits only unchanged dry-run", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-target-lock-"));
  try {
    await initializeNativeTarget(home);
    const before = digest(targetPath(home));
    writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: process.pid }));
    assert.equal(inspectNativeTarget(home).live, true);
    await importNativeConversations([conversation()], { t3Home: home, dryRun: true, resume: true });
    await assert.rejects(importNativeConversations([conversation()], { t3Home: home, dryRun: false, resume: true }), /T3 is running/);
    assert.equal(digest(targetPath(home)), before);
    rmSync(join(home, "userdata", "server-runtime.json"));
    const lock = new DatabaseSync(join(home, "userdata", "server-owner.sqlite"));
    try {
      lock.exec("BEGIN EXCLUSIVE");
      await assert.rejects(importNativeConversations([conversation()], { t3Home: home, dryRun: false, resume: true }), /owns|ownership/);
    } finally { lock.close(); }
    assert.equal(digest(targetPath(home)), before);
    assert.equal(count(home, "orchestration_events"), 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("provider identity, source changes and later T3 activity fail closed", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-target-provider-"));
  try {
    await initializeNativeTarget(home);
    const input = conversation();
    writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { other: { driver: "pi", enabled: true } } }));
    await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: false, resume: true, providerInstance: "other" }), /expected 'codex'/);
    writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { codex: { driver: "codex", enabled: false } } }));
    await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: false, resume: true }), /disabled/);
    const historical = await importNativeConversations([input], { t3Home: home, dryRun: false, resume: false });
    assert.equal(historical.results[0]!.resumable, false);
    assert.equal(count(home, "provider_session_runtime"), 0);
    const threadId = ThreadId.make(historical.results[0]!.threadId);
    const layer = EventSink.layer.pipe(
      Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
      Layer.provide(NodeSqlite.layer({ filename: targetPath(home) })),
    );
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const thread = yield* store.getThread(threadId);
      yield* sink.write({ events: [{ id: EventId.make("native-test:edited-thread"), threadId, type: "thread.metadata-updated", occurredAt: DateTime.makeUnsafe(time(31)), payload: { ...thread, title: "Edited in T3" } }] });
    }).pipe(Effect.provide(layer)));
    const eventCount = count(home, "orchestration_events");
    await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: false, resume: false }), /newer T3 activity/);
    assert.equal(count(home, "orchestration_events"), eventCount);
    const meta = new DatabaseSync(targetPath(home));
    try { meta.prepare("UPDATE effect_sql_migrations SET migration_id=99 WHERE migration_id=98").run(); }
    finally { meta.close(); }
    assert.equal(inspectNativeTarget(home).supported, false);
    await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: true, resume: false }), /Unsupported T3 migration 99/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("resume requires the source native home and an OMP-capable configured runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-target-homes-"));
  try {
    await initializeNativeTarget(home);
    const sourceHome = join(home, "native-source");
    const input = { ...conversation(), sourceHome };
    await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: true, resume: true }), /does not match/);
    writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { codex: { driver: "codex", config: { homePath: sourceHome } } } }));
    const codex = await importNativeConversations([input], { t3Home: home, dryRun: true, resume: true });
    assert.equal(codex.results[0]!.resumable, true);
    const settingsPath = join(home, "userdata", "settings.json");
    const configureCodex = (setupMode: string, config: Record<string, unknown> = {}) => writeFileSync(settingsPath, JSON.stringify({ providerInstances: { codex: { driver: "codex", config: { setupMode, ...config }, environment: [{ name: "CODEX_HOME", value: sourceHome, sensitive: false }] } } }));
    configureCodex("managed");
    await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: true, resume: true }), /does not match/);
    configureCodex("managed", { homePath: sourceHome });
    assert.equal((await importNativeConversations([input], { t3Home: home, dryRun: true, resume: true })).results[0]!.resumable, true);
    configureCodex("existing", { shadowHomePath: join(home, "shadow") });
    assert.equal((await importNativeConversations([input], { t3Home: home, dryRun: true, resume: true })).results[0]!.resumable, true);
    const omp: NativeConversation = { ...input, source: "omp", driver: "pi", nativeSessionRef: join(sourceHome, "session.jsonl") };
    writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { omp: { driver: "pi", enabled: true, config: { enabled: true, binaryPath: "pi" } } } }));
    await assert.rejects(importNativeConversations([omp], { t3Home: home, dryRun: true, resume: true, providerInstance: "omp" }), /ordinary Pi/);
    writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { omp: { driver: "pi", enabled: true, config: { enabled: true, binaryPath: "t3-import-omp" }, environment: [{ name: "PI_CODING_AGENT_DIR", value: sourceHome, sensitive: false }] } } }));
    const supported = await importNativeConversations([omp], { t3Home: home, dryRun: true, resume: true, providerInstance: "omp" });
    assert.equal(supported.results[0]!.resumable, true);
    assert.equal(count(home, "orchestration_events"), 0);
    await importNativeConversations([omp], { t3Home: home, dryRun: true, resume: false, providerInstance: "omp" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("missing historical message and tool images retain references without aborting the batch", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-missing-images-"));
  try {
    await initializeNativeTarget(home);
    const input = conversation();
    const missing = join(home, "deleted.png");
    input.turns[0]!.items[0]!.images = [{ id: "gone", name: "deleted.png", mimeType: "image/png", path: missing }];
    input.turns[0]!.items.find(item => item.id === "tool")!.images = [{ id: "gone-tool", name: "deleted.png", mimeType: "image/png", path: missing }];
    const result = await importNativeConversations([input], { t3Home: home, dryRun: false, resume: false });
    assert.equal(result.status, "imported");
    assert.match(JSON.stringify(result), /unavailable/);
    sqlRead(home, db => {
      const events = JSON.stringify(db.prepare("SELECT * FROM orchestration_events").all());
      assert.ok(events.includes("Unavailable image:"));
      assert.ok(events.includes("importedImageReferences"));
      assert.ok(events.includes(missing));
    });
    assert.equal(count(home, "orchestration_v2_projection_runs"), 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

async function projection(home: string, threadId: string) {
  return Effect.runPromise(Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    return yield* store.getThreadProjection(ThreadId.make(threadId));
  }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(NodeSqlite.layer({ filename: targetPath(home), readonly: true }))))));
}

test("imported history exposes the actual model of each turn through T3 projection queries", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-models-"));
  try {
    await initializeNativeTarget(home);
    const input = conversation();
    Object.assign(input.turns[0]!, { model: "gpt-actual-first" });
    Object.assign(input.turns[1]!, { model: "gpt-actual-second" });
    const imported = await importNativeConversations([input], { t3Home: home, dryRun: false, resume: false });
    const result = await projection(home, imported.results[0]!.threadId);
    assert.deepEqual(result.runs.map(run => run.modelSelection.model), ["gpt-actual-first", "gpt-actual-second"]);
    assert.deepEqual(result.providerTurns.map(turn => turn.model), ["gpt-actual-first", "gpt-actual-second"]);
    assert.equal(result.thread.modelSelection.model, "gpt-test", "configured restore model stays separate from actual historical models");
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("assistant model changes within a native turn remain attached to the corresponding T3 items", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-item-models-"));
  try {
    await initializeNativeTarget(home);
    const input = conversation();
    input.turns[0]!.model = "first-model";
    input.turns[0]!.items.find(item => item.id === "commentary")!.model = "first-model";
    input.turns[0]!.items.find(item => item.id === "final")!.model = "second-model";
    const imported = await importNativeConversations([input], { t3Home: home, dryRun: false, resume: false });
    const result = await projection(home, imported.results[0]!.threadId);
    const actualModelFor = (nativeId: string) => {
      const item = result.turnItems.find(item => item.nativeItemRef?.nativeId === nativeId)!;
      return result.providerTurns.find(turn => turn.id === item.providerTurnId)?.model;
    };
    assert.equal(actualModelFor("commentary"), "first-model");
    assert.equal(actualModelFor("final"), "second-model");
    assert.equal(result.runs.length, 2, "model changes do not invent another local user turn");
    assert.ok(result.providerTurns.every(turn => turn.status !== "running"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("native child histories become linked T3 child threads and unsupported child resumes stay history-only", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-children-"));
  try {
    await initializeNativeTarget(home);
    const root = conversation();
    const child = { ...conversation(), id: "native-child", nativeSessionRef: "native-child", title: "Native child", parent: { sourceId: root.id, nativeItemId: "tool" }, resumeSupported: false };
    root.children = [child];
    const imported = await importNativeConversations([root], { t3Home: home, dryRun: false, resume: true });
    assert.equal(imported.results.length, 2, "each native child has its own actual history");
    const childResult = imported.results.find(result => result.sourceId === "native-child")!;
    assert.equal(childResult.resumable, false);
    assert.match(childResult.warnings.join(" "), /resume|history-only/i);
    const rootProjection = await projection(home, imported.results[0]!.threadId);
    const childProjection = await projection(home, childResult.threadId);
    assert.equal(childProjection.messages.length, 5);
    assert.deepEqual(childProjection.thread.lineage, { parentThreadId: imported.results[0]!.threadId, relationshipToParent: "subagent", rootThreadId: imported.results[0]!.threadId });
    assert.ok(childProjection.providerThreads.every(thread => thread.nativeThreadRef === null), "history-only child has no native resume binding");
    const subagent = rootProjection.subagents.find(subagent => subagent.childThreadId === childResult.threadId)!;
    assert.ok(subagent, "the parent exposes a native subagent link");
    assert.equal(subagent.status, "interrupted");
    assert.ok(rootProjection.turnItems.some(item => item.type === "subagent" && item.childThreadId === childResult.threadId));
    assert.equal(rootProjection.runtimeRequests.length + childProjection.runtimeRequests.length, 0);
    const again = await importNativeConversations([root], { t3Home: home, dryRun: false, resume: true });
    assert.ok(again.results.every(result => result.status === "already-imported"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("Claude resume uses the native configured home precedence and refuses another history store", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-claude-homes-"));
  try {
    await initializeNativeTarget(home);
    const sourceHome = join(home, "claude-source");
    const input: NativeConversation = { ...conversation(), source: "claude", driver: "claudeAgent", sourceHome };
    await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: true, resume: true }), /does not match/);
    writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: sourceHome }, environment: [{ name: "CLAUDE_CONFIG_DIR", value: join(home, "wrong-environment-home"), sensitive: false }] } } }));
    assert.equal((await importNativeConversations([input], { t3Home: home, dryRun: true, resume: true })).results[0]!.resumable, true);
    writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", environment: [{ name: "CLAUDE_CONFIG_DIR", value: sourceHome, sensitive: false }] } } }));
    assert.equal((await importNativeConversations([input], { t3Home: home, dryRun: true, resume: true })).results[0]!.resumable, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the native T3 UI presents imported child archives as terminal historical views", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-child-status-"));
  try {
    await initializeNativeTarget(home);
    const root = conversation();
    root.children = [{ ...conversation(), id: "terminal-child", nativeSessionRef: "terminal-child", parent: { sourceId: root.id, nativeItemId: "tool" }, resumeSupported: false }];
    const imported = await importNativeConversations([root], { t3Home: home, dryRun: false, resume: false });
    const childResult = imported.results.find(result => result.sourceId === "terminal-child")!;
    const child = await projection(home, childResult.threadId);
    assert.equal(isProviderNativeSubagentThread(child.thread), false, "an imported archive is not live provider-controlled work");
    assert.equal(child.thread.createdBy, "system");
    assert.equal(child.thread.creationSource, "server");
    assert.equal(deriveLatestThreadRun(child)?.status, "interrupted");
    assert.deepEqual(child.runs.map(run => run.status), ["completed", "interrupted"], "historical app runs remain intact");
    assert.equal(child.runtimeRequests.length, 0);
    assert.ok(child.nodes.every(node => node.status !== "running" && node.status !== "pending"));
    const again = await importNativeConversations([root], { t3Home: home, dryRun: false, resume: false });
    assert.ok(again.results.every(result => result.status === "already-imported"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("resume uses T3's native expansion of configured provider home environment values", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-home-env-"));
  try {
    await initializeNativeTarget(home);
    const input: NativeConversation = { ...conversation(), source: "claude", driver: "claudeAgent", sourceHome: join(homedir(), ".claude-native-env-fixture") };
    writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", environment: [{ name: "CLAUDE_CONFIG_DIR", value: "~/.claude-native-env-fixture", sensitive: false }] } } }));
    const result = await importNativeConversations([input], { t3Home: home, dryRun: true, resume: true });
    assert.equal(result.results[0]!.resumable, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("OMP profile overrides cannot approve a resume binding to an unverified agent home", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-omp-profiles-"));
  try {
    await initializeNativeTarget(home);
    const sourceHome = join(home, "source-agent");
    const input: NativeConversation = { ...conversation(), source: "omp", driver: "pi", sourceHome, nativeSessionRef: join(sourceHome, "session.jsonl") };
    for (const override of [
      { environment: [{ name: "OMP_PROFILE", value: "review-profile", sensitive: false }], launchArgs: "" },
      { environment: [{ name: "PI_PROFILE", value: "review-profile", sensitive: false }], launchArgs: "" },
      { environment: [], launchArgs: "--profile review-profile" },
      { environment: [], launchArgs: "--profile=review-profile" },
    ]) {
      writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { omp: { driver: "pi", enabled: true, config: { enabled: true, binaryPath: "omp", launchArgs: override.launchArgs }, environment: [{ name: "PI_CODING_AGENT_DIR", value: sourceHome, sensitive: false }, ...override.environment] } } }));
      await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: true, resume: true, providerInstance: "omp" }), /profile.*no-resume/i);
      const history = await importNativeConversations([input], { t3Home: home, dryRun: true, resume: false, providerInstance: "omp" });
      assert.equal(history.results[0]!.resumable, false);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("OMP continuation rejects directory overrides whose native resolution is unverified", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-omp-directories-"));
  try {
    await initializeNativeTarget(home);
    for (const override of [
      { sourceHome: join(homedir(), ".omp", "agent"), environment: [{ name: "PI_CONFIG_DIR", value: ".omp-review", sensitive: false }] },
      { sourceHome: join(homedir(), ".omp-review-agent"), environment: [{ name: "PI_CODING_AGENT_DIR", value: "~/.omp-review-agent", sensitive: false }] },
    ]) {
      // Inherited process values are not shell-expanded by OMP's path.resolve.
      const prior = process.env.PI_CODING_AGENT_DIR;
      if (override.environment[0]!.name === "PI_CODING_AGENT_DIR") process.env.PI_CODING_AGENT_DIR = override.environment[0]!.value;
      else delete process.env.PI_CODING_AGENT_DIR;
      try {
        const input: NativeConversation = { ...conversation(), source: "omp", driver: "pi", sourceHome: override.sourceHome, nativeSessionRef: join(override.sourceHome, "session.jsonl") };
        const environment = override.environment.filter(variable => variable.name !== "PI_CODING_AGENT_DIR");
        writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { omp: { driver: "pi", enabled: true, config: { enabled: true, binaryPath: "omp" }, environment } } }));
        await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: true, resume: true, providerInstance: "omp" }), /directory.*no-resume/i);
        assert.equal((await importNativeConversations([input], { t3Home: home, dryRun: true, resume: false, providerInstance: "omp" })).results[0]!.resumable, false);
      } finally {
        if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prior;
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("OMP continuation requires the native RPC compatibility bridge instead of approving a hanging T3 run", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-omp-rpc-"));
  try {
    await initializeNativeTarget(home);
    const sourceHome = join(home, "source-agent");
    const input: NativeConversation = { ...conversation(), source: "omp", driver: "pi", sourceHome, nativeSessionRef: join(sourceHome, "session.jsonl") };
    const settings = (binaryPath: string) => writeFileSync(join(home, "userdata/settings.json"), JSON.stringify({ providerInstances: { omp: { driver: "pi", enabled: true, config: { binaryPath }, environment: [{ name: "PI_CODING_AGENT_DIR", value: sourceHome, sensitive: false }] } } }));
    settings("omp");
    await assert.rejects(importNativeConversations([input], { t3Home: home, dryRun: true, resume: true, providerInstance: "omp" }), /t3-import-omp/);
    settings("t3-import-omp");
    assert.equal((await importNativeConversations([input], { t3Home: home, dryRun: true, resume: true, providerInstance: "omp" })).results[0]!.resumable, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
