import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { initializeNativeTarget } from "./target.ts";
import { startIsolatedT3Server } from "./server.ts";

const sessionId = "91a30000-1111-4111-8111-111111111111";
const timestamp = "2026-01-01T00:00:00.000Z";
function fixture() {
  // The SDK resolves workspace paths through native realpath, including Windows short names.
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "t3-native-claude-")));
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const directory = join(home, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(directory, { recursive: true });
  const record = (id: string, parentUuid: string | null, type: string, message: unknown) => ({
    uuid: id,
    parentUuid,
    type,
    message,
    sessionId,
    cwd: workspace,
    timestamp,
    isSidechain: false,
    version: "2.1.321",
    userType: "external",
  });
  const entries = [
    record("u", null, "user", { role: "user", content: "Native Claude question" }),
    record("abandoned", "u", "assistant", {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Abandoned response" }],
      stop_reason: "end_turn",
    }),
    record("selected", "u", "assistant", {
      role: "assistant",
      model: "claude-opus-4-6",
      content: [{ type: "text", text: "Selected Claude response" }],
      stop_reason: "end_turn",
    }),
  ];
  writeFileSync(
    join(directory, `${sessionId}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  return {
    home,
    workspace,
    directory,
    record,
    write: (values: unknown[]) =>
      writeFileSync(
        join(directory, `${sessionId}.jsonl`),
        values.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      ),
  };
}
function cli(...args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"), ...args],
    { encoding: "utf8", timeout: 30_000 },
  );
}

test("Claude recovers a missing workspace from a selected native history record", () => {
  const f = fixture();
  try {
    f.write([
      {
        ...f.record("title", null, "custom-title", undefined),
        cwd: undefined,
        customTitle: "Workspace fallback fixture",
      },
      {
        ...f.record("first", null, "user", {
          role: "user",
          content: "Original request ".repeat(5000),
        }),
        cwd: undefined,
      },
      f.record("recorded", "first", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Recorded workspace" }],
      }),
      {
        ...f.record("last-user", "recorded", "user", {
          role: "user",
          content: "More text ".repeat(20_000),
        }),
        cwd: undefined,
      },
      {
        ...f.record("last-answer", "last-user", "assistant", {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Final reply".repeat(20_000) }],
        }),
        cwd: undefined,
      },
    ]);
    const shown = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(shown.status, 0, shown.stdout + shown.stderr);
    const result = JSON.parse(shown.stdout);
    assert.equal(result.workspace, f.workspace);
    assert.match(result.warnings.join(" "), /workspace.*selected native history/i);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude history is readable through the CLI using its native selected conversation", () => {
  const f = fixture();
  try {
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--workspace",
      f.workspace,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.driver, "claudeAgent");
    assert.deepEqual(
      conversation.turns.flatMap((turn: { items: Array<{ data: { text?: string } }> }) =>
        turn.items.map((item) => item.data.text),
      ),
      ["Native Claude question", "Selected Claude response"],
    );
    assert.equal(conversation.active, false);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude local-command-only history keeps metadata without creating a T3 run", async () => {
  const f = fixture();
  const target = mkdtempSync(join(tmpdir(), "t3-claude-metadata-only-"));
  try {
    f.write([
      f.record("command", null, "user", {
        role: "user",
        content: "<command-name>/usage</command-name><command-args></command-args>",
      }),
      f.record("output", "command", "user", {
        role: "user",
        content: "<local-command-stdout>Status dialog dismissed</local-command-stdout>",
      }),
    ]);
    await initializeNativeTarget(target, 96);
    const result = cli(
      "import",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--workspace",
      f.workspace,
      "--thread",
      sessionId,
      "--t3-home",
      target,
      "--no-resume",
      "--yes",
      "--json",
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const thread = JSON.parse(result.stdout).results[0];
    assert.equal(thread.historyMetadataOnly, "no-visible-turns");
    const metadata = cli("metadata", "--t3-home", target, "--thread", thread.threadId, "--json");
    assert.equal(metadata.status, 0, metadata.stdout + metadata.stderr);
    assert.ok(
      JSON.parse(metadata.stdout).records.some(
        (row: { type: string }) => row.type === "local_command_record",
      ),
    );
    const server = await startIsolatedT3Server({ t3Home: target });
    try {
      const { projection } = await server.request<{
        projection: { runs: unknown[]; messages: unknown[] };
      }>(`/api/orchestration/threads/${encodeURIComponent(thread.threadId)}`);
      assert.deepEqual(projection.runs, []);
      assert.deepEqual(projection.messages, []);
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(f.home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("Claude preserves child transcripts with cyclic native parent metadata", async () => {
  const f = fixture();
  const target = mkdtempSync(join(tmpdir(), "t3-claude-cyclic-agents-"));
  try {
    const subagents = join(f.directory, sessionId, "subagents");
    mkdirSync(subagents, { recursive: true });
    for (const [id, parent] of [
      ["a1111111111111111", "a2222222222222222"],
      ["a2222222222222222", "a1111111111111111"],
    ] as const) {
      const entries = [
        f.record("u", null, "user", { role: "user", content: "Child question" }),
        f.record("a", "u", "assistant", {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Child answer" }],
        }),
      ];
      writeFileSync(
        join(subagents, `agent-${id}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      writeFileSync(
        join(subagents, `agent-${id}.meta.json`),
        JSON.stringify({ parentAgentId: parent }),
      );
    }
    await initializeNativeTarget(target, 96);
    const result = cli(
      "import",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--workspace",
      f.workspace,
      "--thread",
      sessionId,
      "--t3-home",
      target,
      "--no-resume",
      "--yes",
      "--json",
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [root, ...children] = JSON.parse(result.stdout).results;
    assert.equal(children.length, 2);
    const server = await startIsolatedT3Server({ t3Home: target });
    try {
      for (const [index, child] of children.entries()) {
        const { projection } = await server.request<{
          projection: {
            thread: { lineage: { parentThreadId: string } };
            messages: { text: string }[];
          };
        }>(`/api/orchestration/threads/${encodeURIComponent(child.threadId)}`);
        assert.equal(projection.thread.lineage.parentThreadId, root.threadId);
        assert.deepEqual(
          projection.messages.map((message) => message.text),
          ["Child question", "Child answer"],
        );
        const metadata = cli("metadata", "--t3-home", target, "--thread", child.threadId, "--json");
        assert.equal(metadata.status, 0, metadata.stdout + metadata.stderr);
        assert.ok(
          JSON.parse(metadata.stdout).records.some(
            (entry: { type: string; nativeParent?: { sourceId: string } }) =>
              entry.type === "claude_unresolved_parent" &&
              entry.nativeParent?.sourceId === children[1 - index].sourceId,
          ),
        );
      }
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(f.home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("Claude full CLI output preserves long Unicode messages across a native child family", () => {
  const f = fixture();
  const text = "Привет 🌍 — записанная история\n".repeat(24_000);
  try {
    f.write([
      f.record("long-user", null, "user", { role: "user", content: text }),
      f.record("long-answer", "long-user", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
      }),
    ]);
    const directory = join(f.directory, sessionId, "subagents");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "agent-a123456789abcdef0.jsonl");
    writeFileSync(
      path,
      [
        f.record("long-child-user", null, "user", { role: "user", content: text }),
        f.record("long-child-answer", "long-child-user", "assistant", {
          role: "assistant",
          model: "claude-haiku-4-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text }],
        }),
      ]
        .map((entry) => JSON.stringify({ ...entry, isSidechain: true }))
        .join("\n") + "\n",
    );
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    let compact: unknown;
    for (const json of [true, false]) {
      const result = spawnSync(
        process.execPath,
        [
          resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"),
          "show",
          "--source",
          "claude",
          "--source-home",
          f.home,
          "--thread",
          sessionId,
          "--full",
          ...(json ? ["--json"] : []),
        ],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
      );
      assert.equal(result.status, 0, result.stderr + result.stdout.slice(0, 1000));
      const shown = JSON.parse(result.stdout);
      assert.equal(shown.children.length, 1);
      for (const conversation of [shown, shown.children[0]]) {
        const messages = conversation.turns.flatMap(
          (turn: { items: { data: { text?: string } }[] }) => turn.items,
        );
        assert.equal(messages.length, 2);
        assert.ok(messages.every((item: { data: { text?: string } }) => item.data.text === text));
        assert.deepEqual(conversation.sourceCoverage.missingRecordIds, []);
      }
      if (json) compact = shown;
      else assert.deepEqual(shown, compact);
    }
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), digest);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude tool loops retain thinking, complete tool results and same-turn user steering", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "First request" }),
      f.record("tool", "u", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "Visible reasoning" },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "printf fixture" } },
        ],
      }),
      f.record("result", "tool", "user", {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content: "Entire command output\nSecond line",
            is_error: false,
          },
        ],
      }),
      f.record("steer", "result", "user", { role: "user", content: "Same-turn steering" }),
      f.record("done", "steer", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Finished" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.turns.length, 1);
    const items = conversation.turns[0].items;
    assert.deepEqual(
      items
        .filter((item: { kind: string }) => item.kind === "user_message")
        .map((item: { data: { text: string } }) => item.data.text),
      ["First request", "Same-turn steering"],
    );
    assert.equal(
      items.find((item: { kind: string }) => item.kind === "reasoning").data.text,
      "Visible reasoning",
    );
    assert.equal(
      items.find((item: { kind: string }) => item.kind === "command_execution").data.output,
      "Entire command output\nSecond line",
    );
    assert.equal(
      items.find((item: { kind: string }) => item.kind === "command_execution").status,
      "completed",
    );
    assert.equal(items[1].model, "claude-sonnet-4-6");
    assert.equal(items.at(-1).model, "claude-opus-4-6");
    assert.equal(conversation.turns[0].model, "claude-sonnet-4-6");
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude preserves timestamps returned by the native history API", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Question" }),
      {
        ...f.record("a", "u", "assistant", {
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Answer" }],
        }),
        timestamp: "2026-01-01T00:03:00.000Z",
      },
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.turns[0].items.at(-1).timestamp, "2026-01-01T00:03:00.000Z");
    assert.equal(conversation.turns[0].completedAt, "2026-01-01T00:03:00.000Z");
    assert.doesNotMatch(conversation.warnings.join(" "), /does not expose per-record timestamps/);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude native compaction summaries remain history markers instead of new user turns", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Question before compaction" }),
      f.record("a", "u", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Previous answer" }],
      }),
      {
        ...f.record("compact", "a", "user", { role: "user", content: "Native compact summary" }),
        isCompactSummary: true,
      },
      f.record("b", "compact", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Continued answer" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.turns.length, 1);
    assert.equal(
      conversation.turns[0].items.find((item: { kind: string }) => item.kind === "compaction").data
        .summary,
      "Native compact summary",
    );
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude native system metadata produces one compaction card without duration or opaque placeholder bubbles", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Request" }),
      {
        ...f.record("abandoned-system", "u", "system", undefined),
        subtype: "turn_duration",
        durationMs: 9999,
        timestamp: "2025-12-31T23:59:00.000Z",
      },
      f.record("a", "u", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Answer" }],
      }),
      {
        ...f.record("duration", "a", "system", undefined),
        subtype: "turn_duration",
        durationMs: 1234,
      },
      {
        ...f.record("boundary", "duration", "system", undefined),
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 12345 },
        content: "Context compacted",
      },
      {
        ...f.record("summary", "boundary", "user", {
          role: "user",
          content: "Native retained summary",
        }),
        isCompactSummary: true,
      },
      {
        ...f.record("opaque", "summary", "system", undefined),
        subtype: "future_record",
        opaque: { preserved: true },
      },
      f.record("b", "opaque", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Continued" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    const items = conversation.turns.flatMap((turn: { items: unknown[] }) => turn.items);
    assert.equal(items.filter((item: { kind: string }) => item.kind === "system_notice").length, 0);
    const compactions = items.filter((item: { kind: string }) => item.kind === "compaction");
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].data.beforeTokenCount, 12345);
    assert.equal(compactions[0].data.summary, "Native retained summary");
    const systems = conversation.nativeMetadata.filter(
      (entry: { type: string }) => entry.type === "system",
    );
    assert.deepEqual(
      systems.map((entry: { uuid: string }) => entry.uuid),
      ["duration", "boundary", "opaque"],
    );
    assert.equal(systems[0].durationMs, 1234);
    assert.deepEqual(systems[2].opaque, { preserved: true });
    assert.match(conversation.warnings.join(" "), /future_record.*metadata/i);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test(
  "Claude edit, plan and research history uses native T3 cards through CLI import and a separate server",
  {
    skip: !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
    timeout: 90_000,
  },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-native-cards-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const tools = [
        {
          name: "Edit",
          input: { file_path: "/workspace/example.ts", old_string: "old", new_string: "new" },
          output: "File updated",
          structured: {
            filePath: "/workspace/example.ts",
            structuredPatch: [
              { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
            ],
          },
        },
        {
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Inspect history", status: "completed" },
              { content: "Import it", status: "in_progress" },
            ],
          },
          output: "Todos saved",
        },
        {
          name: "WebSearch",
          input: { query: "native session history" },
          output: "Search completed",
          structured: {
            query: "native session history",
            durationSeconds: 1,
            results: [
              { content: [{ title: "SDK documentation", url: "https://example.com/sdk" }] },
            ],
          },
        },
        {
          name: "WebFetch",
          input: { url: "https://example.com/sdk", prompt: "Read" },
          output: "Native SDK supports history",
        },
        { name: "Read", input: { file_path: "/workspace/example.ts" }, output: "new" },
        { name: "Grep", input: { pattern: "native", path: "/workspace" }, output: "example.ts" },
        {
          name: "mcp__example_tools__lookup_docs",
          input: { query: "sessions" },
          output: "Complete MCP output",
        },
      ];
      const entries: unknown[] = [
        f.record("u", null, "user", { role: "user", content: "Edit and research" }),
      ];
      let parent = "u";
      for (const [index, tool] of tools.entries()) {
        const id = `call-${index}`,
          result = `result-${index}`;
        entries.push(
          f.record(id, parent, "assistant", {
            role: "assistant",
            model: "claude-opus-4-6",
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id, name: tool.name, input: tool.input }],
          }),
        );
        entries.push({
          ...f.record(result, id, "user", {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: tool.output }],
          }),
          ...(tool.structured ? { toolUseResult: tool.structured } : {}),
        });
        parent = result;
      }
      entries.push(
        f.record("done", parent, "assistant", {
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done" }],
        }),
      );
      f.write(entries);
      await initializeNativeTarget(target, 96);
      writeFileSync(
        join(target, "userdata/settings.json"),
        JSON.stringify({
          providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: false } },
        }),
      );
      const args = [
        "import",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--thread",
        sessionId,
        "--t3-home",
        target,
        "--no-resume",
        "--yes",
        "--json",
      ];
      const imported = cli(...args);
      assert.equal(imported.status, 0, imported.stderr || imported.stdout);
      const threadId = JSON.parse(imported.stdout).results[0].threadId;
      server = await startIsolatedT3Server({ t3Home: target });
      const { projection: p } = await server.request<{
        projection: {
          turnItems: Array<{
            id: string;
            type: string;
            nativeItemRef: { nativeId: string };
            [key: string]: unknown;
          }>;
          plans: Array<{ kind: string }>;
          runtimeRequests: unknown[];
        };
      }>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
      const cards = await Promise.all(
        p.turnItems
          .filter((item) => item.nativeItemRef?.nativeId.startsWith("call-"))
          .map(async (item) => (await server!.getTurnItem(threadId, item.id)).item!),
      );
      assert.deepEqual(
        cards.map((item) => item.type),
        [
          "file_change",
          "todo_list",
          "web_search",
          "web_search",
          "dynamic_tool",
          "dynamic_tool",
          "dynamic_tool",
        ],
      );
      assert.equal(cards[0]!.type === "file_change" && cards[0]!.fileName, "/workspace/example.ts");
      assert.ok(
        cards[0]!.type === "file_change" &&
          cards[0]!.diffStr?.startsWith("--- /workspace/example.ts\n+++ /workspace/example.ts\n"),
        "file patches use the native T3 adapter's file-only headers",
      );
      assert.match(
        String(cards[0]!.type === "file_change" && cards[0]!.diffStr),
        /@@ -1,1 \+1,1 @@[\s\S]*-old[\s\S]*\+new/,
      );
      assert.deepEqual(cards[1]!.type === "todo_list" && cards[1]!.steps, [
        { id: "todo-0", text: "Inspect history", status: "completed" },
        { id: "todo-1", text: "Import it", status: "running" },
      ]);
      assert.ok(p.plans.some((plan) => plan.kind === "todo_list"));
      assert.deepEqual(cards[2]!.type === "web_search" && cards[2]!.patterns, [
        "native session history",
      ]);
      assert.deepEqual(cards[2]!.type === "web_search" && cards[2]!.results, [
        { title: "SDK documentation", url: "https://example.com/sdk" },
      ]);
      assert.deepEqual(cards[3]!.type === "web_search" && cards[3]!.results, [
        { url: "https://example.com/sdk", snippet: "Native SDK supports history" },
      ]);
      assert.equal(cards[4]!.title, "Read /workspace/example.ts");
      assert.equal(cards[5]!.title, "Searched native in workspace");
      assert.equal(cards[6]!.title, "lookup docs");
      assert.deepEqual(cards[6]!.type === "dynamic_tool" && cards[6]!.toolSource, {
        key: "mcp:example_tools",
        name: "example tools",
        kind: "integration",
      });
      assert.deepEqual(
        cards[6]!.type === "dynamic_tool" && cards[6]!.output,
        "Complete MCP output",
      );
      assert.equal(p.runtimeRequests.length, 0);
      await server.stop();
      server = undefined;
      const repeated = cli(...args);
      assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).status, "already-imported");
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test("imported opaque Claude metadata remains inspectable through the CLI without a visible placeholder", async () => {
  const f = fixture(),
    target = mkdtempSync(join(tmpdir(), "t3-claude-metadata-"));
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Request" }),
      {
        ...f.record("meta", "u", "system", undefined),
        subtype: "future_record",
        payload: { preserved: [1, true, "opaque"] },
      },
      f.record("a", "meta", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Answer" }],
      }),
    ]);
    await initializeNativeTarget(target, 96);
    const imported = cli(
      "import",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--workspace",
      f.workspace,
      "--thread",
      sessionId,
      "--t3-home",
      target,
      "--no-resume",
      "--yes",
      "--json",
    );
    assert.equal(imported.status, 0, imported.stdout + imported.stderr);
    const threadId = JSON.parse(imported.stdout).results[0].threadId;
    const metadata = cli("metadata", "--thread", threadId, "--t3-home", target, "--json");
    assert.equal(metadata.status, 0, metadata.stdout + metadata.stderr);
    const records = JSON.parse(metadata.stdout).records.filter(
      (entry: { type: string }) => entry.type === "system",
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].subtype, "future_record");
    assert.deepEqual(records[0].payload, { preserved: [1, true, "opaque"] });
    assert.equal(JSON.parse(imported.stdout).results[0].items, 2);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test(
  "idle Claude compaction and real notices do not extend the preceding response duration in T3",
  {
    skip: !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
    timeout: 90_000,
  },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-idle-metadata-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      f.write([
        f.record("u", null, "user", { role: "user", content: "Request" }),
        {
          ...f.record("a", "u", "assistant", {
            role: "assistant",
            model: "claude-opus-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Answer" }],
          }),
          timestamp: "2026-01-01T00:01:00.000Z",
        },
        {
          ...f.record("boundary", "a", "system", undefined),
          subtype: "compact_boundary",
          compactMetadata: { trigger: "auto", preTokens: 12345 },
          timestamp: "2026-01-03T00:00:00.000Z",
        },
        {
          ...f.record("summary", "boundary", "user", { role: "user", content: "Retained summary" }),
          isCompactSummary: true,
          timestamp: "2026-01-03T00:00:01.000Z",
        },
        {
          ...f.record("notice", "summary", "system", undefined),
          subtype: "local_command",
          content: "Actual native notification",
          timestamp: "2026-01-03T00:00:02.000Z",
        },
        {
          ...f.record("later-user", "notice", "user", { role: "user", content: "Next request" }),
          timestamp: "2026-01-03T00:01:00.000Z",
        },
        {
          ...f.record("later-answer", "later-user", "assistant", {
            role: "assistant",
            model: "claude-opus-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Next answer" }],
          }),
          timestamp: "2026-01-03T00:02:00.000Z",
        },
      ]);
      await initializeNativeTarget(target, 96);
      writeFileSync(
        join(target, "userdata/settings.json"),
        JSON.stringify({
          providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: false } },
        }),
      );
      const imported = cli(
        "import",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--thread",
        sessionId,
        "--t3-home",
        target,
        "--no-resume",
        "--yes",
        "--json",
      );
      assert.equal(imported.status, 0, imported.stdout + imported.stderr);
      const threadId = JSON.parse(imported.stdout).results[0].threadId;
      server = await startIsolatedT3Server({ t3Home: target });
      const { projection: p } = await server.request<{
        projection: {
          runs: Array<{ completedAt: string }>;
          turnItems: Array<{
            type: string;
            message?: string;
            runId: string | null;
            nodeId: string | null;
          }>;
        };
      }>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
      assert.equal(p.runs.length, 2);
      assert.equal(p.runs[0]!.completedAt, "2026-01-01T00:01:00.000Z");
      const compaction = p.turnItems.find((item) => item.type === "compaction")!;
      assert.equal(compaction.runId, null);
      assert.equal(compaction.nodeId, null);
      const notice = p.turnItems.find((item) => item.type === "system_notice")!;
      assert.equal(notice.message, "Actual native notification");
      assert.equal(notice.runId, null);
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test("Claude imports native child and grandchild histories with their spawning tool links", () => {
  const f = fixture();
  const childId = "a1111111111111111",
    grandchildId = "a2222222222222222";
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Root question" }),
      f.record("spawn", "u", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_child",
            name: "Agent",
            input: { description: "Historical child" },
          },
        ],
      }),
      f.record("done", "spawn", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Root answer" }],
      }),
    ]);
    const subagents = join(f.directory, sessionId, "subagents");
    mkdirSync(subagents, { recursive: true });
    const writeAgent = (
      id: string,
      parent: string | null,
      toolUseId: string,
      entries: unknown[],
    ) => {
      writeFileSync(
        join(subagents, `agent-${id}.jsonl`),
        entries.map((value) => JSON.stringify(value)).join("\n") + "\n",
      );
      writeFileSync(
        join(subagents, `agent-${id}.meta.json`),
        JSON.stringify({ toolUseId, parentAgentId: parent, agentType: "general-purpose" }),
      );
    };
    writeAgent(childId, null, "toolu_child", [
      f.record("cu", null, "user", { role: "user", content: "Child question" }),
      f.record("cs", "cu", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_grandchild",
            name: "Agent",
            input: { description: "Historical grandchild" },
          },
        ],
      }),
      f.record("ca", "cs", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Child answer" }],
      }),
    ]);
    writeAgent(grandchildId, childId, "toolu_grandchild", [
      f.record("gu", null, "user", { role: "user", content: "Grandchild question" }),
      f.record("ga", "gu", "assistant", {
        role: "assistant",
        model: "claude-haiku-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Grandchild answer" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const root = JSON.parse(result.stdout);
    assert.equal(root.children.length, 1);
    const child = root.children[0],
      grandchild = child.children[0];
    assert.equal(child.parent.sourceId, sessionId);
    assert.equal(child.parent.nativeItemId, "toolu_child");
    assert.equal(grandchild.parent.sourceId, child.id);
    assert.equal(grandchild.parent.nativeItemId, "toolu_grandchild");
    assert.equal(grandchild.turns[0].items.at(-1).data.text, "Grandchild answer");
    assert.equal(child.resumeSupported, false);
    assert.equal(grandchild.model, "claude-haiku-4-5");
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude subagent file changes retain structured native results without selecting an abandoned branch", () => {
  const f = fixture(),
    agentId = "a3333333333333333";
  try {
    const subagents = join(f.directory, sessionId, "subagents");
    mkdirSync(subagents, { recursive: true });
    const records = [
      f.record("cu", null, "user", { role: "user", content: "Edit file" }),
      f.record("abandoned", "cu", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Abandoned child branch" }],
      }),
      f.record("ct", "cu", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "child-edit",
            name: "Edit",
            input: { file_path: "/workspace/child.ts", old_string: "before", new_string: "after" },
          },
        ],
      }),
      {
        ...f.record("cr", "ct", "user", {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "child-edit", content: "Updated" }],
        }),
        toolUseResult: {
          filePath: "/workspace/child.ts",
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-before", "+after"] },
          ],
        },
      },
      f.record("ca", "cr", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Edited" }],
      }),
    ];
    writeFileSync(
      join(subagents, `agent-${agentId}.jsonl`),
      records.map((row) => JSON.stringify({ ...row, isSidechain: true })).join("\n") + "\n",
    );
    // Native discovery may list the same agent ID at multiple subpaths.
    // Its selected message UUIDs still identify only one native history.
    const nested = join(subagents, "nested");
    mkdirSync(nested);
    writeFileSync(
      join(nested, `agent-${agentId}.jsonl`),
      records
        .map((row) =>
          JSON.stringify({
            ...row,
            uuid: `other-${row.uuid}`,
            parentUuid: row.parentUuid ? `other-${row.parentUuid}` : null,
            isSidechain: true,
          }),
        )
        .join("\n") + "\n",
    );
    const shown = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(shown.status, 0, shown.stdout + shown.stderr);
    assert.equal(JSON.parse(shown.stdout).children.length, 1);
    const child = JSON.parse(shown.stdout).children[0];
    const items = child.turns.flatMap((turn: { items: unknown[] }) => turn.items);
    assert.ok(!JSON.stringify(items).includes("Abandoned child branch"));
    const edit = items.find((item: { kind: string }) => item.kind === "file_change");
    assert.match(String(edit.data.diffStr), /-before[\s\S]*\+after/);
    assert.equal(
      child.nativeMetadata.find((entry: { type: string }) => entry.type === "tool_result")
        .structured.filePath,
      "/workspace/child.ts",
    );
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test(
  "Claude subagent system chains preserve pre-compaction messages and native markers through CLI and T3",
  {
    skip: !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
    timeout: 90_000,
  },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-child-system-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const directory = join(f.directory, sessionId, "subagents");
      mkdirSync(directory, { recursive: true });
      const childWorkspace = join(f.home, "child-workspace");
      const agentId = "a4444444444444444",
        file = join(directory, `agent-${agentId}.jsonl`);
      const records = [
        f.record("cu1", null, "user", {
          role: "user",
          content: "Question before child compaction",
        }),
        {
          ...f.record("ca1", "cu1", "assistant", {
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Answer before child compaction" }],
          }),
          timestamp: "2026-01-01T00:01:00.000Z",
        },
        {
          ...f.record("dead-boundary", "cu1", "system", undefined),
          subtype: "compact_boundary",
          compactMetadata: { preTokens: 99999 },
        },
        f.record("dead-answer", "dead-boundary", "assistant", {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Abandoned child alternative" }],
        }),
        {
          ...f.record("cb", "ca1", "system", undefined),
          subtype: "compact_boundary",
          compactMetadata: { trigger: "auto", preTokens: 12345 },
          isMeta: true,
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          ...f.record("cs", "cb", "user", { role: "user", content: "Child context summary" }),
          isCompactSummary: true,
          isMeta: true,
          timestamp: "2026-01-02T00:00:01.000Z",
        },
        {
          ...f.record("cu2", "cs", "user", {
            role: "user",
            content: "Question after child compaction",
          }),
          timestamp: "2026-01-02T00:01:00.000Z",
        },
        {
          ...f.record("cd", "cu2", "system", undefined),
          subtype: "turn_duration",
          durationMs: 1000,
          timestamp: "2026-01-02T00:01:01.000Z",
        },
        {
          ...f.record("cn", "cd", "system", undefined),
          subtype: "local_command",
          content: "Real child notification",
          timestamp: "2026-01-02T00:01:02.000Z",
        },
        {
          ...f.record("ca2", "cn", "assistant", {
            role: "assistant",
            model: "claude-opus-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Answer after child compaction" }],
          }),
          timestamp: "2026-01-02T00:02:00.000Z",
        },
      ];
      writeFileSync(
        file,
        records
          .map((row) => JSON.stringify({ ...row, isSidechain: true, cwd: childWorkspace }))
          .join("\n") + "\n",
      );
      const before = createHash("sha256").update(readFileSync(file)).digest("hex");
      const shown = cli(
        "show",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--thread",
        sessionId,
        "--full",
        "--json",
      );
      assert.equal(shown.status, 0, shown.stdout + shown.stderr);
      const child = JSON.parse(shown.stdout).children[0];
      assert.equal(child.workspace, childWorkspace);
      const items = child.turns.flatMap((turn: { items: unknown[] }) => turn.items);
      assert.deepEqual(
        items
          .filter(
            (item: { kind: string }) =>
              item.kind === "user_message" || item.kind === "assistant_message",
          )
          .map((item: { data: { text: string } }) => item.data.text),
        [
          "Question before child compaction",
          "Answer before child compaction",
          "Question after child compaction",
          "Answer after child compaction",
        ],
      );
      assert.equal(items.filter((item: { kind: string }) => item.kind === "compaction").length, 1);
      assert.equal(
        items.find((item: { kind: string }) => item.kind === "compaction").data.summary,
        "Child context summary",
      );
      assert.equal(
        items.find((item: { kind: string }) => item.kind === "compaction").data.beforeTokenCount,
        12345,
      );
      assert.ok(
        items.some(
          (item: { kind: string; data: { message: string } }) =>
            item.kind === "system_notice" && item.data.message === "Real child notification",
        ),
      );
      assert.deepEqual(
        child.nativeMetadata
          .filter((entry: { type: string }) => entry.type === "system")
          .map((entry: { uuid: string }) => entry.uuid),
        ["cb", "cd", "cn"],
      );
      await initializeNativeTarget(target, 96);
      writeFileSync(
        join(target, "userdata/settings.json"),
        JSON.stringify({
          providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: false } },
        }),
      );
      const args = [
        "import",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--thread",
        sessionId,
        "--t3-home",
        target,
        "--project-root",
        f.workspace,
        "--no-resume",
        "--yes",
        "--json",
      ];
      const imported = cli(...args);
      assert.equal(imported.status, 0, imported.stdout + imported.stderr);
      const result = JSON.parse(imported.stdout).results.find((r: { sourceId: string }) =>
        r.sourceId.endsWith(`:agent:${agentId}`),
      );
      server = await startIsolatedT3Server({ t3Home: target });
      const { projection: p } = await server.request<{
        projection: {
          thread: { worktreePath: string | null };
          runs: Array<{ completedAt: string }>;
          providerTurns: Array<{ model: string }>;
          turnItems: Array<{
            type: string;
            runId: string | null;
            nativeItemRef: { nativeId: string };
          }>;
          runtimeRequests: unknown[];
        };
      }>(`/api/orchestration/threads/${encodeURIComponent(result.threadId)}`);
      assert.equal(p.thread.worktreePath, childWorkspace);
      assert.equal(p.runs.length, 2);
      assert.equal(p.runs[0]!.completedAt, "2026-01-01T00:01:00.000Z");
      assert.equal(p.turnItems.filter((item) => item.type === "compaction").length, 1);
      assert.equal(p.turnItems.find((item) => item.type === "compaction")!.runId, null);
      assert.ok(!p.turnItems.some((item) => item.nativeItemRef?.nativeId === "dead-boundary"));
      assert.deepEqual(
        p.providerTurns.map((turn) => turn.model),
        ["claude-sonnet-4-6", "claude-opus-4-6"],
      );
      assert.equal(p.runtimeRequests.length, 0);
      await server.stop();
      server = undefined;
      const repeated = cli(...args);
      assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).status, "already-imported");
      assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), before);
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test("Claude image-only user requests remain importable attachments", () => {
  const f = fixture();
  try {
    f.write([
      f.record("image", null, "user", {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCboAAAAASUVORK5CYII=",
            },
          },
        ],
      }),
      f.record("a", "image", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Image inspected" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const user = JSON.parse(result.stdout).turns[0].items[0];
    assert.equal(user.kind, "user_message");
    assert.equal(user.images[0].mimeType, "image/png");
    assert.equal(
      user.images[0].base64,
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCboAAAAASUVORK5CYII=",
    );
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude historical text replies without a stop reason do not masquerade as active tool work", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Historical request" }),
      f.record("a", "u", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: null,
        content: [{ type: "text", text: "Persisted historical reply" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.active, false);
    assert.equal(conversation.turns[0].status, "completed");
    assert.match(conversation.warnings.join(" "), /stop reason/);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude synthetic acknowledgements remain visible without inventing a model or failure", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Request" }),
      f.record("error", "u", "assistant", {
        role: "assistant",
        model: "<synthetic>",
        stop_reason: null,
        content: [{ type: "text", text: "No response requested." }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout),
      last = conversation.turns[0].items.at(-1);
    assert.equal(conversation.model, undefined);
    assert.equal(conversation.turns[0].status, "completed");
    assert.equal(last.kind, "system_notice");
    assert.equal(last.data.message, "No response requested.");
    assert.equal(last.model, undefined);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude native API errors and usage remain inspectable with source-record accounting", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Request" }),
      {
        ...f.record("error", "u", "assistant", {
          role: "assistant",
          model: "<synthetic>",
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
          content: [{ type: "text", text: "Native API error" }],
        }),
        isApiErrorMessage: true,
        error: "rate_limit",
      },
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const c = JSON.parse(result.stdout);
    assert.equal(c.turns[0].status, "failed");
    assert.equal(c.active, false);
    assert.equal(c.sourceCoverage.selectedRecords, 2);
    assert.equal(c.sourceCoverage.mappedRecords, 2);
    assert.deepEqual(c.sourceCoverage.missingRecordIds, []);
    const metadata = c.nativeMetadata.find(
      (entry: { type: string; uuid: string }) =>
        entry.type === "record_metadata" && entry.uuid === "error",
    );
    assert.equal(metadata.payload.isApiErrorMessage, true);
    assert.deepEqual(metadata.payload.message.usage, { input_tokens: 10, output_tokens: 0 });
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude system records before the first request do not create a fictitious extra turn", () => {
  const f = fixture();
  try {
    f.write([
      f.record("notice", null, "system", undefined),
      f.record("u", "notice", "user", { role: "user", content: "First request" }),
      f.record("a", "u", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "First answer" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.turns.length, 1);
    assert.deepEqual(
      conversation.turns[0].items.map((item: { kind: string }) => item.kind),
      ["user_message", "assistant_message"],
    );
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude list and incomplete-tool inspection leave the native source files unchanged", () => {
  const f = fixture();
  const snapshot = (path: string): unknown =>
    readdirSync(path, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => [
        entry.name,
        entry.isDirectory()
          ? snapshot(join(path, entry.name))
          : createHash("sha256")
              .update(readFileSync(join(path, entry.name)))
              .digest("hex"),
      ]);
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Request" }),
      f.record("pending", "u", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_pending",
            name: "Bash",
            input: { command: "not executed by the history reader" },
          },
        ],
      }),
    ]);
    const before = snapshot(f.home);
    const listed = cli("list", "--source", "claude", "--source-home", f.home, "--json");
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.equal(JSON.parse(listed.stdout).sessions[0].id, sessionId);
    const shown = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    const conversation = JSON.parse(shown.stdout);
    assert.equal(conversation.active, true);
    assert.equal(conversation.turns[0].items.at(-1).status, "interrupted");
    assert.deepEqual(snapshot(f.home), before);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude document input retains a visible reference and its complete native payload", () => {
  const f = fixture();
  try {
    const document = {
      type: "document",
      title: "specification.pdf",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
    };
    f.write([
      f.record("u", null, "user", { role: "user", content: [document] }),
      f.record("a", "u", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Document reviewed" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout),
      items = conversation.turns[0].items;
    assert.match(items[0].data.text, /specification\.pdf/);
    assert.deepEqual(
      items.find((item: { kind: string }) => item.kind === "dynamic_tool").data.output,
      document,
    );
    assert.match(conversation.warnings.join(" "), /document.*native payload/i);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude imports multiple unmatched tool results from the same native message", async () => {
  const f = fixture(),
    target = mkdtempSync(join(tmpdir(), "t3-claude-orphan-import-"));
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Historical request" }),
      f.record("r", "u", "user", {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "missing-1", content: "First retained result" },
          { type: "tool_result", tool_use_id: "missing-2", content: "Second retained result" },
        ],
      }),
      f.record("a", "r", "assistant", {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      }),
    ]);
    await initializeNativeTarget(target, 96);
    const imported = cli(
      "import",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--workspace",
      f.workspace,
      "--thread",
      sessionId,
      "--t3-home",
      target,
      "--no-resume",
      "--yes",
      "--json",
    );
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
    assert.equal(JSON.parse(imported.stdout).results[0].items, 4);
    const shown = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    const items = JSON.parse(shown.stdout).turns[0].items;
    assert.equal(new Set(items.map((item: { id: string }) => item.id)).size, 4);
    assert.deepEqual(
      items
        .filter((item: { kind: string }) => item.kind === "dynamic_tool")
        .map((item: { data: { output: { content: string } } }) => item.data.output.content),
      ["First retained result", "Second retained result"],
    );
  } finally {
    rmSync(f.home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test(
  "Claude snapshot imports incomplete native root and child histories as interrupted views through a real T3 server",
  {
    skip: !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
    timeout: 90_000,
  },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-snapshot-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    const digest = (path: string): unknown =>
      readdirSync(path, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => [
          entry.name,
          entry.isDirectory()
            ? digest(join(path, entry.name))
            : createHash("sha256")
                .update(readFileSync(join(path, entry.name)))
                .digest("hex"),
        ]);
    try {
      f.write([
        f.record("u", null, "user", { role: "user", content: "Earlier request" }),
        f.record("done", "u", "assistant", {
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Earlier answer" }],
        }),
        f.record("pending-user", "done", "user", {
          role: "user",
          content: "Unanswered historical request",
        }),
      ]);
      const agents = join(f.directory, sessionId, "subagents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(
        join(agents, "agent-incomplete-child.jsonl"),
        [
          {
            ...f.record("child-user", null, "user", { role: "user", content: "Child request" }),
            isSidechain: true,
          },
          {
            ...f.record("child-tool", "child-user", "assistant", {
              role: "assistant",
              model: "claude-haiku-4-5",
              stop_reason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "native-pending-call",
                  name: "Bash",
                  input: { command: "never executed by the importer" },
                },
              ],
            }),
            isSidechain: true,
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
      const before = digest(f.home);
      await initializeNativeTarget(target, 96);
      writeFileSync(
        join(target, "userdata/settings.json"),
        JSON.stringify({
          providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: false } },
        }),
      );
      const args = [
        "import",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--thread",
        sessionId,
        "--t3-home",
        target,
        "--no-resume",
        "--yes",
        "--json",
      ];
      const normal = cli(...args);
      assert.notEqual(normal.status, 0);
      assert.match(JSON.parse(normal.stdout).error, /active or indeterminate/);
      const snapshot = cli(...args, "--snapshot");
      assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
      const imported = JSON.parse(snapshot.stdout);
      assert.equal(imported.results.length, 2);
      assert.ok(
        imported.results.every(
          (result: { resumable: boolean; warnings: string[] }) =>
            !result.resumable && result.warnings.some((warning) => /snapshot/i.test(warning)),
        ),
      );
      server = await startIsolatedT3Server({ t3Home: target });
      for (const result of imported.results) {
        const {
          projection,
        }: {
          projection: {
            runs: Array<{ status: string }>;
            thread: { activeProviderThreadId: string | null };
            turnItems: Array<{
              status: string;
              type: string;
              nativeItemRef?: { nativeId: string };
              output?: unknown;
            }>;
            providerThreads: Array<{ nativeThreadRef: unknown }>;
            runtimeRequests: unknown[];
          };
        } = await server.request(
          `/api/orchestration/threads/${encodeURIComponent(result.threadId)}`,
        );
        assert.equal(projection.runs.at(-1)!.status, "interrupted");
        assert.equal(projection.runtimeRequests.length, 0);
        assert.ok(projection.providerThreads.every((thread) => thread.nativeThreadRef === null));
        if (result.sourceId === sessionId)
          assert.ok(
            projection.turnItems.some((item) => item.nativeItemRef?.nativeId === "pending-user"),
          );
        else {
          const call = projection.turnItems.find(
            (item) => item.nativeItemRef?.nativeId === "native-pending-call",
          )!;
          assert.ok(call);
          assert.equal(call.status, "interrupted");
          assert.equal(call.type, "command_execution");
          assert.equal(call.output, undefined, "an unfinished tool receives no fabricated result");
        }
      }
      await server.stop();
      server = undefined;
      const repeated = cli(...args, "--snapshot");
      assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).status, "already-imported");
      assert.deepEqual(digest(f.home), before);
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test("snapshot requires history-only mode and rejects Codex before launching a reader", () => {
  for (const args of [
    ["--source", "claude", "--snapshot"],
    ["--source", "codex", "--snapshot", "--no-resume"],
    ["--source", "omp", "--snapshot"],
  ]) {
    const result = cli(
      "import",
      ...args,
      "--workspace",
      "/unused",
      "--thread",
      "unused",
      "--binary",
      "never-launch-this-source",
      "--dry-run",
      "--json",
    );
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const error = JSON.parse(result.stdout).error;
    assert.match(error, /snapshot.*(no-resume|only.*Claude)/i);
    assert.doesNotMatch(error, /ENOENT|spawn|never-launch/);
  }
});

test(
  "Claude snapshot still rejects a native source that changes while its history is read",
  { timeout: 30_000 },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-snapshot-changing-"));
    let child: ReturnType<typeof spawn> | undefined;
    let changing: ReturnType<typeof setInterval> | undefined;
    try {
      f.write([
        f.record("u", null, "user", { role: "user", content: "Earlier request" }),
        f.record("done", "u", "assistant", {
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Large native text ".repeat(600_000) }],
        }),
        f.record("pending-user", "done", "user", { role: "user", content: "Unanswered request" }),
      ]);
      await initializeNativeTarget(target, 96);
      const file = join(f.directory, `${sessionId}.jsonl`),
        initialTime = Date.parse(timestamp);
      let tick = 0;
      child = spawn(
        process.execPath,
        [
          resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"),
          "import",
          "--source",
          "claude",
          "--source-home",
          f.home,
          "--workspace",
          f.workspace,
          "--thread",
          sessionId,
          "--t3-home",
          target,
          "--snapshot",
          "--no-resume",
          "--yes",
          "--json",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr!.on("data", (chunk) => {
        stderr += chunk;
      });
      changing = setInterval(() => {
        const time = new Date(initialTime + ++tick);
        utimesSync(file, time, time);
      }, 1);
      const status = await new Promise<number | null>((accept, reject) => {
        child!.once("error", reject);
        child!.once("close", accept);
      });
      clearInterval(changing);
      changing = undefined;
      assert.notEqual(status, 0, stderr);
      assert.match(JSON.parse(stdout).error, /active or indeterminate/);
      const projects = cli("projects", "--t3-home", target, "--json");
      assert.equal(projects.status, 0, projects.stdout + projects.stderr);
      assert.deepEqual(
        JSON.parse(projects.stdout).projects,
        [],
        "a changing snapshot writes no partial project",
      );
    } finally {
      if (changing) clearInterval(changing);
      if (child && child.exitCode === null) child.kill("SIGTERM");
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test(
  "Claude rejects child-only native changes without writing a partial imported family",
  { timeout: 60_000 },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-changing-child-"));
    let changing: ReturnType<typeof setInterval> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const directory = join(f.directory, sessionId, "subagents");
      mkdirSync(directory, { recursive: true });
      const file = join(directory, "agent-a123456789abcdef0.jsonl");
      writeFileSync(
        file,
        [
          f.record("changing-user", null, "user", { role: "user", content: "Read this child" }),
          f.record("changing-answer", "changing-user", "assistant", {
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Recorded child content ".repeat(250_000) }],
          }),
        ]
          .map((entry) => JSON.stringify({ ...entry, isSidechain: true }))
          .join("\n") + "\n",
      );
      const root = join(f.directory, `${sessionId}.jsonl`);
      const rootDigest = createHash("sha256").update(readFileSync(root)).digest("hex");
      await initializeNativeTarget(target, 96);
      child = spawn(
        process.execPath,
        [
          resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"),
          "import",
          "--source",
          "claude",
          "--source-home",
          f.home,
          "--workspace",
          f.workspace,
          "--thread",
          sessionId,
          "--t3-home",
          target,
          "--snapshot",
          "--no-resume",
          "--yes",
          "--json",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "",
        revision = 0;
      child.stdout!.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr!.on("data", (chunk) => {
        stderr += chunk;
      });
      // Integration clock: continuously changing a temporary native child spans both SDK reads.
      changing = setInterval(() => {
        appendFileSync(
          file,
          JSON.stringify({ type: "tag", tag: `revision-${++revision}`, timestamp }) + "\n",
        );
      }, 5);
      const status = await new Promise<number | null>((accept, reject) => {
        child!.once("error", reject);
        child!.once("close", accept);
      });
      clearInterval(changing);
      changing = undefined;
      assert.notEqual(status, 0, stderr + stdout.slice(0, 500));
      assert.match(JSON.parse(stdout).error, /active or indeterminate|changed while reading/);
      assert.equal(createHash("sha256").update(readFileSync(root)).digest("hex"), rootDigest);
      const projects = cli("projects", "--t3-home", target, "--json");
      assert.equal(projects.status, 0, projects.stderr);
      assert.deepEqual(JSON.parse(projects.stdout).projects, []);
    } finally {
      if (changing) clearInterval(changing);
      if (child && child.exitCode === null) child.kill("SIGTERM");
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test(
  "Claude cancelled synthetic text stays an interrupted assistant reply through CLI and real T3",
  { timeout: 60_000 },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-cancelled-reply-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      f.write([
        f.record("request", null, "user", { role: "user", content: "Ответь" }),
        f.record("partial", "request", "assistant", {
          role: "assistant",
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "Нет, не нужна. Даже п" }],
        }),
        f.record("abort", "partial", "user", {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        }),
        f.record("next-request", "abort", "user", { role: "user", content: "Продолжай" }),
        f.record("answer", "next-request", "assistant", {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Продолженный ответ" }],
        }),
      ]);
      await initializeNativeTarget(target, 96);
      const args = [
        "import",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--thread",
        sessionId,
        "--t3-home",
        target,
        "--no-resume",
        "--yes",
        "--json",
      ];
      const result = cli(...args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const imported = JSON.parse(result.stdout);
      server = await startIsolatedT3Server({ t3Home: target });
      const {
        projection: p,
      }: {
        projection: {
          runs: { status: string }[];
          messages: { role: string; text: string }[];
          turnItems: { type: string; status: string; text?: string }[];
        };
      } = await server.request(
        `/api/orchestration/threads/${encodeURIComponent(imported.results[0].threadId)}`,
      );
      assert.equal(p.runs.length, 2);
      assert.equal(p.runs[0]!.status, "interrupted");
      assert.equal(p.runs[1]!.status, "completed");
      assert.deepEqual(
        p.messages.filter((message) => message.role === "assistant").map((message) => message.text),
        ["Нет, не нужна. Даже п", "Продолженный ответ"],
      );
      assert.deepEqual(
        p.messages.filter((message) => message.role === "user").map((message) => message.text),
        ["Ответь", "Продолжай"],
      );
      assert.ok(
        p.turnItems.some(
          (item) =>
            item.type === "assistant_message" &&
            item.text === "Нет, не нужна. Даже п" &&
            item.status === "interrupted",
        ),
      );
      assert.ok(p.turnItems.some((item) => item.type === "run_interrupt_result"));
      assert.ok(!p.turnItems.some((item) => item.type === "system_notice"));
      await server.stop();
      server = undefined;
      assert.equal(JSON.parse(cli(...args).stdout).status, "already-imported");
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test(
  "Claude local compact commands do not create a model run or steering segments in T3",
  { timeout: 60_000 },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-local-command-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    const at = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
    const localOutput =
      "<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>";
    try {
      f.write([
        {
          ...f.record("compact", null, "user", {
            role: "user",
            content:
              "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
          }),
          timestamp: at(0),
        },
        {
          ...f.record("boundary", null, "system", undefined),
          subtype: "compact_boundary",
          content: "Conversation compacted",
          timestamp: at(1),
          compactMetadata: { trigger: "manual", preTokens: 1000 },
        },
        {
          ...f.record("summary", "boundary", "user", {
            role: "user",
            content: "Native context summary",
          }),
          isCompactSummary: true,
          timestamp: at(1),
        },
        {
          ...f.record("stdout", "summary", "user", { role: "user", content: localOutput }),
          timestamp: at(2),
        },
        {
          ...f.record("usage-system", "stdout", "system", undefined),
          subtype: "local_command",
          content:
            "<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>",
          timestamp: at(3),
        },
        {
          ...f.record("usage-output", "usage-system", "system", undefined),
          subtype: "local_command",
          content: "<local-command-stdout>Status dialog dismissed</local-command-stdout>",
          timestamp: at(4),
        },
        {
          ...f.record("away", "usage-output", "system", undefined),
          subtype: "away_summary",
          content: "Recap after returning",
          timestamp: at(5),
        },
        {
          ...f.record("warning", "away", "system", undefined),
          subtype: "informational",
          level: "warning",
          content: "Claude reported a warning",
          timestamp: at(6),
        },
        {
          ...f.record("request", "warning", "user", { role: "user", content: "Продолжим" }),
          timestamp: at(10),
        },
        {
          ...f.record("tools", "request", "assistant", {
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "Checking the file" },
              { type: "tool_use", id: "check", name: "Bash", input: { command: "echo recorded" } },
            ],
          }),
          timestamp: at(11),
        },
        {
          ...f.record("result", "tools", "user", {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "check", content: "Recorded output" }],
          }),
          timestamp: at(20),
        },
        {
          ...f.record("answer", "result", "assistant", {
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Done" }],
          }),
          timestamp: at(21),
        },
      ]);
      await initializeNativeTarget(target, 96);
      const result = cli(
        "import",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--thread",
        sessionId,
        "--t3-home",
        target,
        "--no-resume",
        "--yes",
        "--json",
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const threadId = JSON.parse(result.stdout).results[0].threadId;
      server = await startIsolatedT3Server({ t3Home: target });
      const {
        projection: p,
      }: {
        projection: {
          runs: { startedAt: string; completedAt: string }[];
          thread: { archivedAt: string | null; settledOverride: string | null };
          messages: { role: string; text: string }[];
          turnItems: {
            type: string;
            runId: string | null;
            inputIntent?: string;
            phase?: string;
            message?: string;
            level?: string;
          }[];
        };
      } = await server.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
      assert.equal(p.thread.archivedAt, null);
      assert.equal(
        p.thread.settledOverride,
        "settled",
        "inactive family roots belong on the Settled shelf",
      );
      assert.equal(p.runs.length, 1);
      assert.equal(p.runs[0]!.startedAt, at(10));
      assert.equal(p.runs[0]!.completedAt, at(21));
      assert.deepEqual(
        p.messages.filter((message) => message.role === "user").map((message) => message.text),
        ["Продолжим"],
      );
      assert.equal(
        p.turnItems.filter((item) => item.type === "user_message" && item.inputIntent === "steer")
          .length,
        0,
      );
      assert.equal(p.turnItems.find((item) => item.type === "compaction")!.runId, null);
      assert.deepEqual(
        p.turnItems
          .filter((item) => item.type === "system_notice")
          .map(({ message, level, runId }) => ({ message, level, runId })),
        [
          { message: "Recap after returning", level: "info", runId: null },
          { message: "Claude reported a warning", level: "warning", runId: null },
        ],
      );
      assert.equal(
        p.turnItems.filter(
          (item) => item.type === "assistant_message" && item.phase === "commentary",
        ).length,
        1,
      );
      const metadata = cli("metadata", "--t3-home", target, "--thread", threadId, "--json");
      assert.equal(metadata.status, 0, metadata.stderr);
      assert.match(metadata.stdout, /Status dialog dismissed/);
      assert.ok(
        metadata.stdout.includes("local-command-stdout") &&
          metadata.stdout.includes("Compacted (ctrl+o"),
      );
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test(
  "Claude restores native compaction epochs and attaches legacy subagents to the exact launch",
  { timeout: 60_000 },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-epochs-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    const agentId = "a123456789abcdef0";
    try {
      f.write([
        f.record("before-user", null, "user", { role: "user", content: "Before first compaction" }),
        f.record("launch", "before-user", "assistant", {
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "launch-1",
              name: "Agent",
              input: { description: "Legacy child" },
            },
          ],
        }),
        {
          ...f.record("launch-result", "launch", "user", {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "launch-1", content: "Child done" }],
          }),
          toolUseResult: { agentId },
        },
        f.record("before-answer", "launch-result", "assistant", {
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "First answer" }],
        }),
        f.record("abandoned", "before-user", "assistant", {
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Abandoned branch must stay absent" }],
        }),
        {
          ...f.record("boundary-one", null, "system", undefined),
          logicalParentUuid: "before-answer",
          subtype: "compact_boundary",
          content: "Conversation compacted",
          compactMetadata: { trigger: "auto", preTokens: 100 },
        },
        {
          ...f.record("summary-one", "boundary-one", "user", {
            role: "user",
            content: "First summary",
          }),
          isCompactSummary: true,
        },
        f.record("middle-user", "summary-one", "user", {
          role: "user",
          content: "Between compactions",
        }),
        f.record("middle-answer", "middle-user", "assistant", {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Middle answer" }],
        }),
        {
          ...f.record("boundary-two", null, "system", undefined),
          logicalParentUuid: "middle-answer",
          subtype: "compact_boundary",
          content: "Conversation compacted",
          compactMetadata: { trigger: "auto", preTokens: 100 },
        },
        {
          ...f.record("summary-two", "boundary-two", "user", {
            role: "user",
            content: "Second summary",
          }),
          isCompactSummary: true,
        },
        f.record("before-answer", "abandoned", "assistant", {
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Duplicate UUID on an abandoned branch" }],
        }),
        f.record("after-user", "summary-two", "user", {
          role: "user",
          content: "After both compactions",
        }),
        f.record("after-answer", "after-user", "assistant", {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Latest answer" }],
        }),
      ]);
      const directory = join(f.directory, sessionId, "subagents");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, `agent-${agentId}.jsonl`),
        [
          f.record("child-user", null, "user", { role: "user", content: "Child task" }),
          f.record("child-answer", "child-user", "assistant", {
            role: "assistant",
            model: "claude-haiku-4-5",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Child answer" }],
          }),
        ]
          .map((entry) => JSON.stringify({ ...entry, isSidechain: true }))
          .join("\n") + "\n",
      );
      await initializeNativeTarget(target, 96);
      const args = [
        "import",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--thread",
        sessionId,
        "--t3-home",
        target,
        "--no-resume",
        "--yes",
        "--json",
      ];
      const result = cli(...args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const imported = JSON.parse(result.stdout);
      server = await startIsolatedT3Server({ t3Home: target });
      const root = imported.results.find((row: { sourceId: string }) => row.sourceId === sessionId);
      const {
        projection: p,
      }: {
        projection: {
          runs: { id: string }[];
          messages: { role: string; text: string }[];
          subagents: { runId: string | null; nativeTaskRef: { nativeId: string } | null }[];
          turnItems: {
            type: string;
            ordinal: number;
            nativeItemRef: { nativeId: string } | null;
          }[];
        };
      } = await server.request(`/api/orchestration/threads/${encodeURIComponent(root.threadId)}`);
      assert.deepEqual(
        p.messages.filter((message) => message.role === "user").map((message) => message.text),
        ["Before first compaction", "Between compactions", "After both compactions"],
      );
      assert.ok(!p.messages.some((message) => message.text.includes("Abandoned branch")));
      assert.equal(p.runs.length, 3);
      assert.equal(p.subagents.length, 1);
      assert.equal(p.subagents[0]!.runId, p.runs[0]!.id);
      assert.equal(p.subagents[0]!.nativeTaskRef!.nativeId, "launch-1");
      const launchItem = p.turnItems.find(
        (item) => item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === "launch-1",
      )!;
      const childItem = p.turnItems.find((item) => item.type === "subagent")!;
      assert.equal(
        childItem.ordinal,
        launchItem.ordinal + 1,
        "the child card occupies the next native timeline position after its launch",
      );
      assert.equal(p.turnItems.filter((item) => item.type === "compaction").length, 2);
      await server.stop();
      server = undefined;
      assert.equal(JSON.parse(cli(...args).stdout).status, "already-imported");
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test(
  "Claude inherited context is a native history fork rather than duplicated subagent work",
  { timeout: 60_000 },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-inherited-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    const copied = [
      f.record("root-user", null, "user", { role: "user", content: "Original task" }),
      f.record("root-answer", "root-user", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Original answer" }],
      }),
      {
        ...f.record("idle-boundary", "root-answer", "system", undefined),
        logicalParentUuid: "root-answer",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 10 },
        timestamp: "2026-01-01T00:00:01.000Z",
        content: "Conversation compacted",
      },
      {
        ...f.record("idle-summary", "idle-boundary", "user", {
          role: "user",
          content: "Saved context",
        }),
        isCompactSummary: true,
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ];
    try {
      f.write(copied);
      const directory = join(f.directory, sessionId, "subagents");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "agent-a123456789abcdef0.jsonl"),
        [
          ...copied.map((entry) =>
            entry.uuid === "root-user"
              ? { ...entry, uuid: "rewritten-user" }
              : entry.uuid === "root-answer"
                ? { ...entry, parentUuid: "rewritten-user" }
                : entry,
          ),
          {
            ...f.record("fork-user", "idle-summary", "user", {
              role: "user",
              content: "Summarize inherited context",
            }),
            timestamp: "2026-01-01T00:00:02.000Z",
          },
          {
            ...f.record("fork-answer", "fork-user", "assistant", {
              role: "assistant",
              model: "claude-haiku-4-5",
              stop_reason: "end_turn",
              content: [{ type: "text", text: "Saved summary" }],
            }),
            timestamp: "2026-01-01T00:00:03.000Z",
          },
        ]
          .map((entry) => JSON.stringify({ ...entry, isSidechain: true }))
          .join("\n") + "\n",
      );
      await initializeNativeTarget(target, 96);
      const result = cli(
        "import",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--thread",
        sessionId,
        "--t3-home",
        target,
        "--no-resume",
        "--yes",
        "--json",
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const rows = JSON.parse(result.stdout).results;
      assert.equal(rows.length, 2);
      server = await startIsolatedT3Server({ t3Home: target });
      const parent = rows.find((row: { sourceId: string }) => row.sourceId === sessionId),
        child = rows.find((row: { sourceId: string }) => row.sourceId !== sessionId);
      const { projection: p }: { projection: { subagents: unknown[] } } = await server.request(
        `/api/orchestration/threads/${encodeURIComponent(parent.threadId)}`,
      );
      assert.equal(p.subagents.length, 0);
      const {
        projection: c,
      }: {
        projection: {
          thread: {
            forkedFrom: unknown;
            lineage: { relationshipToParent: string; parentThreadId: string };
          };
          messages: { text: string }[];
        };
      } = await server.request(`/api/orchestration/threads/${encodeURIComponent(child.threadId)}`);
      assert.equal(c.thread.lineage.relationshipToParent, "fork");
      assert.equal(c.thread.lineage.parentThreadId, parent.threadId);
      assert.equal(c.thread.forkedFrom, null);
      assert.deepEqual(
        c.messages.map((message) => message.text),
        ["Summarize inherited context", "Saved summary"],
      );
      const metadata = cli("metadata", "--t3-home", target, "--thread", child.threadId, "--json");
      assert.ok(
        metadata.stdout.includes("inherited_history") && metadata.stdout.includes("root-answer"),
      );
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test(
  "Claude recorded files remain browsable through T3 when the original workspace disappeared",
  { timeout: 60_000 },
  async () => {
    const f = fixture(),
      target = mkdtempSync(join(tmpdir(), "t3-claude-recorded-files-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    const contents = "export const restored = true;\n";
    try {
      f.write([
        f.record("u", null, "user", { role: "user", content: "Create Sources/recorded.ts" }),
        f.record("write", "u", "assistant", {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "write-file",
              name: "Write",
              input: { file_path: join(f.workspace, "Sources/recorded.ts"), content: contents },
            },
          ],
        }),
        f.record("result", "write", "user", {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "write-file", content: "File written" }],
        }),
        f.record("a", "result", "assistant", {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Updated `Sources/recorded.ts`." }],
        }),
      ]);
      rmSync(f.workspace, { recursive: true });
      await initializeNativeTarget(target, 96);
      const args = [
        "import",
        "--source",
        "claude",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--thread",
        sessionId,
        "--t3-home",
        target,
        "--no-resume",
        "--restore-workspace",
        "--yes",
        "--json",
      ];
      const result = cli(...args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const imported = JSON.parse(result.stdout),
        threadId = imported.results[0].threadId;
      assert.equal(imported.results[0].resumable, false);
      server = await startIsolatedT3Server({ t3Home: target });
      const {
        projection: p,
      }: { projection: { thread: { worktreePath: string }; messages: { text: string }[] } } =
        await server.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
      assert.ok(p.thread.worktreePath.startsWith(target));
      assert.ok(p.messages.some((message) => message.text === "Updated `Sources/recorded.ts`."));
      const file = await server.readProjectFile(p.thread.worktreePath, "Sources/recorded.ts");
      assert.equal(file.contents, contents);
      assert.equal(file.truncated, false);
      const provenance = cli("metadata", "--t3-home", target, "--thread", threadId, "--json");
      assert.equal(provenance.status, 0, provenance.stdout + provenance.stderr);
      assert.ok(
        JSON.parse(provenance.stdout).records.some(
          (record: { type: string; sourceWorkspace?: string }) =>
            record.type === "recorded_workspace" && record.sourceWorkspace === f.workspace,
        ),
      );
      assert.equal(
        existsSync(f.workspace),
        false,
        "the historical source workspace remains absent",
      );
      await server.stop();
      server = undefined;
      assert.equal(JSON.parse(cli(...args).stdout).status, "already-imported");
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test("Claude missing stop reasons still classify same-message tool commentary correctly", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Inspect" }),
      f.record("tools", "u", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: null,
        content: [
          { type: "text", text: "Checking" },
          { type: "tool_use", id: "read", name: "Read", input: { file_path: "/recorded.ts" } },
        ],
      }),
      f.record("result", "tools", "user", {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read", content: "Recorded file" }],
      }),
      f.record("answer", "result", "assistant", {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const items = JSON.parse(result.stdout).turns.flatMap(
      (turn: { items: { data: { text?: string; phase?: string } }[] }) => turn.items,
    );
    assert.equal(
      items.find((item: { data: { text?: string } }) => item.data.text === "Checking").data.phase,
      "commentary",
    );
    assert.equal(
      items.find((item: { data: { text?: string } }) => item.data.text === "Done").data.phase,
      "final_answer",
    );
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude idle synthetic acknowledgements do not extend a completed response by days", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Request" }),
      {
        ...f.record("a", "u", "assistant", {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done" }],
        }),
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        ...f.record("idle", "a", "assistant", {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        }),
        timestamp: "2026-01-07T00:00:00.000Z",
      },
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const root = JSON.parse(result.stdout);
    assert.equal(root.turns.length, 1);
    assert.equal(root.turns[0].completedAt, "2026-01-01T00:00:01.000Z");
    assert.equal(root.turns[0].items.at(-1).timestamp, "2026-01-07T00:00:00.000Z");
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude split blocks share commentary phase through their native response identity", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Inspect" }),
      f.record("progress", "u", "assistant", {
        id: "native-response",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Checking the file" }],
      }),
      f.record("tool", "progress", "assistant", {
        id: "native-response",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", id: "read", name: "Read", input: { file_path: "/recorded.ts" } },
        ],
      }),
      f.record("result", "tool", "user", {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read", content: "Recorded file" }],
      }),
      f.record("answer", "result", "assistant", {
        id: "final-response",
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      }),
    ]);
    const result = cli(
      "show",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--thread",
      sessionId,
      "--full",
      "--json",
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const items = JSON.parse(result.stdout).turns.flatMap(
      (turn: { items: { data: { text?: string; phase?: string } }[] }) => turn.items,
    );
    assert.equal(
      items.find((item: { data: { text?: string } }) => item.data.text === "Checking the file").data
        .phase,
      "commentary",
    );
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Claude idle acknowledgement after settled tools stays outside response time in real T3", async () => {
  const f = fixture();
  const target = mkdtempSync(join(tmpdir(), "t3-claude-idle-tools-"));
  let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "Inspect the file" }),
      {
        ...f.record("tool", "u", "assistant", {
          id: "native-response",
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "read", name: "Read", input: { file_path: "/recorded.ts" } },
          ],
        }),
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        ...f.record("result", "tool", "user", {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "read", content: "Recorded file" }],
        }),
        timestamp: "2026-01-01T00:00:02.000Z",
      },
      {
        ...f.record("idle", "result", "assistant", {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        }),
        timestamp: "2026-01-07T00:00:00.000Z",
      },
    ]);
    await initializeNativeTarget(target, 96);
    writeFileSync(
      join(target, "userdata/settings.json"),
      JSON.stringify({
        providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: false } },
      }),
    );
    const imported = cli(
      "import",
      "--source",
      "claude",
      "--source-home",
      f.home,
      "--workspace",
      f.workspace,
      "--thread",
      sessionId,
      "--t3-home",
      target,
      "--no-resume",
      "--yes",
      "--json",
    );
    assert.equal(imported.status, 0, imported.stdout + imported.stderr);
    const threadId = JSON.parse(imported.stdout).results[0].threadId;
    server = await startIsolatedT3Server({ t3Home: target });
    const { projection: p } = await server.request<{
      projection: {
        runs: { completedAt: string; status: string }[];
        turnItems: { type: string; runId: string | null; startedAt: string; level?: string }[];
      };
    }>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
    assert.equal(p.runs.length, 1);
    assert.equal(p.runs[0]!.completedAt, "2026-01-01T00:00:02.000Z");
    assert.equal(p.runs[0]!.status, "completed");
    const notice = p.turnItems.find((item) => item.type === "system_notice")!;
    assert.equal(notice.startedAt, "2026-01-07T00:00:00.000Z");
    assert.equal(notice.runId, null);
    assert.equal(notice.level, "info");
  } finally {
    await server?.stop();
    rmSync(f.home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
