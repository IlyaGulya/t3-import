import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { parsePatch } from "diff";
import { createCodexReader, mapCodexItem, type CodexHistoryRpc } from "./codex.js";

const at = 1_767_225_600;
const workspace = resolve(".");
const meta = (overrides = {}) => ({
  id: "session-1",
  sessionId: "session-1",
  name: "Native fixture",
  preview: "question",
  cwd: workspace,
  createdAt: at,
  updatedAt: at + 20,
  cliVersion: "test",
  model: "gpt-test",
  modelProvider: "openai",
  source: "cli",
  ephemeral: false,
  projectId: null,
  historyMode: "paginated",
  status: { type: "idle" },
  turns: [],
  ...overrides,
});
const user = (id = "user-1", text = "question") => ({
  id,
  type: "userMessage",
  content: [{ type: "text", text }],
});
const answer = (id = "answer-1", text = "answer") => ({
  id,
  type: "agentMessage",
  text,
  phase: "final_answer",
});
const turn = (id = "turn-1", overrides = {}) => ({
  id,
  status: "completed",
  startedAt: at,
  completedAt: at + 10,
  itemsView: "full",
  items: [user(), answer()],
  ...overrides,
});
const unavailable = () =>
  Object.assign(new Error("Method not found"), { code: -32601, operation: "receive-response" });

function fixture(
  handler: (method: string, params: Record<string, unknown>) => unknown,
  listsSessions = false,
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let closes = 0;
  const rpc: CodexHistoryRpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/list" && !listsSessions)
        return { data: [], nextCursor: null } as never;
      return handler(method, params) as never;
    },
    close: async () => {
      closes++;
    },
  };
  return {
    reader: createCodexReader({ connect: async () => rpc }),
    calls,
    get closes() {
      return closes;
    },
  };
}

test("paginates native lists, turns and item pages; preserves steer, phase, full tool output and item timing", async () => {
  const fixtures = fixture((method, params) => {
    if (method === "thread/list")
      return params.cursor === null
        ? { data: [meta(), meta({ id: "old", updatedAt: at - 100 })], nextCursor: "threads-2" }
        : {
            data: [meta({ id: "another", cwd: "/another/workspace" }), meta({ id: "session-2" })],
            nextCursor: null,
          };
    if (method === "thread/read") return { thread: meta() };
    if (method === "thread/turns/list")
      return params.cursor === null
        ? { data: [turn()], nextCursor: "turns-2" }
        : { data: [turn("turn-2", { items: [], status: "interrupted" })], nextCursor: null };
    if (params.turnId === "turn-2") return { data: [], nextCursor: null };
    return params.cursor === null
      ? {
          data: [
            { turnId: "turn-1", item: user(), startedAtMs: at * 1000 },
            { turnId: "turn-1", item: user("steer-1", "follow-up during the same turn") },
          ],
          nextCursor: "items-2",
        }
      : {
          data: [
            {
              turnId: "turn-1",
              completedAtMs: at * 1000 + 2000,
              item: {
                id: "command-1",
                type: "commandExecution",
                command: "printf output",
                cwd: workspace,
                commandActions: [],
                aggregatedOutput: "entire output\nnot a summary",
                exitCode: 2,
                status: "completed",
              },
            },
            { turnId: "turn-1", item: answer() },
          ],
          nextCursor: null,
        };
  }, true);
  try {
    const list = await fixtures.reader.list({
      workspace,
      since: new Date(at * 1000).toISOString(),
      archived: true,
    });
    assert.deepEqual(
      list.map((entry) => entry.id),
      ["session-1", "session-2"],
    );
    assert.equal(fixtures.calls[0]!.params.archived, true);
    const conversation = await fixtures.reader.read("session-1", { workspace });
    assert.equal(conversation.active, false);
    assert.equal(conversation.turns.length, 2);
    assert.equal(conversation.turns[1]!.status, "interrupted");
    const items = conversation.turns[0]!.items;
    assert.deepEqual(
      items.map((item) => item.kind),
      ["user_message", "user_message", "command_execution", "assistant_message"],
    );
    assert.equal(items[2]!.timestamp, "2026-01-01T00:00:02.000Z");
    assert.equal(items[2]!.data.output, "entire output\nnot a summary");
    assert.equal(items[2]!.status, "failed");
    assert.equal(items[3]!.data.phase, "final_answer");
    assert.equal(
      fixtures.calls.find((call) => call.method === "thread/turns/list")!.params.itemsView,
      "full",
    );
    assert.equal(
      fixtures.calls.some((call) => /resume|turn\/start/.test(call.method)),
      false,
    );
  } finally {
    await fixtures.reader.close();
  }
  assert.equal(fixtures.closes, 1);
  await fixtures.reader.close();
  assert.equal(fixtures.closes, 1);
});

