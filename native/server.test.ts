import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeNativeTarget, importNativeConversations } from "./target.ts";
import { startIsolatedT3Server } from "./server.ts";
import type { NativeConversation } from "../src/native/types.js";

test("a real T3 server reads every page of a large imported history with models, steers and tool results", { timeout: 90_000, skip: !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3", "bin", "t3")) }, async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-real-server-"));
  let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
  try {
    await initializeNativeTarget(home, 96);
    writeFileSync(join(home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { codex: { driver: "codex", enabled: false }, claudeAgent: { driver: "claudeAgent", enabled: false }, pi: { driver: "pi", enabled: false } } }));
    const time = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
    const source: NativeConversation = {
      source: "codex", driver: "codex", id: "server-large-fixture", nativeSessionRef: "server-large-fixture",
      title: "Large imported native history", workspace: home, model: "configured-model", active: false, warnings: [],
      createdAt: time(0), updatedAt: time(1000),
      turns: Array.from({ length: 250 }, (_, n) => ({
        id: `turn-${n}`, model: n % 2 ? "actual-model-b" : "actual-model-a", status: "completed", startedAt: time(n * 4), completedAt: time(n * 4 + 3),
        items: [
          { id: `user-${n}`, kind: "user_message", timestamp: time(n * 4), status: "completed", data: { text: `Question ${n}` } },
          { id: `tool-${n}`, kind: "command_execution", timestamp: time(n * 4 + 1), status: "completed", data: { input: `echo ${n}`, output: `tool-result-${n}`, exitCode: 0 } },
          { id: `steer-${n}`, kind: "user_message", timestamp: time(n * 4 + 2), status: "completed", data: { text: `Steer ${n}` } },
          { id: `answer-${n}`, kind: "assistant_message", model: n % 2 ? "actual-model-b" : "actual-model-a", timestamp: time(n * 4 + 3), status: "completed", data: { text: `Answer ${n}`, phase: "final_answer" } },
        ],
      })),
    };
    source.children = [{ ...source, id: "server-native-child", nativeSessionRef: "server-native-child", title: "Imported child history", parent: { sourceId: source.id, nativeItemId: "tool-0" }, resumeSupported: false, turns: [structuredClone(source.turns[0]!)] }];
    const imported = await importNativeConversations([source], { t3Home: home, dryRun: false, resume: false });
    server = await startIsolatedT3Server({ t3Home: home });
    const pairing = new URL(await server.pairingUrl());
    assert.equal(pairing.origin, server.origin);
    assert.equal(pairing.pathname, "/pair");
    assert.ok(pairing.hash.startsWith("#token="), "native pairing supplies browser access to the isolated home");
    type Item = { id: string; type: string; inputIntent?: string; output?: string; text?: string };
    type ProjectedItem = { item: Item };
    type Projection = { runs: Array<{ status: string; modelSelection: { model: string } }>; providerTurns: Array<{ model?: string }>; runtimeRequests: unknown[]; messages: unknown[]; turnItems: Item[]; subagents: Array<{ childThreadId: string | null }>; thread: { createdBy: string; creationSource: string; lineage: { parentThreadId: string | null } }; nodes: Array<{ status: string }>; visibleTurnItems: ProjectedItem[] };
    const full = await server.request<{ projection: Projection }>(`/api/orchestration/threads/${encodeURIComponent(imported.results[0]!.threadId)}`);
    assert.equal(full.projection.runs.length, 250);
    assert.equal(full.projection.messages.length, 750);
    assert.equal(full.projection.turnItems.length, 1001);
    const childResult = imported.results.find(result => result.sourceId === "server-native-child")!;
    assert.ok(full.projection.subagents.some(subagent => subagent.childThreadId === childResult.threadId));
    const child = await server.request<{ projection: Projection }>(`/api/orchestration/threads/${encodeURIComponent(childResult.threadId)}`);
    assert.equal(child.projection.thread.lineage.parentThreadId, imported.results[0]!.threadId);
    assert.equal(child.projection.messages.length, 3);
    const childBounded = await server.request<{ projection: Projection }>(`/api/orchestration/threads/${encodeURIComponent(childResult.threadId)}/bounded`);
    assert.equal(childBounded.projection.thread.createdBy, "system");
    assert.equal(childBounded.projection.thread.creationSource, "server", "the browser sees a historical child view");
    assert.equal(childBounded.projection.runs.length, 1);
    assert.ok(childBounded.projection.runs.every(run => run.status === "completed"));
    assert.equal(childBounded.projection.runtimeRequests.length, 0);
    assert.ok(childBounded.projection.nodes.every(node => !["pending", "running", "waiting"].includes(node.status)));
    assert.equal(full.projection.runtimeRequests.length, 0);
    assert.ok(full.projection.runs.every(run => run.status === "completed"));
    assert.deepEqual(full.projection.runs.slice(0, 2).map(run => run.modelSelection.model), ["actual-model-a", "actual-model-b"]);
    assert.deepEqual(full.projection.providerTurns.slice(0, 2).map(turn => turn.model), ["actual-model-a", "actual-model-b"]);
    const path = `/api/orchestration/threads/${encodeURIComponent(imported.results[0]!.threadId)}`;
    const bounded = await server.request<{ projection: Projection; historyCursor: string | null; hasMoreHistory: boolean }>(`${path}/bounded`);
    assert.equal(bounded.hasMoreHistory, true, "the fixture must exceed the server's initial history window");
    const items = new Map(bounded.projection.visibleTurnItems.map(row => [row.item.id, row.item]));
    let cursor = bounded.historyCursor;
    let pages = 0;
    while (cursor) {
      const page = await server.request<{ items: ProjectedItem[]; nextCursor: string | null; hasMoreHistory: boolean }>(`${path}/history?cursor=${encodeURIComponent(cursor)}&view=activity`);
      for (const row of page.items) items.set(row.item.id, row.item);
      assert.notEqual(page.nextCursor, cursor, "server pagination must advance");
      cursor = page.nextCursor;
      assert.ok(++pages < 100, "history pagination must terminate");
    }
    assert.ok(pages > 0);
    assert.equal(items.size, 1001);
    assert.equal([...items.values()].filter(item => item.type === "user_message" && item.inputIntent === "steer").length, 250);
    const firstTool = full.projection.turnItems.find(item => item.type === "command_execution")!;
    const toolDetail = await server.getTurnItem(imported.results[0]!.threadId, firstTool.id);
    assert.equal(toolDetail.item?.type, "command_execution");
    assert.equal(toolDetail.item?.type === "command_execution" && toolDetail.item.output, "tool-result-0");
    assert.ok([...items.values()].some(item => item.type === "assistant_message" && item.text === "Answer 249"));
  } finally {
    await server?.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("native children without a surviving launch item stay outside unrelated parent runs", { timeout: 90_000, skip: !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")) }, async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-orphan-lineage-"));
  let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
  try {
    await initializeNativeTarget(home, 96);
    writeFileSync(join(home, "userdata/settings.json"), JSON.stringify({ providerInstances: { codex: { driver: "codex", enabled: false } } }));
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString();
    const source: NativeConversation = {
      source: "codex", driver: "codex", id: "orphan-parent", nativeSessionRef: "orphan-parent", title: "Historical parent", workspace: home, active: false, warnings: [], createdAt: at(0), updatedAt: at(259205),
      turns: [0, 20].map((offset, index) => ({ id: `turn-${index}`, status: "completed", startedAt: at(offset), completedAt: at(offset + 10), items: [
        { id: `user-${index}`, kind: "user_message", timestamp: at(offset), status: "completed", data: { text: "Request" } },
        { id: `tool-${index}`, kind: "command_execution", timestamp: at(offset + 1), status: "completed", data: { input: "echo done", output: "done" } },
        { id: `answer-${index}`, kind: "assistant_message", timestamp: at(offset + 10), status: "completed", data: { text: "Answer", phase: "final_answer" } },
      ] })),
    };
    source.children = [undefined, "launch-in-an-unselected-native-branch"].map((nativeItemId, index) => ({ ...source, id: `orphan-child-${index}`, nativeSessionRef: `orphan-child-${index}`, parent: { sourceId: source.id, ...(nativeItemId ? { nativeItemId } : {}) }, resumeSupported: false, createdAt: at(259200), turns: [{ ...structuredClone(source.turns[0]!), startedAt: at(259200), completedAt: at(259205), items: [
      { id: `child-user-${index}`, kind: "user_message", timestamp: at(259200), status: "completed", data: { text: "Child request" } },
      { id: `child-answer-${index}`, kind: "assistant_message", timestamp: at(259205), status: "completed", data: { text: "Child answer" } },
    ] }] }));
    const imported = await importNativeConversations([source], { t3Home: home, dryRun: false, resume: false });
    server = await startIsolatedT3Server({ t3Home: home });
    const { projection } = await server.request<{ projection: { runs: unknown[]; subagents: Array<{ runId: string | null; childThreadId: string | null }>; turnItems: Array<{ type: string; runId: string | null; providerTurnId: string | null }>; runtimeRequests: unknown[] } }>(`/api/orchestration/threads/${encodeURIComponent(imported.results[0]!.threadId)}`);
    assert.equal(projection.runs.length, 2, "missing native launches do not invent a parent turn");
    assert.equal(projection.subagents.length, 2);
    assert.ok(projection.subagents.every(child => child.runId === null && child.childThreadId !== null), "thread lineage remains known while run ownership remains unknown");
    assert.ok(projection.turnItems.filter(item => item.type === "subagent").every(item => item.runId === null && item.providerTurnId === null), "late child activity cannot extend an unrelated parent's work fold");
    assert.equal(projection.runtimeRequests.length, 0);
    assert.equal((await importNativeConversations([source], { t3Home: home, dryRun: true, resume: false })).results.every(result => result.status === "already-imported"), true);
  } finally { await server?.stop(); rmSync(home, { recursive: true, force: true }); }
});
