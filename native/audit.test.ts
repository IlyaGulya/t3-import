import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as EventSink from "@t3-native/server/orchestration-v2/EventSink.ts";
import * as EventStore from "@t3-native/server/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "@t3-native/server/orchestration-v2/ProjectionStore.ts";
import {
  initializeNativeTarget,
  importNativeConversations,
  readNativeImportAudit,
} from "./target.ts";
import { startIsolatedT3Server } from "./server.ts";
import type { NativeConversation } from "../src/native/types.js";

const at = "2026-01-01T00:00:00.000Z";
const ended = "2026-01-01T00:00:05.000Z";
const binary = process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3", "bin", "t3");
const hasServer = existsSync(binary);
const completeOutput = "Complete recorded command output\n".repeat(2000);

function conversation(home: string): NativeConversation {
  const root: NativeConversation = {
    source: "codex",
    driver: "codex",
    id: "audit-root",
    nativeSessionRef: "audit-root",
    title: "Import audit fixture",
    workspace: home,
    createdAt: at,
    updatedAt: ended,
    model: "native-fixture-model",
    active: false,
    warnings: ["Fixture source has no historical per-turn model provenance."],
    turns: [
      {
        id: "turn",
        status: "completed",
        startedAt: at,
        completedAt: ended,
        items: [
          {
            id: "user",
            kind: "user_message",
            timestamp: at,
            status: "completed",
            data: { text: "Keep the entire history", nativeContent: { retainedOpaque: true } },
            images: [
              {
                id: "picture",
                name: "picture.png",
                mimeType: "image/png",
                base64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCboAAAAASUVORK5CYII=",
              },
            ],
          },
          {
            id: "tool",
            kind: "command_execution",
            timestamp: at,
            status: "completed",
            data: { input: "echo recorded", output: completeOutput, exitCode: 0 },
          },
          {
            id: "assistant",
            kind: "assistant_message",
            timestamp: ended,
            status: "completed",
            data: { text: "Unchanged historical answer", phase: "final_answer" },
          },
        ],
      },
    ],
  };
  root.children = [
    {
      ...root,
      id: "audit-child",
      nativeSessionRef: "audit-child",
      title: "Audit native child",
      warnings: [],
      parent: { sourceId: root.id, nativeItemId: "tool" },
      resumeSupported: false,
      turns: [
        {
          id: "child-turn",
          status: "completed",
          startedAt: at,
          completedAt: ended,
          items: [
            {
              id: "child-user",
              kind: "user_message",
              timestamp: at,
              status: "completed",
              data: { text: "Child request" },
            },
            {
              id: "child-answer",
              kind: "assistant_message",
              timestamp: ended,
              status: "completed",
              data: { text: "Child answer" },
            },
          ],
        },
      ],
    },
  ];
  return root;
}

async function importedFixture() {
  const home = mkdtempSync(join(tmpdir(), "t3-native-audit-"));
  try {
    await initializeNativeTarget(home, 96);
    writeFileSync(
      join(home, "userdata/settings.json"),
      JSON.stringify({
        providerInstances: {
          codex: { driver: "codex", enabled: false },
          claudeAgent: { driver: "claudeAgent", enabled: false },
          pi: { driver: "pi", enabled: false },
        },
      }),
    );
    const imported = await importNativeConversations([conversation(home)], {
      t3Home: home,
      dryRun: false,
      resume: false,
    });
    return { home, threadId: imported.results[0]!.threadId };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

function cliAudit(
  home: string,
  threadId: string,
  server: Awaited<ReturnType<typeof startIsolatedT3Server>>,
  ...args: string[]
) {
  return spawnSync(
    process.execPath,
    [
      resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"),
      "audit",
      "--t3-home",
      home,
      "--thread",
      threadId,
      "--server",
      server.origin,
      "--json",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 45_000,
      env: { ...process.env, T3_IMPORT_AUDIT_TOKEN: server.accessTokenForAudit(), NO_COLOR: "1" },
    },
  );
}

test(
  "CLI audit verifies a real T3 family, hydrates omitted tool bodies and reports retained opaque metadata",
  { skip: !hasServer, timeout: 90_000 },
  async () => {
    const f = await importedFixture();
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      server = await startIsolatedT3Server({ t3Home: f.home });
      const result = cliAudit(f.home, f.threadId, server);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "verified-with-limitations");
      assert.equal(report.threads.length, 2);
      assert.equal(report.threads[0].dimensions.thread.verified, 1);
      assert.equal(report.threads[0].dimensions.providerThreads.verified, 1);
      assert.equal(report.threads[0].dimensions.project.verified, 1);
      assert.ok(report.threads[0].escrowedFields > 0, "unknown schema fields survive in metadata");
      assert.ok(
        report.threads[0].dimensions.details.verified > 0,
        "tool bodies are verified through native RPC",
      );
      assert.ok(
        !report.issues.some((issue: { code: string }) => /missing|changed|loss/.test(issue.code)),
      );
      assert.ok(!result.stdout.includes(server.accessTokenForAudit()));

      const scoped = cliAudit(f.home, f.threadId, server, "--no-family");
      assert.equal(scoped.status, 0, scoped.stdout + scoped.stderr);
      const scopedReport = JSON.parse(scoped.stdout);
      assert.equal(scopedReport.scope, "thread");
      assert.equal(scopedReport.threads.length, 1);

      const structure = cliAudit(f.home, f.threadId, server, "--structure-only");
      assert.notEqual(structure.status, 0);
      const structureReport = JSON.parse(structure.stdout);
      assert.equal(structureReport.status, "partial");
      assert.ok(structureReport.threads[0].dimensions.details.skipped > 0);

      const asset = readNativeImportAudit(f.home, f.threadId).assets[0]!;
      writeFileSync(join(f.home, "userdata/attachments", asset.name), "changed image bytes");
      const corrupted = cliAudit(f.home, f.threadId, server);
      assert.notEqual(corrupted.status, 0);
      const corruptReport = JSON.parse(corrupted.stdout);
      assert.equal(corruptReport.status, "failed");
      assert.ok(
        corruptReport.issues.some((issue: { code: string }) => issue.code === "asset_changed"),
      );
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
    }
  },
);

