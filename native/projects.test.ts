import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { initializeNativeTarget } from "./target.ts";
import { startIsolatedT3Server } from "./server.ts";

const cliPath = resolve("dist/cli.js");
const codexPeer = resolve("native/codex-peer.mjs");
const timestamp = "2026-01-01T00:00:00.000Z";
const integrationSkip =
  process.platform === "win32"
    ? "Native source executable fixture uses a Unix shebang"
    : !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3"))
      ? "A real T3 server binary is not installed"
      : false;
function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
function sources(home: string, workspace: string, ompWorkspace = workspace) {
  const codex = join(home, "codex");
  mkdirSync(codex);
  const omp = join(home, "omp");
  mkdirSync(join(omp, "sessions/fixture"), { recursive: true });
  const ompId = randomUUID();
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const ompRows = [
    { type: "session", id: ompId, version: 3, timestamp, cwd: ompWorkspace },
    {
      type: "message",
      id: "u",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "Question" }],
        timestamp: Date.parse(timestamp),
      },
    },
    {
      type: "message",
      id: "a",
      parentId: "u",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
        timestamp: Date.parse(timestamp),
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        stopReason: "stop",
        usage,
      },
    },
  ];
  writeFileSync(
    join(omp, "sessions/fixture/session.jsonl"),
    ompRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const claude = join(home, "claude");
  const project = join(claude, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const claudeId = randomUUID();
  const common = {
    sessionId: claudeId,
    cwd: workspace,
    timestamp,
    isSidechain: false,
    version: "2.1.321",
  };
  const claudeRows = [
    {
      ...common,
      uuid: "u",
      parentUuid: null,
      type: "user",
      message: { role: "user", content: "Question" },
    },
    {
      ...common,
      uuid: "a",
      parentUuid: "u",
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Answer" }],
        stop_reason: "end_turn",
      },
    },
  ];
  writeFileSync(
    join(project, `${claudeId}.jsonl`),
    claudeRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  return [
    { source: "codex", home: codex, id: "session-1", extra: ["--binary", codexPeer] },
    { source: "omp", home: omp, id: ompId, extra: [] },
    { source: "claude", home: claude, id: claudeId, extra: [] },
  ];
}

test(
  "native CLI imports from all three harnesses share a project for the same canonical directory",
  { skip: integrationSkip, timeout: 90_000 },
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "t3-import-projects-")));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const workspace = join(home, "repo");
      mkdirSync(workspace);
      const alias = join(home, "repo-link");
      symlinkSync(workspace, alias, "dir");
      const target = join(home, "target");
      await initializeNativeTarget(target, 96);
      writeFileSync(
        join(target, "userdata/settings.json"),
        JSON.stringify({
          providerInstances: {
            codex: { driver: "codex", enabled: false },
            pi: { driver: "pi", enabled: false },
            claudeAgent: { driver: "claudeAgent", enabled: false },
          },
        }),
      );
      const results = sources(home, workspace, alias).map(
        (source) =>
          cli(
            "import",
            "--source",
            source.source,
            "--source-home",
            source.home,
            "--workspace",
            workspace,
            "--thread",
            source.id,
            ...source.extra,
            "--t3-home",
            target,
            "--no-resume",
            "--yes",
          ).results[0],
      );
      assert.equal(new Set(results.map((result) => result.projectId)).size, 1);
      const nested = join(workspace, "packages/app");
      mkdirSync(nested, { recursive: true });
      const extra = join(home, "extra-source");
      mkdirSync(extra);
      const separate = sources(extra, nested)[1]!;
      const distinct = cli(
        "import",
        "--source",
        separate.source,
        "--source-home",
        separate.home,
        "--workspace",
        nested,
        "--thread",
        separate.id,
        "--t3-home",
        target,
        "--no-resume",
        "--yes",
      ).results[0];
      assert.notEqual(
        distinct.projectId,
        results[0].projectId,
        "a nested directory is separate unless explicitly grouped",
      );
      assert.equal(cli("projects", "--t3-home", target).projects.length, 2);
      server = await startIsolatedT3Server({ t3Home: target });
      for (const result of results) {
        const {
          projection,
        }: { projection: { thread: { projectId: string }; messages: unknown[] } } =
          await server.request(`/api/orchestration/threads/${encodeURIComponent(result.threadId)}`);
        assert.equal(projection.thread.projectId, results[0].projectId);
        assert.equal(projection.messages.length, 2);
      }
    } finally {
      await server?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "explicit CLI project grouping keeps each session's working directory and is replay-safe",
  { skip: integrationSkip, timeout: 90_000 },
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "t3-import-project-selection-")));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const root = join(home, "repo");
      const workspace = join(root, "packages/app");
      mkdirSync(workspace, { recursive: true });
      const target = join(home, "target");
      await initializeNativeTarget(target, 96);
      writeFileSync(
        join(target, "userdata/settings.json"),
        JSON.stringify({
          providerInstances: {
            codex: { driver: "codex", enabled: false },
            pi: { driver: "pi", enabled: false },
            claudeAgent: { driver: "claudeAgent", enabled: false },
          },
        }),
      );
      const fixtures = sources(home, workspace);
      const importArgs = (index: number) => {
        const source = fixtures[index]!;
        return [
          "import",
          "--source",
          source.source,
          "--source-home",
          source.home,
          "--workspace",
          workspace,
          "--thread",
          source.id,
          ...source.extra,
          "--t3-home",
          target,
          "--no-resume",
          "--yes",
        ];
      };
      const missing = spawnSync(
        process.execPath,
        [cliPath, ...importArgs(0), "--project-id", "missing-project", "--json"],
        { encoding: "utf8" },
      );
      assert.notEqual(missing.status, 0);
      assert.match(JSON.parse(missing.stdout).error, /not found|deleted/);
      const first = cli(...importArgs(0), "--project-root", root).results[0];
      const second = cli(...importArgs(1), "--project-id", first.projectId).results[0];
      const third = cli(...importArgs(2), "--project-root", root).results[0];
      assert.deepEqual([second.projectId, third.projectId], [first.projectId, first.projectId]);
      const projects = cli("projects", "--t3-home", target).projects;
      assert.deepEqual(
        projects.map((project: { projectId: string; workspaceRoot: string; title: string }) => [
          project.projectId,
          project.workspaceRoot,
          project.title,
        ]),
        [[first.projectId, root, "repo"]],
      );
      assert.equal(cli(...importArgs(0), "--project-root", root).status, "already-imported");
      const changed = spawnSync(
        process.execPath,
        [cliPath, ...importArgs(0), "--project-root", workspace, "--json"],
        { encoding: "utf8" },
      );
      assert.notEqual(changed.status, 0);
      assert.match(JSON.parse(changed.stdout).error, /changed|rebound/);
      server = await startIsolatedT3Server({ t3Home: target });
      for (const result of [first, second, third]) {
        const {
          projection,
        }: {
          projection: {
            thread: { projectId: string; worktreePath: string | null; branch: string | null };
          };
        } = await server.request(
          `/api/orchestration/threads/${encodeURIComponent(result.threadId)}`,
        );
        assert.equal(projection.thread.projectId, first.projectId);
        assert.equal(
          projection.thread.worktreePath,
          workspace,
          "T3 resolves future cwd from the thread override",
        );
        assert.equal(projection.thread.branch, null, "grouping does not invent a Git branch");
      }
    } finally {
      await server?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "grouped native subagent histories retain their own directories rather than inheriting the parent's",
  { skip: integrationSkip, timeout: 90_000 },
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "t3-import-project-children-")));
    let server: Awaited<ReturnType<typeof startIsolatedT3Server>> | undefined;
    try {
      const root = join(home, "repo");
      const workspace = join(root, "main");
      const childWorkspace = join(root, "child");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(childWorkspace);
      const source = join(home, "source");
      mkdirSync(source);
      writeFileSync(join(source, "child-workspace"), childWorkspace);
      const target = join(home, "target");
      await initializeNativeTarget(target, 96);
      writeFileSync(
        join(target, "userdata/settings.json"),
        JSON.stringify({ providerInstances: { codex: { driver: "codex", enabled: false } } }),
      );
      const result = cli(
        "import",
        "--source",
        "codex",
        "--source-home",
        source,
        "--workspace",
        workspace,
        "--thread",
        "family-root",
        "--binary",
        resolve("native/cli-family-peer.mjs"),
        "--t3-home",
        target,
        "--project-root",
        root,
        "--no-resume",
        "--yes",
      );
      assert.equal(result.results.length, 2);
      assert.equal(
        new Set(result.results.map((item: { projectId: string }) => item.projectId)).size,
        1,
      );
      server = await startIsolatedT3Server({ t3Home: target });
      for (const item of result.results) {
        const { projection }: { projection: { thread: { worktreePath: string | null } } } =
          await server.request(`/api/orchestration/threads/${encodeURIComponent(item.threadId)}`);
        assert.equal(
          projection.thread.worktreePath,
          item.sourceId === "family-root" ? workspace : childWorkspace,
        );
      }
    } finally {
      await server?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
