import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), "t3-native-claude-")));
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const directory = join(home, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(directory, { recursive: true });
  const record = (id: string, parentUuid: string | null, type: string, message: unknown) => ({ uuid: id, parentUuid, type, message, sessionId, cwd: workspace, timestamp, isSidechain: false, version: "2.1.321", userType: "external" });
  const entries = [record("u", null, "user", { role: "user", content: "Native Claude question" }),
    record("abandoned", "u", "assistant", { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Abandoned response" }], stop_reason: "end_turn" }),
    record("selected", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", content: [{ type: "text", text: "Selected Claude response" }], stop_reason: "end_turn" })];
  writeFileSync(join(directory, `${sessionId}.jsonl`), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return { home, workspace, directory, record, write: (values: unknown[]) => writeFileSync(join(directory, `${sessionId}.jsonl`), values.map(entry => JSON.stringify(entry)).join("\n") + "\n") };
}
function cli(...args: string[]) {
  return spawnSync(process.execPath, [resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"), ...args], { encoding: "utf8", timeout: 30_000 });
}

test("Claude history is readable through the CLI using its native selected conversation", () => {
  const f = fixture();
  try {
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--workspace", f.workspace, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.driver, "claudeAgent");
    assert.deepEqual(conversation.turns.flatMap((turn: { items: Array<{ data: { text?: string } }> }) => turn.items.map(item => item.data.text)), ["Native Claude question", "Selected Claude response"]);
    assert.equal(conversation.active, false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude tool loops retain thinking, complete tool results and same-turn user steering", () => {
  const f = fixture();
  try {
    f.write([
      f.record("u", null, "user", { role: "user", content: "First request" }),
      f.record("tool", "u", "assistant", { role: "assistant", model: "claude-sonnet-4-6", stop_reason: "tool_use", content: [{ type: "thinking", thinking: "Visible reasoning" }, { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "printf fixture" } }] }),
      f.record("result", "tool", "user", { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-1", content: "Entire command output\nSecond line", is_error: false }] }),
      f.record("steer", "result", "user", { role: "user", content: "Same-turn steering" }),
      f.record("done", "steer", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Finished" }] }),
    ]);
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.turns.length, 1);
    const items = conversation.turns[0].items;
    assert.deepEqual(items.filter((item: {kind: string}) => item.kind === "user_message").map((item: {data: {text: string}}) => item.data.text), ["First request", "Same-turn steering"]);
    assert.equal(items.find((item: {kind: string}) => item.kind === "reasoning").data.text, "Visible reasoning");
    assert.equal(items.find((item: {kind: string}) => item.kind === "command_execution").data.output, "Entire command output\nSecond line");
    assert.equal(items.find((item: {kind: string}) => item.kind === "command_execution").status, "completed");
    assert.equal(items[1].model, "claude-sonnet-4-6");
    assert.equal(items.at(-1).model, "claude-opus-4-6");
    assert.equal(conversation.turns[0].model, "claude-sonnet-4-6");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude preserves timestamps returned by the native history API", () => {
  const f = fixture();
  try {
    f.write([f.record("u", null, "user", { role: "user", content: "Question" }),
      { ...f.record("a", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Answer" }] }), timestamp: "2026-01-01T00:03:00.000Z" }]);
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.turns[0].items.at(-1).timestamp, "2026-01-01T00:03:00.000Z");
    assert.equal(conversation.turns[0].completedAt, "2026-01-01T00:03:00.000Z");
    assert.doesNotMatch(conversation.warnings.join(" "), /does not expose per-record timestamps/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude native compaction summaries remain history markers instead of new user turns", () => {
  const f = fixture();
  try {
    f.write([f.record("u", null, "user", { role: "user", content: "Question before compaction" }),
      f.record("a", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Previous answer" }] }),
      { ...f.record("compact", "a", "user", { role: "user", content: "Native compact summary" }), isCompactSummary: true },
      f.record("b", "compact", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Continued answer" }] })]);
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.turns.length, 1);
    assert.equal(conversation.turns[0].items.find((item: {kind: string}) => item.kind === "compaction").data.summary, "Native compact summary");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude imports native child and grandchild histories with their spawning tool links", () => {
  const f = fixture();
  const childId = "a1111111111111111", grandchildId = "a2222222222222222";
  try {
    f.write([f.record("u", null, "user", { role: "user", content: "Root question" }),
      f.record("spawn", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_child", name: "Agent", input: { description: "Historical child" } }] }),
      f.record("done", "spawn", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Root answer" }] })]);
    const subagents = join(f.directory, sessionId, "subagents"); mkdirSync(subagents, { recursive: true });
    const writeAgent = (id: string, parent: string | null, toolUseId: string, entries: unknown[]) => {
      writeFileSync(join(subagents, `agent-${id}.jsonl`), entries.map(value => JSON.stringify(value)).join("\n") + "\n");
      writeFileSync(join(subagents, `agent-${id}.meta.json`), JSON.stringify({ toolUseId, parentAgentId: parent, agentType: "general-purpose" }));
    };
    writeAgent(childId, null, "toolu_child", [f.record("cu", null, "user", { role: "user", content: "Child question" }),
      f.record("cs", "cu", "assistant", { role: "assistant", model: "claude-sonnet-4-6", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_grandchild", name: "Agent", input: { description: "Historical grandchild" } }] }),
      f.record("ca", "cs", "assistant", { role: "assistant", model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Child answer" }] })]);
    writeAgent(grandchildId, childId, "toolu_grandchild", [f.record("gu", null, "user", { role: "user", content: "Grandchild question" }),
      f.record("ga", "gu", "assistant", { role: "assistant", model: "claude-haiku-4-5", stop_reason: "end_turn", content: [{ type: "text", text: "Grandchild answer" }] })]);
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const root = JSON.parse(result.stdout);
    assert.equal(root.children.length, 1);
    const child = root.children[0], grandchild = child.children[0];
    assert.equal(child.parent.sourceId, sessionId);
    assert.equal(child.parent.nativeItemId, "toolu_child");
    assert.equal(grandchild.parent.sourceId, child.id);
    assert.equal(grandchild.parent.nativeItemId, "toolu_grandchild");
    assert.equal(grandchild.turns[0].items.at(-1).data.text, "Grandchild answer");
    assert.equal(child.resumeSupported, false);
    assert.equal(grandchild.model, "claude-haiku-4-5");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude image-only user requests remain importable attachments", () => {
  const f = fixture();
  try {
    f.write([f.record("image", null, "user", { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCboAAAAASUVORK5CYII=" } }] }),
      f.record("a", "image", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Image inspected" }] })]);
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const user = JSON.parse(result.stdout).turns[0].items[0];
    assert.equal(user.kind, "user_message");
    assert.equal(user.images[0].mimeType, "image/png");
    assert.equal(user.images[0].base64, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCboAAAAASUVORK5CYII=");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude historical text replies without a stop reason do not masquerade as active tool work", () => {
  const f = fixture();
  try {
    f.write([f.record("u", null, "user", { role: "user", content: "Historical request" }),
      f.record("a", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: null, content: [{ type: "text", text: "Persisted historical reply" }] })]);
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.active, false);
    assert.equal(conversation.turns[0].status, "completed");
    assert.match(conversation.warnings.join(" "), /stop reason/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude synthetic acknowledgements remain visible without inventing a model or failure", () => {
  const f = fixture();
  try {
    f.write([f.record("u", null, "user", { role: "user", content: "Request" }),
      f.record("error", "u", "assistant", { role: "assistant", model: "<synthetic>", stop_reason: null, content: [{ type: "text", text: "No response requested." }] })]);
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout), last = conversation.turns[0].items.at(-1);
    assert.equal(conversation.model, undefined);
    assert.equal(conversation.turns[0].status, "completed");
    assert.equal(last.kind, "system_notice");
    assert.equal(last.data.message, "No response requested.");
    assert.equal(last.model, undefined);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude system records before the first request do not create a fictitious extra turn", () => {
  const f = fixture();
  try {
    f.write([f.record("notice", null, "system", undefined), f.record("u", "notice", "user", { role: "user", content: "First request" }),
      f.record("a", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "First answer" }] })]);
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout);
    assert.equal(conversation.turns.length, 1);
    assert.deepEqual(conversation.turns[0].items.map((item: {kind: string}) => item.kind), ["system_notice", "user_message", "assistant_message"]);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude list and incomplete-tool inspection leave the native source files unchanged", () => {
  const f = fixture();
  const snapshot = (path: string): unknown => readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [entry.name, entry.isDirectory() ? snapshot(join(path, entry.name)) : createHash("sha256").update(readFileSync(join(path, entry.name))).digest("hex")]);
  try {
    f.write([f.record("u", null, "user", { role: "user", content: "Request" }),
      f.record("pending", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_pending", name: "Bash", input: { command: "not executed by the history reader" } }] })]);
    const before = snapshot(f.home);
    const listed = cli("list", "--source", "claude", "--source-home", f.home, "--json");
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.equal(JSON.parse(listed.stdout).sessions[0].id, sessionId);
    const shown = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    const conversation = JSON.parse(shown.stdout);
    assert.equal(conversation.active, true);
    assert.equal(conversation.turns[0].items.at(-1).status, "interrupted");
    assert.deepEqual(snapshot(f.home), before);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude document input retains a visible reference and its complete native payload", () => {
  const f = fixture();
  try {
    const document = { type: "document", title: "specification.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } };
    f.write([f.record("u", null, "user", { role: "user", content: [document] }),
      f.record("a", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Document reviewed" }] })]);
    const result = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const conversation = JSON.parse(result.stdout), items = conversation.turns[0].items;
    assert.match(items[0].data.text, /specification\.pdf/);
    assert.deepEqual(items.find((item: { kind: string }) => item.kind === "dynamic_tool").data.output, document);
    assert.match(conversation.warnings.join(" "), /document.*native payload/i);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Claude imports multiple unmatched tool results from the same native message", async () => {
  const f = fixture(), target = mkdtempSync(join(tmpdir(), "t3-claude-orphan-import-"));
  try {
    f.write([f.record("u", null, "user", { role: "user", content: "Historical request" }),
      f.record("r", "u", "user", { role: "user", content: [
        { type: "tool_result", tool_use_id: "missing-1", content: "First retained result" },
        { type: "tool_result", tool_use_id: "missing-2", content: "Second retained result" },
      ] }),
      f.record("a", "r", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] })]);
    await initializeNativeTarget(target, 96);
    const imported = cli("import", "--source", "claude", "--source-home", f.home, "--workspace", f.workspace, "--thread", sessionId, "--t3-home", target, "--no-resume", "--yes", "--json");
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
    assert.equal(JSON.parse(imported.stdout).results[0].items, 4);
    const shown = cli("show", "--source", "claude", "--source-home", f.home, "--thread", sessionId, "--full", "--json");
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    const items = JSON.parse(shown.stdout).turns[0].items;
    assert.equal(new Set(items.map((item: { id: string }) => item.id)).size, 4);
    assert.deepEqual(items.filter((item: { kind: string }) => item.kind === "dynamic_tool").map((item: { data: { output: { content: string } } }) => item.data.output.content), ["First retained result", "Second retained result"]);
  } finally { rmSync(f.home, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("Claude snapshot imports incomplete native root and child histories as interrupted views through a real T3 server", { skip: !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")), timeout: 90_000 }, async () => {
  const f = fixture(), target = mkdtempSync(join(tmpdir(), "t3-claude-snapshot-"));
  let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
  const digest = (path: string): unknown => readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [entry.name, entry.isDirectory() ? digest(join(path, entry.name)) : createHash("sha256").update(readFileSync(join(path, entry.name))).digest("hex")]);
  try {
    f.write([f.record("u", null, "user", { role: "user", content: "Earlier request" }),
      f.record("done", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Earlier answer" }] }),
      f.record("pending-user", "done", "user", { role: "user", content: "Unanswered historical request" })]);
    const agents = join(f.directory, sessionId, "subagents"); mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "agent-incomplete-child.jsonl"), [
      { ...f.record("child-user", null, "user", { role: "user", content: "Child request" }), isSidechain: true },
      { ...f.record("child-tool", "child-user", "assistant", { role: "assistant", model: "claude-haiku-4-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "native-pending-call", name: "Bash", input: { command: "never executed by the importer" } }] }), isSidechain: true },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const before = digest(f.home);
    await initializeNativeTarget(target, 96);
    writeFileSync(join(target, "userdata/settings.json"), JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: false } } }));
    const args = ["import", "--source", "claude", "--source-home", f.home, "--workspace", f.workspace, "--thread", sessionId, "--t3-home", target, "--no-resume", "--yes", "--json"];
    const normal = cli(...args);
    assert.notEqual(normal.status, 0);
    assert.match(JSON.parse(normal.stdout).error, /active or indeterminate/);
    const snapshot = cli(...args, "--snapshot");
    assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
    const imported = JSON.parse(snapshot.stdout);
    assert.equal(imported.results.length, 2);
    assert.ok(imported.results.every((result: { resumable: boolean; warnings: string[] }) => !result.resumable && result.warnings.some(warning => /snapshot/i.test(warning))));
    server = await startIsolatedT3Server({ t3Home: target });
    for (const result of imported.results) {
      const { projection }: { projection: { runs: Array<{ status: string }>; thread: { activeProviderThreadId: string | null }; turnItems: Array<{ status: string; type: string; nativeItemRef?: { nativeId: string }; output?: unknown }>; providerThreads: Array<{ nativeThreadRef: unknown }>; runtimeRequests: unknown[] } } = await server.request(`/api/orchestration/threads/${encodeURIComponent(result.threadId)}`);
      assert.equal(projection.runs.at(-1)!.status, "interrupted");
      assert.equal(projection.runtimeRequests.length, 0);
      assert.ok(projection.providerThreads.every(thread => thread.nativeThreadRef === null));
      if (result.sourceId === sessionId) assert.ok(projection.turnItems.some(item => item.nativeItemRef?.nativeId === "pending-user"));
      else {
        const call = projection.turnItems.find(item => item.nativeItemRef?.nativeId === "native-pending-call")!;
        assert.ok(call); assert.equal(call.status, "interrupted"); assert.equal(call.type, "command_execution");
        assert.equal(call.output, undefined, "an unfinished tool receives no fabricated result");
      }
    }
    await server.stop(); server = undefined;
    const repeated = cli(...args, "--snapshot");
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).status, "already-imported");
    assert.deepEqual(digest(f.home), before);
  } finally { await server?.stop(); rmSync(f.home, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("Claude snapshot requires history-only mode and cannot be applied to another native harness", () => {
  for (const args of [
    ["--source", "claude", "--snapshot"],
    ["--source", "codex", "--snapshot", "--no-resume"],
    ["--source", "omp", "--snapshot", "--no-resume"],
  ]) {
    const result = cli("import", ...args, "--workspace", "/unused", "--thread", "unused", "--binary", "never-launch-this-source", "--dry-run", "--json");
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const error = JSON.parse(result.stdout).error;
    assert.match(error, /snapshot.*(no-resume|only.*Claude)/i);
    assert.doesNotMatch(error, /ENOENT|spawn|never-launch/);
  }
});

test("Claude snapshot still rejects a native source that changes while its history is read", { timeout: 30_000 }, async () => {
  const f = fixture(), target = mkdtempSync(join(tmpdir(), "t3-claude-snapshot-changing-"));
  let child: ReturnType<typeof spawn> | undefined;
  let changing: ReturnType<typeof setInterval> | undefined;
  try {
    f.write([f.record("u", null, "user", { role: "user", content: "Earlier request" }),
      f.record("done", "u", "assistant", { role: "assistant", model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Large native text ".repeat(600_000) }] }),
      f.record("pending-user", "done", "user", { role: "user", content: "Unanswered request" })]);
    await initializeNativeTarget(target, 96);
    const file = join(f.directory, `${sessionId}.jsonl`), initialTime = Date.now();
    let tick = 0;
    child = spawn(process.execPath, [resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"), "import", "--source", "claude", "--source-home", f.home, "--workspace", f.workspace, "--thread", sessionId, "--t3-home", target, "--snapshot", "--no-resume", "--yes", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    changing = setInterval(() => { const time = new Date(initialTime + ++tick); utimesSync(file, time, time); }, 1);
    const status = await new Promise<number | null>((accept, reject) => { child!.once("error", reject); child!.once("close", accept); });
    clearInterval(changing); changing = undefined;
    assert.notEqual(status, 0, stderr);
    assert.match(JSON.parse(stdout).error, /active or indeterminate/);
    const projects = cli("projects", "--t3-home", target, "--json");
    assert.equal(projects.status, 0, projects.stdout + projects.stderr);
    assert.deepEqual(JSON.parse(projects.stdout).projects, [], "a changing snapshot writes no partial project");
  } finally {
    if (changing) clearInterval(changing);
    if (child && child.exitCode === null) child.kill("SIGTERM");
    rmSync(f.home, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
  }
});