test(
  "CLI audit detects changed messages and hydrated tool bodies even when record counts are unchanged",
  { skip: !hasServer, timeout: 90_000 },
  async () => {
    const f = await importedFixture();
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const layer = EventSink.layer.pipe(
        Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provide(NodeSqlite.layer({ filename: join(f.home, "userdata/statev2.sqlite") })),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const sink = yield* EventSink.EventSinkV2;
          const threadId = ThreadId.make(f.threadId);
          const thread = yield* store.getThread(threadId);
          const records = yield* store.getThreadRecords(threadId, ["messages", "turnItems"]);
          const message = records.messages.find((row) => row.role === "assistant");
          const tool = records.turnItems.find((row) => row.type === "command_execution");
          assert.ok(message);
          assert.ok(tool && tool.type === "command_execution");
          yield* sink.write({
            events: [
              {
                id: EventId.make("audit-test:changed-thread-metadata"),
                threadId,
                type: "thread.metadata-updated",
                occurredAt: DateTime.makeUnsafe(ended),
                payload: {
                  ...thread,
                  title: "Changed thread title",
                  worktreePath: join(f.home, "wrong-worktree"),
                },
              },
              {
                id: EventId.make("audit-test:changed-message"),
                threadId,
                type: "message.updated",
                occurredAt: DateTime.makeUnsafe(ended),
                payload: { ...message, text: "Changed historical answer" },
              },
              {
                id: EventId.make("audit-test:changed-tool-body"),
                threadId,
                type: "turn-item.updated",
                occurredAt: DateTime.makeUnsafe(ended),
                payload: { ...tool, output: completeOutput.slice(0, -1) + "!" },
              },
            ],
          });
        }).pipe(Effect.provide(layer)),
      );
      server = await startIsolatedT3Server({ t3Home: f.home });
      const result = cliAudit(f.home, f.threadId, server);
      assert.notEqual(result.status, 0);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "failed");
      const root = report.threads.find(
        (thread: { threadId: string }) => thread.threadId === f.threadId,
      );
      assert.equal(root.dimensions.messages.expected, root.dimensions.messages.actual);
      assert.equal(root.dimensions.messages.changed, 1);
      assert.equal(root.dimensions.thread.changed, 1);
      assert.equal(root.dimensions.turnItems.expected, root.dimensions.turnItems.actual);
      assert.equal(root.dimensions.details.changed, 1);
      assert.ok(report.issues.some((issue: { code: string }) => issue.code === "detail_changed"));
    } finally {
      await server?.stop();
      rmSync(f.home, { recursive: true, force: true });
    }
  },
);