test("native file history keeps single-file patches and raw add/delete contents unchanged and renders complete multi-file patches", async () => {
  const update = "@@ -1 +1 @@\n-before\n+after\n";
  const add = "# actual document heading\n+literal plus\n";
  const remove = "removed document\n";
  const rename = "--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-before\n+after\n";
  const changes = [
    {
      id: "update",
      changes: [{ path: "existing.ts", diff: update, kind: { type: "update", move_path: null } }],
    },
    { id: "add", changes: [{ path: "document.md", diff: add, kind: { type: "add" } }] },
    { id: "delete", changes: [{ path: "removed.txt", diff: remove, kind: { type: "delete" } }] },
    {
      id: "rename",
      changes: [{ path: "old.ts", diff: rename, kind: { type: "update", move_path: "new.ts" } }],
    },
    {
      id: "multi",
      changes: [
        { path: "fresh.txt", diff: "fresh\n", kind: { type: "add" } },
        { path: "existing.ts", diff: update, kind: { type: "update", move_path: null } },
        { path: "removed.txt", diff: remove, kind: { type: "delete" } },
        { path: "old.ts", diff: update, kind: { type: "update", move_path: "new.ts" } },
      ],
    },
  ];
  const f = fixture((method) => {
    if (method === "thread/read") return { thread: meta() };
    if (method === "thread/turns/list") return { data: [turn()], nextCursor: null };
    return {
      data: changes.map((change) => ({
        turnId: "turn-1",
        item: { type: "fileChange", status: "completed", ...change },
      })),
      nextCursor: null,
    };
  });
  try {
    const result = await f.reader.read("session-1", {});
    const items = result.turns[0]!.items;
    assert.deepEqual(
      items.slice(0, 4).map((item) => item.data.diffStr),
      [update, add, remove, rename],
    );
    assert.deepEqual(items[3]!.data.changes, [
      { operation: "update", path: "new.ts", oldPath: "old.ts" },
    ]);
    const combined = String(items[4]!.data.diffStr);
    const patches = parsePatch(combined);
    assert.deepEqual(
      patches.map((patch) => [patch.oldFileName, patch.newFileName]),
      [
        ["/dev/null", "fresh.txt"],
        ["existing.ts", "existing.ts"],
        ["removed.txt", "/dev/null"],
        ["old.ts", "new.ts"],
      ],
    );
    assert.deepEqual(
      patches.map((patch) =>
        patch.hunks.flatMap((hunk) =>
          hunk.lines.filter((line) => line[0] === "+" || line[0] === "-"),
        ),
      ),
      [["+fresh"], ["-before", "+after"], ["-removed document"], ["-before", "+after"]],
    );
    assert.deepEqual(items[4]!.data.nativeContent, {
      type: "fileChange",
      status: "completed",
      ...changes[4],
    });
  } finally {
    await f.reader.close();
  }
});

