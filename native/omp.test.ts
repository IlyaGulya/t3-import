import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { importNativeConversations, initializeNativeTarget } from "./target.js";
import { startIsolatedT3Server } from "./server.js";
import { createOmpReader, resolveOmpPackage } from "./omp.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = (
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  extra = {},
) => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: {
    role,
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    timestamp: Date.parse(timestamp),
    ...(role === "assistant"
      ? {
          api: "openai-responses",
          provider: "openai",
          model: "native-test",
          usage,
          stopReason: "stop",
        }
      : {}),
    ...extra,
  },
});
let packageRoot: string | undefined;
try {
  packageRoot = await resolveOmpPackage(
    process.env.OMP_NATIVE_REFERENCE_PACKAGE
      ? { ompPackage: process.env.OMP_NATIVE_REFERENCE_PACKAGE }
      : {},
  );
} catch {}
const skip = !packageRoot ? "OMP 18.22.0 native source package is not installed" : false;
const helperPath = resolve(process.env.OMP_NATIVE_HELPER || "dist/omp-helper.js");
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function sourceTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) result[key] = `symlink:${await readlink(path)}`;
      else if (entry.isDirectory()) {
        result[key] = "directory";
        await visit(path, `${key}/`);
      } else result[key] = await hash(path);
    }
  };
  await visit(root);
  return result;
}
async function fixture(
  entries: unknown[],
  { version = 3, titleSlot = "", suffix = "", id = randomUUID() } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "t3-omp-native-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const bucket = join(home, "sessions", "fixture");
  await mkdir(bucket, { recursive: true });
  const path = join(bucket, "2026-01-01_fixture.jsonl");
  await writeFile(
    path,
    titleSlot +
      [{ type: "session", id, version, timestamp, cwd: workspace }, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join("\n") +
      "\n" +
      suffix,
  );
  const reader = createOmpReader({ helperPath });
  const options = { sourceHome: home, ompPackage: packageRoot!, workspace };
  return {
    home,
    workspace,
    path,
    id,
    reader,
    options,
    close: async () => {
      await reader.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test(
  "OMP cold archives keep their native history and children in T3 Archived",
  {
    skip: skip || !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
    timeout: 90_000,
  },
  async () => {
    const f = await fixture([
      message("current-user", null, "user", "Current question"),
      message("current-answer", "current-user", "assistant", "Current answer"),
    ]);
    const target = await mkdtemp(join(tmpdir(), "t3-omp-cold-archive-"));
    const archiveId = "91230000-1111-4111-8111-111111111117";
    const childId = "91230000-2222-4222-8222-222222222227";
    const bucket = join(f.home, "archive", "sessions", "fixture");
    const stem = join(bucket, `2026-01-01_${archiveId}`);
    const encode = (id: string, label: string) =>
      gzipSync(
        [
          { type: "session", id, version: 3, timestamp, cwd: f.workspace, title: label },
          message("u", null, "user", `${label} question`),
          message("a", "u", "assistant", `${label} answer`),
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      await mkdir(stem, { recursive: true });
      await writeFile(`${stem}.jsonl.gz`, encode(archiveId, "Cold"));
      await writeFile(join(stem, "child.jsonl.gz"), encode(childId, "Cold child"));
      const before = await sourceTree(f.home);
      const cli = (...args: string[]) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"), ...args],
            { encoding: "utf8", timeout: 30_000 },
          ),
        );
      const flags = [
        "--source",
        "omp",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--omp-package",
        packageRoot!,
        "--json",
      ];
      const current = cli("list", ...flags).sessions;
      assert.deepEqual(
        current.map((x: { id: string; archived: boolean }) => [x.id, x.archived]),
        [[f.id, false]],
      );
      const archives = cli("list", ...flags, "--archived").sessions;
      assert.deepEqual(
        archives.map((x: { id: string; archived: boolean }) => [x.id, x.archived]),
        [[archiveId, true]],
      );
      await initializeNativeTarget(target, 96);
      await writeFile(
        join(target, "userdata/settings.json"),
        JSON.stringify({
          providerInstances: { pi: { driver: "pi", enabled: false } },
        }),
      );
      const args = ["import", ...flags, "--thread", archiveId, "--t3-home", target, "--yes"];
      const imported = cli(...args);
      assert.equal(imported.results.length, 2);
      assert.ok(imported.results.every((result: { resumable: boolean }) => !result.resumable));
      server = await startIsolatedT3Server({ t3Home: target });
      const root = imported.results.find(
        (result: { sourceId: string }) => result.sourceId === archiveId,
      );
      const { projection } = await server.request<{
        projection: {
          thread: { archivedAt: string | null; settledOverride: string | null };
          messages: Array<{ text: string }>;
          subagents: Array<{ childThreadId: string | null }>;
        };
      }>(`/api/orchestration/threads/${encodeURIComponent(root.threadId)}`);
      assert.equal(projection.thread.archivedAt, timestamp);
      assert.equal(projection.thread.settledOverride, null);
      assert.deepEqual(
        projection.messages.map((entry) => entry.text),
        ["Cold question", "Cold answer"],
      );
      assert.ok(projection.subagents[0]?.childThreadId);
      await server.stop();
      server = undefined;
      assert.equal(
        cli("import", ...flags, "--archived", "--all", "--t3-home", target, "--yes").status,
        "already-imported",
      );
      assert.deepEqual(await sourceTree(f.home), before);
    } finally {
      await server?.stop();
      await f.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  "OMP native child and compressed grandchild histories survive CLI import and real T3 projection",
  {
    skip: skip || !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
    timeout: 90_000,
  },
  async () => {
    const f = await fixture(
      [
        message("ru", null, "user", "Root request"),
        message(
          "task",
          "ru",
          "assistant",
          [
            {
              type: "toolCall",
              id: "task-call",
              name: "task",
              arguments: { tasks: [{ name: "Requested name", task: "Review" }] },
            },
          ],
          { stopReason: "toolUse" },
        ),
        message("task-result", "task", "toolResult", "Started the native child", {
          toolName: "task",
          toolCallId: "task-call",
          isError: false,
          details: {
            progress: [{ id: "Child", index: 0, status: "pending" }],
            results: [],
            async: { state: "running", jobId: "not-the-transcript-id", type: "task" },
          },
        }),
        message("ra", "task-result", "assistant", "Root answer"),
      ],
      { id: "91230000-1111-4111-8111-111111111111" },
    );
    const target = await mkdtemp(join(tmpdir(), "t3-omp-native-family-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const directory = f.path.slice(0, -6);
      await mkdir(join(directory, "Child"), { recursive: true });
      const encode = (id: string, title: string, entries: unknown[]) =>
        [{ type: "session", id, title, version: 3, timestamp, cwd: f.workspace }, ...entries]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n";
      await writeFile(
        join(directory, "Child.jsonl"),
        encode("91230000-2222-4222-8222-222222222222", "Native OMP child", [
          message("cu", null, "user", "Child request"),
          message("abandoned", "cu", "assistant", "Abandoned child branch"),
          message(
            "ct",
            "cu",
            "assistant",
            [
              {
                type: "toolCall",
                id: "child-command",
                name: "bash",
                arguments: { command: "not executed by import" },
              },
            ],
            {
              model: "child-first",
              stopReason: "toolUse",
              usage: { ...usage, input: 17, totalTokens: 17 },
            },
          ),
          {
            ...message("cr", "ct", "toolResult", "Native child output", {
              toolCallId: "child-command",
              toolName: "bash",
              isError: false,
            }),
            timestamp: "2026-01-01T00:00:02.000Z",
          },
          {
            type: "compaction",
            id: "cc",
            parentId: "cr",
            timestamp: "2026-01-01T00:00:03.000Z",
            summary: "Native child summary",
            firstKeptEntryId: "cu",
            tokensBefore: 1234,
          },
          {
            ...message("ca", "cc", "assistant", "Child answer", { model: "child-second" }),
            timestamp: "2026-01-01T00:00:04.000Z",
          },
        ]),
      );
      await writeFile(
        join(directory, "Child", "Grand.jsonl.gz"),
        gzipSync(
          encode("91230000-3333-4333-8333-333333333333", "Native compressed OMP grandchild", [
            message("gu", null, "user", "Grandchild request"),
            message("ga", "gu", "assistant", "Grandchild answer", { model: "grand-model" }),
          ]),
        ),
      );
      await writeFile(
        join(directory, "__advisor.reviewer.jsonl"),
        encode("91230000-4444-4444-8444-444444444444", "Native advisor", [
          message("au", null, "user", "Advisor request"),
          message("aa", "au", "assistant", "Advisor answer"),
        ]),
      );
      const before = await sourceTree(f.home);
      const cli = (...args: string[]) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"), ...args],
            { encoding: "utf8", timeout: 30_000 },
          ),
        );
      const sourceArgs = [
        "--source",
        "omp",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--omp-package",
        packageRoot!,
        "--thread",
        f.id,
      ];
      const shown = cli("show", ...sourceArgs, "--full", "--json");
      assert.equal(shown.children.length, 2);
      const child = shown.children.find((c: { title: string }) => c.title === "Native OMP child");
      assert.ok(child);
      assert.deepEqual(child.sourceCoverage, {
        schemaVersion: 1,
        selectedRecords: 5,
        mappedRecords: 5,
        metadataOnlyRecords: 0,
        missingRecordIds: [],
        nativeKinds: {
          "message.user": 1,
          "message.assistant": 2,
          "message.toolResult": 1,
          compaction: 1,
        },
      });
      assert.ok(
        child.nativeMetadata.some(
          (record: { type: string; uuid?: string; usage?: { input: number } }) =>
            record.type === "omp_assistant_metadata" &&
            record.uuid === "ct" &&
            record.usage?.input === 17,
        ),
      );
      assert.equal(child.children.length, 1);
      assert.equal(child.children[0].parent.sourceId, child.id);
      assert.equal(child.parent.sourceId, f.id);
      assert.equal(
        child.parent.nativeItemId,
        "task:0",
        "use the allocated agent identity in native task progress",
      );
      assert.equal(child.children[0].parent.nativeItemId, undefined);
      assert.equal(child.resumeSupported, false);
      assert.equal(child.children[0].resumeSupported, false);
      const items = child.turns.flatMap((turn: { items: unknown[] }) => turn.items);
      assert.ok(!JSON.stringify(items).includes("Abandoned child branch"));
      assert.equal(
        items.find((item: { kind: string }) => item.kind === "command_execution").data.output,
        "Native child output",
      );
      assert.equal(
        items.find((item: { kind: string }) => item.kind === "compaction").data.summary,
        "Native child summary",
      );
      assert.equal(child.children[0].turns[0].items.at(-1).data.text, "Grandchild answer");
      await initializeNativeTarget(target, 96);
      await writeFile(
        join(target, "userdata/settings.json"),
        JSON.stringify({ providerInstances: { pi: { driver: "pi", enabled: false } } }),
      );
      const args = ["import", ...sourceArgs, "--t3-home", target, "--no-resume", "--yes", "--json"];
      const imported = cli(...args);
      assert.equal(imported.results.length, 4);
      server = await startIsolatedT3Server({ t3Home: target });
      const childResult = imported.results.find(
        (r: { sourceId: string }) => r.sourceId === child.id,
      );
      const rootResult = imported.results.find((r: { sourceId: string }) => r.sourceId === f.id);
      const rootPath = `/api/orchestration/threads/${encodeURIComponent(rootResult.threadId)}`;
      const { projection: root } = await server.request<{
        projection: {
          turnItems: Array<{
            id: string;
            toolName?: string;
            childThreadId?: string;
            parentItemId: string | null;
            runId: string | null;
          }>;
        };
      }>(rootPath);
      const launch = root.turnItems.find((item) => item.toolName === "task");
      const card = root.turnItems.find((item) => item.childThreadId === childResult.threadId);
      assert.ok(launch?.runId);
      assert.equal(card?.parentItemId, launch.id);
      assert.equal(card?.runId, launch.runId);
      const { projection: p } = await server.request<{
        projection: {
          turnItems: Array<{ type: string }>;
          providerTurns: Array<{ model?: string }>;
          runtimeRequests: unknown[];
          thread: { lineage: { parentThreadId: string | null } };
          subagents: Array<{ childThreadId: string; runId: string | null }>;
        };
      }>(`/api/orchestration/threads/${encodeURIComponent(childResult.threadId)}`);
      assert.ok(p.turnItems.some((item) => item.type === "compaction"));
      assert.deepEqual(
        p.providerTurns.map((turn) => turn.model),
        ["openai/child-first", "openai/child-second"],
      );
      assert.equal(p.runtimeRequests.length, 0);
      assert.equal(p.subagents.length, 1);
      assert.equal(p.subagents[0]!.runId, null, "no launch ownership is fabricated");
      await server.stop();
      server = undefined;
      assert.equal(cli(...args).status, "already-imported");
      assert.deepEqual(await sourceTree(f.home), before);
    } finally {
      await server?.stop();
      await f.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  "OMP streams a turn and family larger than the CLI heap without changing its source or T3 target",
  { skip, timeout: 90_000 },
  async () => {
    const body = "streamed history content ".repeat(90_000);
    const rootItems = 64;
    const f = await fixture(
      [
        message("u", null, "user", "Root"),
        ...Array.from({ length: rootItems }, (_, index) =>
          message(
            `part-${index}`,
            index ? `part-${index - 1}` : "u",
            "assistant",
            [{ type: "thinking", thinking: body }],
            { stopReason: "toolUse" },
          ),
        ),
        message("a", `part-${rootItems - 1}`, "assistant", "Done"),
      ],
      { id: "91230000-1111-4111-8111-111111111119" },
    );
    const target = await mkdtemp(join(tmpdir(), "t3-omp-stream-"));
    try {
      const directory = f.path.slice(0, -6);
      await mkdir(directory);
      const childCount = 16;
      for (let index = 0; index < childCount; index++) {
        const header = {
          type: "session",
          id: `91230000-2222-4222-8222-${String(index).padStart(12, "0")}`,
          version: 3,
          timestamp,
          cwd: f.workspace,
        };
        await writeFile(
          join(directory, `child-${index}.jsonl`),
          [header, message("u", null, "user", "Child"), message("a", "u", "assistant", body)]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
        );
      }
      const before = await sourceTree(f.home);
      await initializeNativeTarget(target, 96);
      const database = join(target, "userdata/statev2.sqlite");
      const beforeDatabase = await hash(database);
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--max-old-space-size=128",
            resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"),
            "import",
            "--source",
            "omp",
            "--source-home",
            f.home,
            "--omp-package",
            packageRoot!,
            "--workspace",
            f.workspace,
            "--thread",
            f.path,
            "--t3-home",
            target,
            "--no-resume",
            "--dry-run",
            "--json",
          ],
          { encoding: "utf8", timeout: 80_000, stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      assert.equal(result.status, "dry-run");
      assert.equal(result.backup, null);
      assert.equal(result.results.length, childCount + 1);
      assert.ok(result.results.every((row: { messages: number }) => row.messages === 2));
      assert.equal(result.results[0].turns, 1);
      assert.equal(result.results[0].items, rootItems + 2);
      assert.equal(await hash(database), beforeDatabase);
      assert.deepEqual(await sourceTree(f.home), before);
    } finally {
      await f.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  "OMP imports a family with an allocated child that has no transcript",
  {
    skip: skip || !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
    timeout: 90_000,
  },
  async () => {
    const reasoning = Array.from({ length: 270 }, (_, index) => ({
      type: "thinking",
      thinking: `Reasoning step ${index}`,
    }));
    const f = await fixture(
      [
        message("u", null, "user", "Root question"),
        message(
          "call",
          "u",
          "assistant",
          [
            ...reasoning,
            {
              type: "toolCall",
              id: "task-call",
              name: "task",
              arguments: {
                tasks: [
                  { name: "Empty", task: "Prepare" },
                  { name: "Sibling", task: "Review" },
                ],
              },
            },
          ],
          { stopReason: "toolUse" },
        ),
        message("result", "call", "toolResult", "Allocated the children", {
          toolName: "task",
          toolCallId: "task-call",
          isError: false,
          details: {
            progress: [
              { id: "Empty", index: 0, status: "pending" },
              { id: "Sibling", index: 1, status: "pending" },
            ],
          },
        }),
        message("a", "result", "assistant", "Root answer"),
      ],
      { id: "91230000-1111-4111-8111-111111111118" },
    );
    const target = await mkdtemp(join(tmpdir(), "t3-omp-empty-child-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const directory = f.path.slice(0, -6);
      await mkdir(directory);
      await writeFile(
        join(directory, "changes.jsonl"),
        JSON.stringify({
          type: "change",
          at: Date.parse(timestamp),
          agent: "Main",
          tool: "edit",
          path: join(f.workspace, "example.txt"),
          before: null,
          after: null,
        }) + "\n",
      );
      const empty = {
        type: "session",
        id: "91230000-2222-4222-8222-222222222228",
        version: 3,
        timestamp,
        cwd: f.workspace,
      };
      await writeFile(join(directory, "Empty.jsonl"), JSON.stringify(empty) + "\n");
      await writeFile(
        join(directory, "Sibling.jsonl"),
        [
          { ...empty, id: "91230000-3333-4333-8333-333333333338" },
          message("su", null, "user", "Sibling question"),
          message("sa", "su", "assistant", "Sibling answer"),
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const before = await sourceTree(f.home);
      await initializeNativeTarget(target, 96);
      await writeFile(
        join(target, "userdata/settings.json"),
        JSON.stringify({ providerInstances: { pi: { driver: "pi", enabled: false } } }),
      );
      const cli = (...args: string[]) =>
        JSON.parse(
          execFileSync(process.execPath, [resolve("dist/cli.js"), ...args, "--json"], {
            encoding: "utf8",
            timeout: 30_000,
          }),
        );
      const args = [
        "import",
        "--source",
        "omp",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--omp-package",
        packageRoot!,
        "--thread",
        f.id,
        "--t3-home",
        target,
        "--no-resume",
      ];
      const planned = cli(...args, "--dry-run");
      const [rootPlan, childPlan] = planned.results;
      assert.equal(childPlan.sourceId, `${f.id}:agent:Sibling`);
      const db = new DatabaseSync(join(target, "userdata/statev2.sqlite"));
      try {
        // Abort only after the parent's events are visible inside the uncommitted transaction.
        db.exec(`
          CREATE TRIGGER fail_native_child BEFORE INSERT ON orchestration_events
          WHEN NEW.stream_id = '${childPlan.threadId}' AND EXISTS (
            SELECT 1 FROM orchestration_events WHERE stream_id = '${rootPlan.threadId}'
          )
          BEGIN SELECT RAISE(ABORT, 'fixture interrupted family write'); END;
        `);
        assert.throws(
          () => cli(...args, "--yes"),
          (error: unknown) => {
            const failure = error as { status?: number; stdout?: string };
            return failure.status === 6 && JSON.parse(failure.stdout ?? "{}").status === "error";
          },
        );
        assert.deepEqual(
          db.prepare("SELECT DISTINCT stream_id FROM orchestration_events").all(),
          [],
        );
        assert.equal(
          db.prepare("SELECT 1 FROM sqlite_master WHERE name = 't3_native_imports'").get(),
          undefined,
        );
      } finally {
        db.exec("DROP TRIGGER IF EXISTS fail_native_child");
        db.close();
      }
      const imported = cli(...args, "--yes");
      assert.equal(imported.status, "imported");
      assert.deepEqual(
        imported.results.map((r: { sourceId: string }) => r.sourceId),
        [f.id, `${f.id}:agent:Sibling`],
      );
      const [root, sibling] = imported.results;
      assert.match(root.warnings.join("\n"), /Empty.*no transcript/u);
      const metadata = cli("metadata", "--t3-home", target, "--thread", root.threadId);
      const omitted = metadata.records.find(
        (record: { type: string }) => record.type === "omp_empty_subsession",
      );
      assert.equal(omitted?.sourceId, `${f.id}:agent:Empty`);
      assert.deepEqual(omitted.parent, {
        sourceId: f.id,
        nativeItemId: `call:${reasoning.length}`,
      });
      assert.deepEqual(omitted.nativeMetadata[0].header, empty);

      server = await startIsolatedT3Server({ t3Home: target });
      const { projection } = await server.request<{
        projection: {
          messages: Array<{ text: string }>;
          turnItems: Array<{ id: string; toolName?: string; parentItemId: string | null }>;
          subagents: Array<{ childThreadId: string }>;
        };
      }>(`/api/orchestration/threads/${encodeURIComponent(root.threadId)}`);
      assert.deepEqual(
        projection.messages.map((entry) => entry.text),
        ["Root question", "Root answer"],
      );
      assert.ok(projection.turnItems.some((item) => item.toolName === "task"));
      assert.deepEqual(
        projection.subagents.map((entry) => entry.childThreadId),
        [sibling.threadId],
      );
      await server.stop();
      server = undefined;
      assert.equal(cli(...args, "--yes").status, "already-imported");
      assert.deepEqual(await sourceTree(f.home), before);
    } finally {
      await server?.stop();
      await f.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  "OMP native aborted child tails remain interrupted and malformed children cannot disappear silently",
  { skip },
  async () => {
    const f = await fixture([
      message("ru", null, "user", "Root request"),
      message("ra", "ru", "assistant", "Root answer"),
    ]);
    const target = await mkdtemp(join(tmpdir(), "t3-omp-snapshot-tail-"));
    try {
      const directory = f.path.slice(0, -6);
      await mkdir(directory);
      const childPath = join(directory, "Killed.jsonl");
      const header = {
        type: "session",
        id: "91230000-5555-4555-8555-555555555555",
        version: 3,
        timestamp,
        cwd: f.workspace,
      };
      await writeFile(
        childPath,
        [
          header,
          message("ku", null, "user", "Child request"),
          message(
            "kt",
            "ku",
            "assistant",
            [
              {
                type: "toolCall",
                id: "pending-child",
                name: "read",
                arguments: { path: "not-opened-by-import" },
              },
            ],
            { stopReason: "toolUse" },
          ),
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const active = await f.reader.read(f.id, f.options);
      assert.equal(active.children?.[0]?.active, true);
      await initializeNativeTarget(target, 96);
      const preview = JSON.parse(
        execFileSync(
          process.execPath,
          [
            resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"),
            "import-all",
            "--source",
            "omp",
            "--source-home",
            f.home,
            "--omp-package",
            packageRoot!,
            "--t3-home",
            target,
            "--dry-run",
            "--snapshot",
            "--json",
          ],
          { encoding: "utf8", timeout: 30_000 },
        ),
      );
      assert.equal(preview.results.length, 2);
      assert.match(
        preview.results
          .find((row: { sourceId: string }) => row.sourceId.endsWith(":agent:Killed"))
          .warnings.join(" "),
        /snapshot.*interrupted/i,
      );
      await writeFile(`${childPath}.tombstone`, "native kill marker");
      const before = await sourceTree(f.home);
      const aborted = await f.reader.read(f.id, f.options);
      const child = aborted.children![0]!;
      assert.equal(child.active, false);
      assert.equal(child.turns.at(-1)!.status, "interrupted");
      assert.equal(child.turns.at(-1)!.items.at(-1)!.status, "interrupted");
      assert.match(child.warnings.join(" "), /tombstone.*aborted/i);
      assert.deepEqual(await sourceTree(f.home), before);
      await writeFile(
        join(directory, "Malformed.jsonl"),
        JSON.stringify(header) + "\n{broken native record\n",
      );
      await assert.rejects(
        f.reader.read(f.id, f.options),
        /native child 'Malformed'.*malformed.*refusing partial/i,
      );
      await rm(join(directory, "Malformed.jsonl"));
      await writeFile(
        join(directory, "Unreadable.jsonl"),
        JSON.stringify(message("no-header", null, "user", "missing native session header")) + "\n",
      );
      await assert.rejects(
        f.reader.read(f.id, f.options),
        /native child 'Unreadable'.*unreadable.*refusing partial/i,
      );
    } finally {
      await f.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  "OMP superseded unanswered requests stay separate while native early and active steers retain their run through CLI and real T3",
  {
    skip: skip || !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
    timeout: 90_000,
  },
  async () => {
    const at = (seconds: number) => new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
    const timed = (entry: ReturnType<typeof message>, seconds: number) => ({
      ...entry,
      timestamp: at(seconds),
      message: { ...entry.message, timestamp: Date.parse(at(seconds)) },
    });
    const f = await fixture(
      [
        timed(message("unanswered", null, "user", "Initial request"), 0),
        {
          type: "compaction",
          id: "compact",
          parentId: "unanswered",
          timestamp: at(60),
          summary: "Native compaction before any recorded response",
          firstKeptEntryId: "unanswered",
          tokensBefore: 100,
        },
        timed(message("replacement", "compact", "user", "New request"), 61),
        timed(
          message(
            "call",
            "replacement",
            "assistant",
            [
              {
                type: "toolCall",
                id: "command",
                name: "bash",
                arguments: { command: "echo done" },
              },
            ],
            { stopReason: "toolUse" },
          ),
          62,
        ),
        timed(message("active-steer", "call", "user", "Legacy active steer without a flag"), 63),
        timed(
          message("result", "active-steer", "toolResult", "done", {
            toolCallId: "command",
            toolName: "bash",
            isError: false,
          }),
          61,
        ),
        timed(message("answer", "result", "assistant", "Answer after actual work"), 65),
        timed(message("next", "answer", "user", "Next request"), 70),
        timed(
          message("early-steer", "next", "user", "Explicit native early steer", { steering: true }),
          71,
        ),
        timed(
          message("next-answer", "early-steer", "assistant", [
            { type: "thinking", thinking: "Recorded work after early steering" },
            { type: "text", text: "Final answer" },
          ]),
          72,
        ),
      ],
      { id: "91230000-5555-4555-8555-555555555555" },
    );
    const target = await mkdtemp(join(tmpdir(), "t3-omp-unanswered-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const history = await f.reader.read(f.id, f.options);
      assert.deepEqual(
        history.turns.map((turn) => turn.status),
        ["interrupted", "completed", "completed"],
      );
      assert.deepEqual(
        history.turns.map((turn) => turn.id),
        ["unanswered", "replacement", "next"],
      );
      assert.equal(history.turns[0]!.completedAt, timestamp);
      assert.match(history.warnings.join(" "), /superseded_unanswered_request/);
      await initializeNativeTarget(target, 96);
      await writeFile(
        join(target, "userdata/settings.json"),
        JSON.stringify({ providerInstances: { pi: { driver: "pi", enabled: false } } }),
      );
      const args = [
        "import",
        "--source",
        "omp",
        "--source-home",
        f.home,
        "--workspace",
        f.workspace,
        "--omp-package",
        packageRoot!,
        "--thread",
        f.id,
        "--t3-home",
        target,
        "--no-resume",
        "--yes",
        "--json",
      ];
      const cli = (...command: string[]) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"), ...command],
            { encoding: "utf8", timeout: 30_000 },
          ),
        );
      const imported = cli(...args);
      assert.match(imported.results[0].warnings.join(" "), /tool.*end.*before.*start/i);
      assert.deepEqual(
        history.nativeMetadata!.find(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            entry.type === "omp_tool_clock_skew",
        ),
        {
          type: "omp_tool_clock_skew",
          uuid: "result",
          mappedItemId: "call:0",
          startedAt: at(62),
          completedAt: at(61),
        },
      );
      assert.equal(cli(...args).results[0].status, "already-imported");
      server = await startIsolatedT3Server({ t3Home: target });
      const { projection } = await server.request<{
        projection: {
          runs: Array<{ id: string; status: string; startedAt: string; completedAt: string }>;
          turnItems: Array<{
            type: string;
            text?: string;
            inputIntent?: string;
            runId: string | null;
          }>;
        };
      }>(`/api/orchestration/threads/${encodeURIComponent(imported.results[0].threadId)}`);
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["interrupted", "completed", "completed"],
      );
      assert.deepEqual(
        projection.runs.map((run) => Date.parse(run.completedAt) - Date.parse(run.startedAt)),
        [0, 4_000, 2_000],
      );
      assert.deepEqual(
        projection.turnItems
          .filter((item) => item.type === "user_message")
          .map((item) => [item.text, item.inputIntent]),
        [
          ["Initial request", "turn_start"],
          ["New request", "turn_start"],
          ["Legacy active steer without a flag", "steer"],
          ["Next request", "turn_start"],
          ["Explicit native early steer", "steer"],
        ],
      );
      assert.equal(projection.turnItems.find((item) => item.type === "compaction")!.runId, null);
      assert.ok(!projection.turnItems.some((item) => item.type === "run_interrupt_result"));
    } finally {
      await server?.stop();
      await f.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  "OMP idle metadata preserves its time without extending completed work through the CLI and real T3 server",
  {
    skip: skip || !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
    timeout: 90_000,
  },
  async () => {
    const at = (seconds: number) => new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
    const timed = (entry: ReturnType<typeof message>, seconds: number) => ({
      ...entry,
      timestamp: at(seconds),
      message: { ...entry.message, timestamp: Date.parse(at(seconds)) },
    });
    const f = await fixture([
      timed(message("u1", null, "user", "First request"), 0),
      timed(
        message(
          "call",
          "u1",
          "assistant",
          [{ type: "toolCall", id: "command", name: "bash", arguments: { command: "echo done" } }],
          { stopReason: "toolUse" },
        ),
        1,
      ),
      timed(
        message("result", "call", "toolResult", "done", {
          toolCallId: "command",
          toolName: "bash",
          isError: false,
        }),
        2,
      ),
      timed(message("a1", "result", "assistant", "First answer"), 96),
      {
        type: "compaction",
        id: "idle-compact",
        parentId: "a1",
        timestamp: at(172800),
        summary: "Compacted while idle",
        firstKeptEntryId: "u1",
        tokensBefore: 100,
      },
      {
        type: "model_change",
        id: "idle-model",
        parentId: "idle-compact",
        timestamp: at(172801),
        role: "temporary",
        model: "openai/native-next",
      },
      {
        type: "custom_message",
        id: "idle-background",
        parentId: "idle-model",
        timestamp: at(172802),
        customType: "async-result",
        content:
          "<system-notice>\nBackground job bg_3 has completed. Resume your work using the result below.\nRecorded output\n</system-notice>",
        display: true,
        details: { jobs: [{ jobId: "bg_3", type: "bash" }] },
      },
      {
        type: "custom_message",
        id: "idle-irc",
        parentId: "idle-background",
        timestamp: at(172803),
        customType: "irc:incoming",
        content: "<irc>\nIncoming IRC message from agent Reviewer\nRecorded peer message\n</irc>",
        display: true,
        details: { from: "Reviewer", message: "Recorded peer message" },
      },
      timed(message("u2", "idle-irc", "user", "Second request"), 172860),
      timed(
        message("file", "u2", "fileMention", undefined, {
          files: [{ path: "notes.md", content: "Recorded notes", lineCount: 1 }],
        }),
        172861,
      ),
      timed(message("a2", "file", "assistant", "Second answer"), 172920),
      {
        type: "model_change",
        id: "tail-model",
        parentId: "a2",
        timestamp: at(259200),
        role: "temporary",
        model: "openai/native-tail",
      },
    ]);
    const target = await mkdtemp(join(tmpdir(), "t3-omp-idle-timing-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const history = await f.reader.read(f.id, f.options);
      assert.equal(history.turns.length, 2);
      assert.equal(history.turns[0]!.completedAt, "2026-01-01T00:01:36.000Z");
      assert.equal(history.turns[1]!.completedAt, "2026-01-03T00:02:00.000Z");
      await initializeNativeTarget(target, 96);
      await writeFile(
        join(target, "userdata/settings.json"),
        JSON.stringify({ providerInstances: { pi: { driver: "pi", enabled: false } } }),
      );
      const imported = JSON.parse(
        execFileSync(
          process.execPath,
          [
            resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"),
            "import",
            "--source",
            "omp",
            "--source-home",
            f.home,
            "--workspace",
            f.workspace,
            "--omp-package",
            packageRoot!,
            "--thread",
            f.id,
            "--t3-home",
            target,
            "--no-resume",
            "--yes",
            "--json",
          ],
          { encoding: "utf8", timeout: 30_000 },
        ),
      );
      server = await startIsolatedT3Server({ t3Home: target });
      const path = `/api/orchestration/threads/${encodeURIComponent(imported.results[0].threadId)}`;
      const { projection } = await server.request<{
        projection: {
          runs: Array<{ startedAt: string; completedAt: string }>;
          providerTurns: Array<{ startedAt: string; completedAt: string }>;
          turnItems: Array<{
            type: string;
            startedAt: string;
            runId: string | null;
            nodeId: string | null;
            providerTurnId: string | null;
            level?: string;
            message?: string;
          }>;
        };
      }>(path);
      assert.deepEqual(
        projection.runs.map((run) => Date.parse(run.completedAt) - Date.parse(run.startedAt)),
        [96_000, 60_000],
      );
      assert.equal(
        projection.providerTurns.length,
        2,
        "idle model changes do not create executed model sections",
      );
      const metadata = projection.turnItems
        .filter((item) => item.type === "compaction" || item.type === "system_notice")
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      assert.equal(metadata.length, 6);
      assert.deepEqual(
        metadata.filter((item) => item.type === "system_notice").map((item) => item.level),
        ["info", "info", "info", "info", "info"],
      );
      assert.deepEqual(
        metadata.filter((item) => item.runId === null).map((item) => item.startedAt),
        [at(172800), at(172801), at(172802), at(172803), at(259200)],
      );
      assert.deepEqual(
        metadata.slice(2, 5).map((item) => item.message),
        [
          "Background job completed: bg_3\n\nRecorded output",
          "Message from Reviewer\n\nRecorded peer message",
          "Read notes.md",
        ],
      );
      assert.ok(
        metadata
          .filter((item) => item.runId === null)
          .every((item) => item.nodeId === null && item.providerTurnId === null),
        "idle metadata stays outside completed response activity",
      );
    } finally {
      await server?.stop();
      await f.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  "OMP native reader selects active branch, title slot and blob images without rewriting source",
  { skip },
  async () => {
    const f = await fixture([]);
    try {
      const payloads = JSON.parse(
        execFileSync("bun", [resolve("native/omp-fixture.ts"), "payloads", packageRoot!, f.home], {
          encoding: "utf8",
        }),
      ) as { titleSlot: string; blobRef: string };
      const entries = [
        { type: "session", id: f.id, version: 3, timestamp, cwd: f.workspace },
        message("root", null, "user", [
          { type: "text", text: "Fixture question" },
          { type: "image", mimeType: "image/png", data: payloads.blobRef },
        ]),
        message("abandoned", "root", "assistant", "Abandoned answer"),
        message("selected", "root", "assistant", "Selected answer"),
        {
          type: "custom",
          id: "late",
          parentId: "abandoned",
          activeLeafId: "selected",
          timestamp,
          customType: "fixture",
          data: {},
        },
      ];
      await writeFile(
        f.path,
        payloads.titleSlot + entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      const before = await hash(f.path);
      const beforeFiles = await readdir(join(f.home, "sessions", "fixture"));
      const link = join(f.home, "workspace-link");
      await symlink(f.workspace, link, "dir");
      const beforeTree = await sourceTree(f.home);
      const list = await f.reader.list({ ...f.options, workspace: link });
      assert.equal(list.length, 1);
      assert.equal(list[0]!.title, "Native title slot");
      const result = await f.reader.read(f.id, f.options);
      assert.equal(result.active, false);
      assert.equal(result.title, "Native title slot");
      assert.equal(result.nativeSessionRef, await realpath(f.path));
      assert.equal(result.sourceHome, await realpath(f.home));
      assert.equal(result.driver, "pi");
      assert.equal(result.model, "openai/native-test");
      assert.deepEqual(
        result.turns.flatMap((turn) => turn.items.map((item) => item.data.text)),
        ["Fixture question", "Selected answer"],
      );
      assert.equal(
        result.turns[0]!.items[0]!.images![0]!.base64,
        Buffer.from("native-omp-image-fixture").toString("base64"),
      );
      assert.match(result.warnings.join(" "), /selected active branch/);
      assert.equal(await hash(f.path), before);
      assert.deepEqual(await readdir(join(f.home, "sessions", "fixture")), beforeFiles);
      assert.deepEqual(await sourceTree(f.home), beforeTree);
    } finally {
      await f.close();
    }
  },
);

test(
  "OMP keeps native tool loops, steers, thinking, compaction, custom requests and aborted turns",
  { skip },
  async () => {
    const f = await fixture([
      message("u1", null, "user", "First question"),
      message(
        "a1",
        "u1",
        "assistant",
        [
          { type: "thinking", thinking: "Visible reasoning" },
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "printf fixture" },
          },
        ],
        { stopReason: "toolUse" },
      ),
      message("steer", "a1", "user", "Same-turn steer"),
      message("result", "steer", "toolResult", "Complete command output", {
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        details: { exitCode: 0 },
      }),
      message("a2", "result", "assistant", "Finished first question"),
      {
        type: "compaction",
        id: "compact",
        parentId: "a2",
        timestamp,
        summary: "Native compaction",
        firstKeptEntryId: "u1",
        tokensBefore: 100,
      },
      {
        type: "custom_message",
        id: "custom-user",
        parentId: "compact",
        timestamp,
        customType: "skill-prompt",
        content: "User extension question",
        display: true,
        attribution: "user",
      },
      message("abort", "custom-user", "assistant", "Interrupted response", {
        stopReason: "aborted",
        errorMessage: "Cancelled by user",
      }),
    ]);
    try {
      const before = await hash(f.path);
      const result = await f.reader.read(f.id, f.options);
      assert.equal(result.active, false);
      assert.equal(result.turns.length, 2);
      assert.equal(result.turns[1]!.status, "interrupted");
      assert.equal(result.turns[0]!.items.filter((item) => item.kind === "user_message").length, 2);
      const command = result.turns[0]!.items.find((item) => item.kind === "command_execution")!;
      assert.equal(command.data.input, "printf fixture");
      assert.equal(command.data.output, "Complete command output");
      assert.equal(command.data.exitCode, 0);
      assert.equal(command.status, "completed");
      assert.equal(
        result.turns[0]!.items.find((item) => item.kind === "reasoning")!.data.text,
        "Visible reasoning",
      );
      assert.equal(
        result.turns[0]!.items.find((item) => item.kind === "compaction")!.data.summary,
        "Native compaction",
      );
      assert.equal(result.turns[1]!.items[0]!.kind, "user_message");
      assert.equal(await hash(f.path), before);
    } finally {
      await f.close();
    }
  },
);

test(
  "OMP marks incomplete tails active and imports native process-exit tails as interrupted",
  { skip },
  async () => {
    for (const exited of [false, true]) {
      const entries = [
        message("user", null, "user", "Question"),
        message(
          "tool",
          "user",
          "assistant",
          [{ type: "toolCall", id: "pending-1", name: "read", arguments: { path: "fixture" } }],
          { stopReason: "toolUse" },
        ),
        ...(exited
          ? [
              {
                type: "custom",
                id: "exit",
                parentId: "tool",
                timestamp,
                customType: "session_exit",
                data: { reason: "fixture exit", kind: "normal", recordedAt: timestamp },
              },
            ]
          : []),
      ];
      const f = await fixture(entries);
      try {
        const result = await f.reader.read(f.id, f.options);
        assert.equal(result.active, !exited);
        assert.equal(result.turns[0]!.status, "interrupted");
        assert.equal(
          result.turns[0]!.items.find((item) => item.kind === "dynamic_tool")!.status,
          "interrupted",
        );
        assert.match(result.warnings.join(" "), exited ? /process exit/ : /incomplete turn/);
      } finally {
        await f.close();
      }
    }
  },
);

test(
  "OMP refuses malformed or future sessions and lists an absent cold archive as empty",
  { skip },
  async () => {
    for (const options of [{ version: 99 }, { suffix: "{invalid-json\n" }]) {
      const f = await fixture(
        [message("u", null, "user", "Question"), message("a", "u", "assistant", "Answer")],
        options,
      );
      try {
        await assert.rejects(f.reader.read(f.path, f.options), /newer|malformed/);
      } finally {
        await f.close();
      }
    }
    const f = await fixture([]);
    try {
      assert.deepEqual(await f.reader.list({ ...f.options, archived: true }), []);
    } finally {
      await f.close();
    }
  },
);

test("OMP helper detects native session ownership without taking the lease", { skip }, async () => {
  const f = await fixture([
    message("u", null, "user", "Question"),
    message("a", "u", "assistant", "Answer"),
  ]);
  const child = spawn(
    "bun",
    [resolve("native/omp-fixture.ts"), "lease", packageRoot!, f.home, f.id],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const previous = process.env.PI_TEST_SESSION_OWNERS_DIR;
  try {
    await once(child.stdout!, "data");
    process.env.PI_TEST_SESSION_OWNERS_DIR = join(f.home, "test-owners");
    const result = await f.reader.read(f.id, f.options);
    assert.equal(result.active, true);
    assert.match(result.warnings.join(" "), /native session ownership/);
  } finally {
    if (previous === undefined) delete process.env.PI_TEST_SESSION_OWNERS_DIR;
    else process.env.PI_TEST_SESSION_OWNERS_DIR = previous;
    child.kill("SIGTERM");
    await once(child, "close");
    await f.close();
  }
});

test("OMP package discovery rejects a source package with unvalidated native APIs", async () => {
  const home = await mkdtemp(join(tmpdir(), "t3-omp-package-"));
  try {
    await writeFile(
      join(home, "package.json"),
      JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "99.0.0" }),
    );
    await assert.rejects(resolveOmpPackage({ ompPackage: home }), /not validated/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "OMP missing blob references remain visible on image-only historical messages",
  { skip },
  async () => {
    const ref = `blob:sha256:${"a".repeat(64)}`;
    const f = await fixture([
      message("u", null, "user", [{ type: "image", mimeType: "image/png", data: ref }]),
      message("a", "u", "assistant", "Answer"),
    ]);
    try {
      const beforeTree = await sourceTree(f.home);
      const result = await f.reader.read(f.id, f.options);
      assert.deepEqual(await sourceTree(f.home), beforeTree);
      assert.match(String(result.turns[0]!.items[0]!.data.text), /Unavailable image: blob:sha256:/);
      assert.match(result.warnings.join(" "), /missing from the native blob store/);
      assert.equal(result.turns[0]!.items[0]!.images, undefined);
    } finally {
      await f.close();
    }
  },
);

test(
  "OMP native source to T3 writer imports branch, blob and compaction with no effects; re-reading is idempotent",
  { skip },
  async () => {
    const f = await fixture([]);
    const target = await mkdtemp(join(tmpdir(), "t3-omp-target-"));
    try {
      const payloads = JSON.parse(
        execFileSync("bun", [resolve("native/omp-fixture.ts"), "payloads", packageRoot!, f.home], {
          encoding: "utf8",
        }),
      ) as { titleSlot: string; blobRef: string };
      const entries = [
        { type: "session", id: f.id, version: 3, timestamp, cwd: f.workspace },
        message("u", null, "user", [
          { type: "text", text: "Native source question" },
          { type: "image", mimeType: "image/png", data: payloads.blobRef },
        ]),
        message("abandoned", "u", "assistant", "Do not import this alternative"),
        message(
          "tool",
          "u",
          "assistant",
          [
            { type: "thinking", thinking: "Native reasoning" },
            {
              type: "toolCall",
              id: "call",
              name: "bash",
              arguments: { command: "printf synthetic" },
            },
          ],
          { stopReason: "toolUse" },
        ),
        message("result", "tool", "toolResult", "Native result", {
          toolCallId: "call",
          toolName: "bash",
          isError: false,
          details: { exitCode: 0 },
        }),
        message("a", "result", "assistant", "Native final answer"),
        {
          type: "compaction",
          id: "compact",
          parentId: "a",
          timestamp,
          summary: "Native retained compaction",
          firstKeptEntryId: "u",
          tokensBefore: 100,
        },
        {
          type: "custom",
          id: "late",
          parentId: "abandoned",
          activeLeafId: "compact",
          timestamp,
          customType: "fixture",
          data: {},
        },
      ];
      await writeFile(
        f.path,
        payloads.titleSlot + entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      const sourceHash = await hash(f.path);
      await initializeNativeTarget(target);
      const source = await f.reader.read(f.id, f.options);
      const first = await importNativeConversations([source], {
        t3Home: target,
        dryRun: false,
        resume: false,
      });
      assert.equal(first.status, "imported");
      assert.equal(first.results[0]!.resumable, false);
      const db = new DatabaseSync(join(target, "userdata/statev2.sqlite"), { readOnly: true });
      const count = (table: string) =>
        Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
      let events: number;
      try {
        assert.equal(count("orchestration_v2_projection_threads"), 1);
        assert.equal(count("orchestration_v2_projection_runs"), 1);
        assert.equal(count("orchestration_v2_projection_run_attempts"), 1);
        assert.equal(count("orchestration_v2_projection_provider_turns"), 1);
        assert.equal(count("orchestration_v2_effect_outbox"), 0);
        assert.equal(count("orchestration_v2_projection_checkpoints"), 0);
        assert.equal(count("provider_session_runtime"), 0);
        assert.equal(
          count("orchestration_v2_projection_turn_items"),
          source.turns[0]!.items.length,
        );
        const rows = db
          .prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items")
          .all();
        const serialized = JSON.stringify(rows);
        assert.match(serialized, /Native retained compaction/);
        assert.match(serialized, /Native result/);
        assert.doesNotMatch(serialized, /Do not import this alternative/);
        events = count("orchestration_events");
      } finally {
        db.close();
      }
      assert.equal(
        (await readdir(join(target, "userdata/attachments"))).filter((path) =>
          path.endsWith(".png"),
        ).length,
        1,
      );
      const targetHash = await hash(join(target, "userdata/statev2.sqlite"));
      const reread = await f.reader.read(f.id, f.options);
      const second = await importNativeConversations([reread], {
        t3Home: target,
        dryRun: false,
        resume: false,
      });
      assert.equal(second.status, "already-imported");
      assert.equal(await hash(join(target, "userdata/statev2.sqlite")), targetHash);
      const check = new DatabaseSync(join(target, "userdata/statev2.sqlite"), { readOnly: true });
      try {
        assert.equal(
          Number(check.prepare("SELECT COUNT(*) AS n FROM orchestration_events").get()!.n),
          events!,
        );
      } finally {
        check.close();
      }
      assert.equal(await hash(f.path), sourceHash);
    } finally {
      await f.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  "OMP history retains the actual model of every assistant response across switches inside one user turn",
  { skip },
  async () => {
    const f = await fixture([
      {
        type: "model_change",
        id: "configured",
        parentId: null,
        timestamp,
        role: "default",
        model: "openai-codex/gpt-6.1-sol",
      },
      message("u", "configured", "user", "Synthetic multi-model request"),
      message(
        "a1",
        "u",
        "assistant",
        [
          { type: "text", text: "First response" },
          { type: "toolCall", id: "hop-tool", name: "read", arguments: { path: "synthetic" } },
        ],
        { provider: "openai-codex", model: "gpt-6.1-sol", stopReason: "toolUse" },
      ),
      message("result", "a1", "toolResult", "Synthetic result", {
        toolCallId: "hop-tool",
        toolName: "read",
        isError: false,
      }),
      {
        type: "model_change",
        id: "switch",
        parentId: "result",
        timestamp,
        role: "temporary",
        model: "opencode-go/deepseek-v4.1-flash",
      },
      message("a2", "switch", "assistant", "Second response", {
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
      }),
    ]);
    try {
      const result = await f.reader.read(f.id, f.options);
      assert.equal(result.turns.length, 1);
      assert.equal(result.turns[0]!.model, "openai-codex/gpt-6.1-sol");
      assert.deepEqual(
        result.turns[0]!.items.filter((item) => item.kind === "assistant_message").map(
          (item) => item.model,
        ),
        ["openai-codex/gpt-6.1-sol", "opencode-go/deepseek-v4.1-flash"],
      );
      const switches = result.turns[0]!.items.filter(
        (item) =>
          item.kind === "system_notice" &&
          item.data.nativeContent &&
          typeof item.data.nativeContent === "object" &&
          !Array.isArray(item.data.nativeContent) &&
          item.data.nativeContent.type === "model_change",
      );
      assert.equal(switches.length, 2);
      assert.equal(switches[1]!.model, "opencode-go/deepseek-v4.1-flash");
      assert.equal(result.model, "opencode-go/deepseek-v4.1-flash");
    } finally {
      await f.close();
    }
  },
);

test("OMP continuation model follows the native restorable role selection", { skip }, async () => {
  const f = await fixture([
    {
      type: "model_change",
      id: "default",
      parentId: null,
      timestamp,
      role: "default",
      model: "openai-codex/gpt-6.1-sol",
    },
    message("u", "default", "user", "Synthetic native role selection"),
    {
      type: "model_change",
      id: "temporary",
      parentId: "u",
      timestamp,
      role: "temporary",
      model: "opencode-go/deepseek-v4.1-flash",
    },
    message("a", "temporary", "assistant", "Response", {
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
    }),
  ]);
  try {
    const result = await f.reader.read(f.id, f.options);
    assert.equal(result.model, "opencode-go/deepseek-v4.1-flash");
  } finally {
    await f.close();
  }
});

test(
  "OMP history follows native transcript classification and hides bookkeeping while preserving visible skill requests and provenance",
  { skip },
  async () => {
    const f = await fixture([
      {
        type: "model_change",
        id: "model",
        parentId: null,
        timestamp,
        role: "default",
        model: "openai/native-test",
      },
      message("u", "model", "user", "Visible user request"),
      {
        type: "custom",
        id: "bookkeeping",
        parentId: "u",
        timestamp,
        customType: "tool_execution_start",
        data: {
          toolCallId: "read-1",
          toolName: "read",
          args: { path: "synthetic" },
          startedAt: timestamp,
        },
      },
      {
        type: "custom_message",
        id: "visible",
        parentId: "bookkeeping",
        timestamp,
        customType: "extension-note",
        content: "Visible extension note",
        display: true,
      },
      message("a", "visible", "assistant", "Visible answer"),
      {
        type: "custom_message",
        id: "hidden",
        parentId: "a",
        timestamp,
        customType: "extension-metadata",
        content: "Hidden extension metadata",
        display: false,
      },
      {
        type: "compaction",
        id: "compact",
        parentId: "hidden",
        timestamp,
        summary: "Visible compaction",
        firstKeptEntryId: "u",
        tokensBefore: 100,
      },
      {
        type: "custom_message",
        id: "skill",
        parentId: "compact",
        timestamp,
        customType: "skill-prompt",
        content: "Visible skill request",
        display: true,
        attribution: "user",
      },
      message("skill-answer", "skill", "assistant", "Visible skill answer"),
    ]);
    try {
      const result = await f.reader.read(f.id, f.options);
      const items = result.turns.flatMap((turn) => turn.items);
      assert.equal(
        items.some((item) => item.id === "bookkeeping"),
        false,
      );
      assert.equal(
        items.some((item) => item.id === "hidden"),
        false,
      );
      assert.deepEqual(
        items.filter((item) => item.kind === "user_message").map((item) => item.data.text),
        ["Visible user request", "Visible skill request"],
      );
      assert.ok(items.some((item) => item.data.message === "Visible extension note"));
      assert.ok(
        items.some(
          (item) => item.kind === "compaction" && item.data.summary === "Visible compaction",
        ),
      );
      assert.ok(items.some((item) => item.id === "model" && item.model === "openai/native-test"));
    } finally {
      await f.close();
    }
  },
);