test("CLI audit rejects remote and credential-bearing origins without exposing secrets", () => {
  const home = mkdtempSync(join(tmpdir(), "t3-native-audit-origin-"));
  const secret = "audit-secret-must-stay-private";
  try {
    for (const origin of ["https://example.com", `http://name:${secret}@127.0.0.1:1`]) {
      const result = spawnSync(
        process.execPath,
        [
          resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"),
          "audit",
          "--t3-home",
          home,
          "--thread",
          "unused",
          "--server",
          origin,
          "--json",
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, T3_IMPORT_AUDIT_TOKEN: secret, NO_COLOR: "1" },
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /loopback/);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "CLI audit marks orphan native children as presentation review for every adapter",
  { skip: !hasServer, timeout: 120_000 },
  async () => {
    for (const source of ["codex", "claude", "omp"] as const) {
      const home = mkdtempSync(join(tmpdir(), "t3-audit-presentation-"));
      let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
      try {
        await initializeNativeTarget(home, 96);
        const root = conversation(home);
        root.source = source;
        root.driver = source === "claude" ? "claudeAgent" : source === "omp" ? "pi" : "codex";
        root.children![0]!.source = source;
        root.children![0]!.driver = root.driver;
        root.children![0]!.parent = { sourceId: root.id };
        const imported = await importNativeConversations([root], {
          t3Home: home,
          dryRun: false,
          resume: false,
        });
        server = await startIsolatedT3Server({ t3Home: home });
        const result = cliAudit(home, imported.results[0]!.threadId, server);
        assert.equal(result.status, 4, result.stdout + result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.status, "partial");
        assert.ok(
          report.issues.some(
            (issue: { code: string }) => issue.code === "presentation_unplaced_subagent",
          ),
        );
      } finally {
        await server?.stop();
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "CLI audit flags leaked command markup and neutral notices rendered as warnings",
  { skip: !hasServer, timeout: 60_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-audit-notices-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      await initializeNativeTarget(home, 96);
      const root = conversation(home);
      root.children = [];
      const notices = [
        { message: "<local-command-stdout>Status dialog dismissed</local-command-stdout>" },
        { message: "<system-notice>Recorded background activity</system-notice>" },
        { message: "No response requested." },
        { message: "OMP model changed (temporary): openai/native", level: "info" },
        { message: "Native provider rate limit", level: "error" },
      ];
      for (const [index, data] of notices.entries())
        root.turns[0]!.items.push({
          id: `notice:${index}`,
          kind: "system_notice",
          timestamp: ended,
          status: "completed",
          data: { message: data.message, ...(data.level ? { level: data.level } : {}) },
        });
      const imported = await importNativeConversations([root], {
        t3Home: home,
        dryRun: false,
        resume: false,
      });
      server = await startIsolatedT3Server({ t3Home: home });
      const result = cliAudit(home, imported.results[0]!.threadId, server);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(
        report.issues
          .filter((issue: { dimension: string }) => issue.dimension === "presentation")
          .map((issue: { code: string }) => issue.code)
          .sort(),
        [
          "presentation_local_command_markup",
          "presentation_neutral_notice_warning",
          "presentation_omp_notice_markup",
        ],
      );
      assert.equal(result.status, 4);
    } finally {
      await server?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "CLI audit flags an empty initial work segment despite matching stored hashes",
  { skip: !hasServer, timeout: 60_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-audit-empty-work-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      await initializeNativeTarget(home, 96);
      const root = conversation(home);
      delete root.children;
      root.turns[0]!.items.splice(
        1,
        0,
        {
          id: "compact",
          kind: "compaction",
          timestamp: at,
          status: "completed",
          data: { driver: "codex", summary: "Recorded compaction" },
        },
        {
          id: "steer",
          kind: "user_message",
          timestamp: at,
          status: "completed",
          data: { text: "Continue after compaction" },
        },
      );
      const imported = await importNativeConversations([root], {
        t3Home: home,
        dryRun: false,
        resume: false,
      });
      server = await startIsolatedT3Server({ t3Home: home });
      const result = cliAudit(home, imported.results[0]!.threadId, server);
      assert.equal(result.status, 4, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "partial");
      assert.ok(
        report.issues.some(
          (issue: { code: string }) => issue.code === "presentation_empty_initial_work",
        ),
      );
      assert.ok(
        !report.issues.some((issue: { code: string }) => /changed|missing/.test(issue.code)),
      );
    } finally {
      await server?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "CLI audit rejects a cancellation marker classified as a completed response",
  { skip: !hasServer, timeout: 60_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-audit-cancel-status-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      await initializeNativeTarget(home, 96);
      const root = conversation(home);
      delete root.children;
      root.turns[0]!.items.push({
        id: "abort",
        kind: "run_interrupt_result",
        timestamp: ended,
        status: "completed",
        data: { message: "Response interrupted by user" },
      });
      const imported = await importNativeConversations([root], {
        t3Home: home,
        dryRun: false,
        resume: false,
      });
      server = await startIsolatedT3Server({ t3Home: home });
      const result = cliAudit(home, imported.results[0]!.threadId, server);
      assert.equal(result.status, 4, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "failed");
      assert.ok(
        report.issues.some(
          (issue: { code: string }) => issue.code === "presentation_interrupted_run_completed",
        ),
      );
    } finally {
      await server?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "CLI audit marks a child attached after a final answer as presentation review",
  { skip: !hasServer, timeout: 60_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-audit-late-child-"));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      await initializeNativeTarget(home, 96);
      const root = conversation(home);
      root.children![0]!.parent = { sourceId: root.id, nativeItemId: "assistant" };
      const imported = await importNativeConversations([root], {
        t3Home: home,
        dryRun: false,
        resume: false,
      });
      server = await startIsolatedT3Server({ t3Home: home });
      const result = cliAudit(home, imported.results[0]!.threadId, server);
      assert.equal(result.status, 4, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "partial");
      assert.ok(
        report.issues.some(
          (issue: { code: string }) => issue.code === "presentation_late_subagent",
        ),
      );
    } finally {
      await server?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