test("native item intervals preserve each supplied endpoint without inventing missing timing", async () => {
  const command = {
    id: "timed-command",
    type: "commandExecution",
    command: "fixture",
    cwd: workspace,
    commandActions: [],
    aggregatedOutput: "done",
    exitCode: 0,
    status: "completed",
  };
  const f = fixture((method) => {
    if (method === "thread/read") return { thread: meta() };
    if (method === "thread/turns/list") return { data: [turn()], nextCursor: null };
    return {
      data: [
        { turnId: "turn-1", item: user(), startedAtMs: at * 1000 },
        {
          turnId: "turn-1",
          item: command,
          startedAtMs: at * 1000 + 3005,
          completedAtMs: at * 1000 + 9873,
        },
        { turnId: "turn-1", item: { ...command, id: "end-only" }, completedAtMs: at * 1000 + 9900 },
        { turnId: "turn-1", item: answer() },
      ],
      nextCursor: null,
    };
  });
  try {
    const result = await f.reader.read("session-1", {});
    const items = result.turns[0]!.items;
    assert.equal(items[0]!.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(items[0]!.completedAt, undefined);
    assert.equal(items[1]!.startedAt, "2026-01-01T00:00:03.005Z");
    assert.equal(items[1]!.completedAt, "2026-01-01T00:00:09.873Z");
    assert.equal(items[1]!.timestamp, "2026-01-01T00:00:09.873Z");
    assert.equal(items[2]!.startedAt, undefined);
    assert.equal(items[2]!.completedAt, "2026-01-01T00:00:09.900Z");
    assert.equal(items[3]!.startedAt, undefined);
    assert.equal(items[3]!.completedAt, undefined);
  } finally {
    await f.reader.close();
  }
});

test("native record accounting includes generic and metadata-only records and preserves small timing/error metadata", async () => {
  const error = {
    message: "Native provider failure",
    additionalDetails: "Native diagnostic details",
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
  };
  const unknownInput = {
    id: "future-user",
    type: "userMessage",
    content: [{ type: "futureInput", opaque: { preserved: true } }],
  };
  const opaque = { id: "future-item", type: "futureActivity", payload: { kept: true } };
  const f = fixture((method) => {
    if (method === "thread/read") return { thread: meta() };
    if (method === "thread/turns/list")
      return {
        data: [turn("turn-1", { status: "failed", durationMs: 10012, error })],
        nextCursor: null,
      };
    return {
      data: [
        { turnId: "turn-1", item: user() },
        {
          turnId: "turn-1",
          item: {
            id: "command",
            type: "commandExecution",
            command: "fixture",
            cwd: workspace,
            commandActions: [],
            aggregatedOutput: "output",
            exitCode: 0,
            status: "completed",
            durationMs: 546,
          },
        },
        {
          turnId: "turn-1",
          item: {
            id: "mcp",
            type: "mcpToolCall",
            server: "fixture",
            tool: "read",
            arguments: {},
            result: { content: [] },
            status: "completed",
            durationMs: 0,
          },
        },
        { turnId: "turn-1", item: opaque },
        { turnId: "turn-1", item: unknownInput },
        { turnId: "turn-1", item: answer() },
      ],
      nextCursor: null,
    };
  });
  try {
    const result = await f.reader.read("session-1", {});
    assert.deepEqual(result.sourceCoverage, {
      schemaVersion: 1,
      selectedRecords: 6,
      mappedRecords: 5,
      metadataOnlyRecords: 1,
      missingRecordIds: [],
      nativeKinds: {
        userMessage: 2,
        commandExecution: 1,
        mcpToolCall: 1,
        futureActivity: 1,
        agentMessage: 1,
      },
    });
    const items = result.turns[0]!.items;
    assert.equal(items.length, 7, "a synthetic error notice does not inflate native record counts");
    assert.deepEqual(items.find((item) => item.id === "future-item")!.data.output, opaque);
    assert.deepEqual(
      items.find((item) => item.id === "future-user")!.data.nativeContent,
      unknownInput,
    );
    assert.match(result.warnings.join(" "), /futureInput.*native metadata/);
    assert.deepEqual(result.nativeMetadata, [
      { type: "codex.item_timing", turnId: "turn-1", nativeId: "command", durationMs: 546 },
      { type: "codex.item_timing", turnId: "turn-1", nativeId: "mcp", durationMs: 0 },
      { type: "codex.turn_metadata", nativeId: "turn-1", durationMs: 10012, error },
    ]);
    assert.match(result.warnings.join(" "), /historical token usage.*unavailable/);
    assert.equal(items.find((item) => item.id === "command")!.startedAt, undefined);
    assert.equal(items.find((item) => item.id === "command")!.completedAt, undefined);
  } finally {
    await f.reader.close();
  }
});

test("falls back only to the native legacy API when methods are unavailable", async () => {
  const fixtures = fixture((method, params) => {
    if (method === "thread/turns/list" || method === "thread/items/list") throw unavailable();
    return { thread: meta({ historyMode: "legacy", turns: params.includeTurns ? [turn()] : [] }) };
  });
  try {
    const result = await fixtures.reader.read("session-1", {});
    assert.equal(result.turns[0]!.items.length, 2);
    assert.equal(
      fixtures.calls.filter(
        (call) => call.method === "thread/read" && call.params.includeTurns === true,
      ).length,
      1,
    );
  } finally {
    await fixtures.reader.close();
  }
});

test("does not hide native decoder or permission failures behind a legacy fallback", async () => {
  for (const failure of [
    Object.assign(new Error("permission denied"), { code: -32000 }),
    Object.assign(new Error("decode failed"), { _tag: "CodexAppServerProtocolParseError" }),
  ]) {
    const fixtures = fixture((method) => {
      if (method === "thread/read") return { thread: meta() };
      throw failure;
    });
    try {
      await assert.rejects(fixtures.reader.read("session-1", {}), failure);
      assert.equal(
        fixtures.calls.some((call) => call.params.includeTurns === true),
        false,
      );
    } finally {
      await fixtures.reader.close();
    }
  }
});

test("rejects pagination loops, partial hydration and unavailable native paginated stores", async () => {
  const looping = fixture((method) =>
    method === "thread/read" ? { thread: meta() } : { data: [], nextCursor: "same" },
  );
  try {
    await assert.rejects(looping.reader.read("session-1", {}), /repeated a pagination cursor/);
  } finally {
    await looping.reader.close();
  }
  const partial = fixture((method) => {
    if (method === "thread/read") return { thread: meta() };
    if (method === "thread/turns/list")
      return { data: [turn("turn-1", { itemsView: "summary" })], nextCursor: null };
    throw unavailable();
  });
  try {
    await assert.rejects(partial.reader.read("session-1", {}), /only summary items/);
  } finally {
    await partial.reader.close();
  }
  const missing = fixture((method) =>
    method === "thread/read" ? { thread: meta() } : { data: [], nextCursor: null },
  );
  try {
    await assert.rejects(
      missing.reader.read("session-1", {}),
      /returned no turns for a nonempty session/,
    );
  } finally {
    await missing.reader.close();
  }
});

test("marks active and changing sessions instead of presenting a settled snapshot", async () => {
  for (const activeTurn of [true, false]) {
    let reads = 0;
    const fixtures = fixture((method) => {
      if (method === "thread/read")
        return { thread: meta({ updatedAt: at + 20 + (activeTurn ? 0 : reads++) }) };
      if (method === "thread/turns/list")
        return {
          data: [turn("turn-1", { status: activeTurn ? "inProgress" : "failed" })],
          nextCursor: null,
        };
      return { data: [{ turnId: "turn-1", item: user() }], nextCursor: null };
    });
    try {
      const result = await fixtures.reader.read("session-1", {});
      assert.equal(result.active, true);
      assert.match(result.warnings.join(" "), /changed during reading/);
    } finally {
      await fixtures.reader.close();
    }
  }
});

test("maps native multimodal, reasoning, file changes, plans and compaction without activity thinning", () => {
  const warnings = new Set<string>();
  const atIso = "2026-01-01T00:00:00.000Z";
  const map = (item: unknown) => mapCodexItem(item as never, atIso, "completed", warnings);
  const images = map({
    id: "media",
    type: "userMessage",
    content: [
      { type: "text", text: "look" },
      { type: "image", url: "data:image/png;base64,YQ==" },
      { type: "localImage", path: "/tmp/image.webp" },
      { type: "image", fileId: "file-1" },
      { type: "audio", url: "https://example.com/audio" },
    ],
  });
  assert.equal(images.images!.length, 2);
  assert.equal(images.images![0]!.base64, "YQ==");
  assert.equal(images.images![1]!.mimeType, "image/webp");
  assert.match(String(images.data.text), /file-1/);
  assert.equal(
    map({ id: "reason", type: "reasoning", summary: ["summary"], content: ["visible reasoning"] })
      .data.text,
    "summary\n\nvisible reasoning",
  );
  const files = map({
    id: "patch",
    type: "fileChange",
    status: "completed",
    changes: [
      { path: "a.ts", diff: "+first", kind: { type: "add" } },
      {
        path: "b.ts",
        diff: "@@ -1 +1 @@\n-second\n+replacement\n",
        kind: { type: "update", move_path: null },
      },
    ],
  });
  assert.match(String(files.data.diffStr), /\+first/);
  assert.match(String(files.data.diffStr), /-second/);
  assert.equal((files.data.changes as unknown[]).length, 2);
  const renamed = map({
    id: "rename",
    type: "fileChange",
    status: "completed",
    changes: [{ path: "old.ts", diff: "patch", kind: { type: "update", move_path: "new.ts" } }],
  });
  assert.deepEqual(renamed.data.changes, [
    { operation: "update", path: "new.ts", oldPath: "old.ts" },
  ]);
  assert.equal(renamed.title, "new.ts");
  const question = map({
    id: "async-question",
    type: "agentMessage",
    text: "",
    delivery: "async",
    questions: [
      { title: "Which package manager?", options: ["pnpm", "npm"] },
      { title: "Project name?" },
    ],
  });
  assert.equal(question.data.text, "Which package manager?\n- pnpm\n- npm\n\nProject name?");
  assert.equal(map({ id: "plan", type: "plan", text: "# Plan" }).kind, "proposed_plan");
  assert.equal(map({ id: "compact", type: "contextCompaction" }).kind, "compaction");
  const tool = map({
    id: "mcp",
    type: "mcpToolCall",
    server: "srv",
    tool: "tool",
    arguments: { x: 1 },
    status: "failed",
    error: { message: "failure" },
  });
  assert.equal(tool.data.toolName, "srv.tool");
  assert.equal(tool.status, "failed");
  assert(warnings.size >= 2);
});

test(
  "uses the real T3 client for an executable fake peer and disposes its child process",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-native-codex-peer-"));
    const peer = resolve("native/codex-peer.mjs");
    await chmod(peer, 0o755);
    const reader = createCodexReader();
    try {
      const result = await reader.read("session-1", { binary: peer, sourceHome: root, workspace });
      assert.equal(result.turns[0]!.items[0]!.data.text, "question");
      assert.equal(result.turns[0]!.items[1]!.data.text, "answer");
      const requests = (await readFile(join(root, "requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        requests.filter((request) => request.id !== undefined).map((request) => request.method),
        [
          "initialize",
          "thread/read",
          "thread/list",
          "thread/turns/list",
          "thread/items/list",
          "thread/read",
        ],
      );
    } finally {
      await reader.close();
      await rm(root, { recursive: true, force: true });
    }
    await assert.rejects(reader.read("session-1", {}), /closed/);
  },
);

test(
  "recognizes a real T3 client's method-not-found failure for a native legacy history fallback",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-native-codex-legacy-peer-"));
    const peer = resolve("native/codex-peer.mjs");
    await chmod(peer, 0o755);
    await writeFile(join(root, "legacy"), "");
    const reader = createCodexReader();
    try {
      const result = await reader.read("session-1", { binary: peer, sourceHome: root, workspace });
      assert.equal(result.turns[0]!.items.length, 2);
      assert.equal(result.active, false);
    } finally {
      await reader.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Codex history includes complete native child and grandchild sessions with stable lineage", async () => {
  const spawn = (id: string, sender: string, receiver: string) => ({
    id,
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    senderThreadId: sender,
    receiverThreadIds: [receiver],
    agentsStates: { [receiver]: { status: "completed", message: null } },
    status: "completed",
    prompt: "Synthetic child assignment",
    model: "gpt-child",
    reasoningEffort: "medium",
  });
  const nativeItems: Record<string, unknown[]> = {
    root: [user("root-user"), spawn("spawn-child", "root", "child"), answer("root-answer")],
    child: [
      user("child-user"),
      spawn("spawn-grandchild", "child", "grandchild"),
      answer("child-answer", "Complete child history"),
    ],
    grandchild: [
      user("grandchild-user"),
      answer("grandchild-answer", "Complete grandchild history"),
    ],
  };
  const fixtures = fixture((method, params) => {
    const id = String(params.threadId);
    if (method === "thread/read")
      return {
        thread: meta({
          id,
          parentThreadId: id === "root" ? null : id === "child" ? "root" : "child",
          model: id === "root" ? "gpt-parent" : "gpt-child",
        }),
      };
    if (method === "thread/turns/list")
      return { data: [turn(`${id}-turn`, { items: nativeItems[id] })], nextCursor: null };
    if (method === "thread/items/list")
      return {
        data: nativeItems[id]!.map((item) => ({ turnId: `${id}-turn`, item })),
        nextCursor: null,
      };
    return { data: [], nextCursor: null };
  });
  try {
    const root = await fixtures.reader.read("root", {});
    assert.equal(root.children?.length, 1);
    const child = root.children![0]!;
    assert.equal(child.id, "child");
    assert.equal(child.nativeSessionRef, "child");
    assert.deepEqual(child.parent, { sourceId: "root", nativeItemId: "spawn-child" });
    assert.match(JSON.stringify(child.turns), /Complete child history/);
    const grandchild = child.children![0]!;
    assert.equal(grandchild.id, "grandchild");
    assert.deepEqual(grandchild.parent, { sourceId: "child", nativeItemId: "spawn-grandchild" });
    assert.match(JSON.stringify(grandchild.turns), /Complete grandchild history/);
    const spawnItem = root.turns[0]!.items.find((item) => item.id === "spawn-child")!;
    assert.equal(
      spawnItem.data.input &&
        typeof spawnItem.data.input === "object" &&
        !Array.isArray(spawnItem.data.input)
        ? spawnItem.data.input.model
        : undefined,
      "gpt-child",
    );
  } finally {
    await fixtures.reader.close();
  }
});

test("Codex history reports unavailable per-turn model provenance instead of assigning the current model to past responses", async () => {
  const f = fixture((method) =>
    method === "thread/read"
      ? { thread: meta({ model: "current-model" }) }
      : method === "thread/turns/list"
        ? { data: [turn()], nextCursor: null }
        : { data: [{ turnId: "turn-1", item: answer() }], nextCursor: null },
  );
  try {
    const result = await f.reader.read("session-1", {});
    assert.equal(result.model, "current-model");
    assert.equal(result.turns[0]!.model, undefined);
    assert.match(result.warnings.join(" "), /historical per-turn model provenance is unavailable/);
  } finally {
    await f.reader.close();
  }
});

test("Codex child history keeps its native workspace when the parent is imported with a project filter", async () => {
  const f = fixture((method, params) => {
    const child = params.threadId === "child-worktree";
    if (method === "thread/read")
      return {
        thread: meta({
          id: child ? "child-worktree" : "root",
          cwd: child ? resolve(workspace, "../native-child-worktree") : workspace,
          parentThreadId: child ? "root" : null,
        }),
      };
    const items = child
      ? [user(), answer()]
      : [
          user(),
          {
            id: "spawn",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            senderThreadId: "root",
            receiverThreadIds: ["child-worktree"],
            agentsStates: {},
            status: "completed",
            prompt: "Synthetic worktree task",
          },
          answer(),
        ];
    if (method === "thread/turns/list")
      return { data: [turn(child ? "child-turn" : "root-turn", { items })], nextCursor: null };
    return {
      data: items.map((item) => ({ turnId: child ? "child-turn" : "root-turn", item })),
      nextCursor: null,
    };
  });
  try {
    const root = await f.reader.read("root", { workspace });
    assert.equal(root.children![0]!.workspace, resolve(workspace, "../native-child-worktree"));
  } finally {
    await f.reader.close();
  }
});

test("Codex child histories expose their native nickname and spawning request when item history omits the input", async () => {
  const f = fixture((method, params) => {
    const child = params.threadId === "child-context";
    if (method === "thread/read")
      return {
        thread: meta({
          id: child ? "child-context" : "root",
          name: child ? null : "Root",
          preview: child ? "" : "Root request",
          agentNickname: child ? "Gauss" : null,
          parentThreadId: child ? "root" : null,
        }),
      };
    const items = child
      ? [answer()]
      : [
          user(),
          {
            id: "spawn",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            senderThreadId: "root",
            receiverThreadIds: ["child-context"],
            agentsStates: {},
            status: "completed",
            prompt: "Review the transport API and report findings",
          },
          answer(),
        ];
    if (method === "thread/turns/list")
      return { data: [turn(child ? "child-turn" : "root-turn", { items })], nextCursor: null };
    return {
      data: items.map((item) => ({ turnId: child ? "child-turn" : "root-turn", item })),
      nextCursor: null,
    };
  });
  try {
    const child = (await f.reader.read("root", {})).children![0]!;
    assert.equal(child.title, "Gauss");
    assert.equal(child.turns[0]!.items[0]!.kind, "user_message");
    assert.equal(
      child.turns[0]!.items[0]!.data.text,
      "Review the transport API and report findings",
    );
  } finally {
    await f.reader.close();
  }
});
