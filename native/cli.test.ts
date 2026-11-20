import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { initializeNativeTarget } from "./target.ts";
import { startIsolatedT3Server } from "./server.ts";

function cli(...args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"), ...args],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
}

test("packaged CLI exposes the current importer without the legacy command tree", () => {
  const help = cli("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /list \[options\]/);
  assert.match(help.stdout, /import \[options\]/);
  assert.doesNotMatch(help.stdout, /sync \[|replace \[|cache \[/);
  assert.equal(cli("--version").stdout.trim(), __IMPORTER_VERSION__);
  const importHelp = cli("import", "--help");
  assert.equal(importHelp.status, 0, importHelp.stderr);
  assert.match(importHelp.stdout, /"codex", "omp"/);
  assert.match(importHelp.stdout, /--omp-package/);
  assert.match(importHelp.stdout, /--bun-binary/);
});

test("CLI rejects ambiguous selection and unreviewed writes before launching the source", () => {
  for (const args of [
    ["import", "--workspace", "/synthetic", "--thread", "one", "--all", "--dry-run"],
    ["import", "--workspace", "/synthetic", "--thread", "one"],
    ["import", "--thread", "one", "--dry-run"],
    [
      "import",
      "--workspace",
      "/synthetic",
      "--thread",
      "one",
      "--dry-run",
      "--project-root",
      "/target",
      "--project-id",
      "existing",
    ],
  ]) {
    const result = cli(...args, "--binary", "never-start-this-source", "--json");
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "error");
    assert.doesNotMatch(output.error, /ENOENT|spawn|never-start/);
  }
});

test("CLI emits one structured error when the source executable cannot start", () => {
  const result = cli(
    "show",
    "--thread",
    "fixture",
    "--binary",
    "t3-import-nonexistent-source-executable",
    "--json",
  );
  assert.equal(result.status, 6, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "error");
  assert.doesNotMatch(result.stderr, /PlatformError:|at ChildProcess|Node\.js v/);
});

test("CLI doctor reports the native target as one JSON result", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3-import-cli-"));
  try {
    await initializeNativeTarget(home, 96);
    const result = cli("doctor", "--t3-home", home, "--json");
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.migration, 96);
    assert.equal(output.supported, true);
    assert.equal(output.live, false);
    assert.equal(output.target, join(home, "userdata", "statev2.sqlite"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "bulk import refuses a running T3 or corrupt target before contacting native history",
  { skip: !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")) },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-import-bulk-preflight-"));
    const flags = [
      "import-all",
      "--source",
      "codex",
      "--binary",
      "never-start-this-source",
      "--t3-home",
      home,
      "--yes",
      "--json",
    ];
    try {
      await initializeNativeTarget(home, 96);
      const server = await startIsolatedT3Server({ t3Home: home });
      try {
        const result = cli(...flags);
        assert.notEqual(result.status, 0);
        assert.match(JSON.parse(result.stdout).error, /T3 is running/);
      } finally {
        await server.stop();
      }
      writeFileSync(join(home, "userdata", "statev2.sqlite"), "invalid SQLite");
      const result = cli(...flags);
      assert.notEqual(result.status, 0);
      assert.match(JSON.parse(result.stdout).error, /not a database|integrity/i);
      assert.equal(existsSync(join(home, "userdata", "t3-import-backups")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "bulk import plans and writes native families across workspaces with one backup",
  {
    timeout: 90_000,
    skip:
      process.platform === "win32" ||
      !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
  },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-import-bulk-families-"));
    const source = join(home, "source");
    const target = join(home, "target");
    const backups = join(target, "userdata", "t3-import-backups");
    const flags = [
      "import-all",
      "--source",
      "codex",
      "--source-home",
      source,
      "--binary",
      resolve("native/cli-family-peer.mjs"),
      "--t3-home",
      target,
      "--json",
    ];
    try {
      mkdirSync(join(source, "workspace"), { recursive: true });
      writeFileSync(join(source, "bulk"), "");
      const image = Buffer.alloc(10 * 1024 * 1024 + 1, 42);
      writeFileSync(join(source, "large.png"), image);
      await initializeNativeTarget(target, 96);
      const preview = cli(...flags, "--dry-run");
      assert.equal(preview.status, 0, preview.stdout + preview.stderr);
      const planned = JSON.parse(preview.stdout);
      assert.deepEqual(planned.placementCounts, { active: 0, settled: 2, archived: 1 });
      assert.deepEqual(
        planned.results.find((entry: { sourceId: string }) => entry.sourceId === "family-root")
          .placement,
        {
          state: "settled",
          reason: "inactive-family",
          familyLastActivityAt: "2026-01-01T00:00:10.000Z",
        },
      );
      assert.equal(existsSync(backups), false);

      const result = cli(...flags, "--yes");
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(readdirSync(backups), [basename(output.backup)]);
      const threads = new Map<string, string>(
        output.results.map((entry: { sourceId: string; threadId: string }) => [
          entry.sourceId,
          entry.threadId,
        ]),
      );
      assert.deepEqual([...threads.keys()].sort(), [
        "archived-root",
        "family-child",
        "family-root",
      ]);

      const server = await startIsolatedT3Server({ t3Home: target });
      try {
        type Snapshot = {
          projection: {
            messages: { attachments: { id: string; type: string; sizeBytes: number }[] }[];
            thread: {
              projectId: string;
              archivedAt: string | null;
              settledOverride: string | null;
              lineage: { parentThreadId: string | null };
            };
          };
        };
        const snapshots = await Promise.all(
          ["family-root", "family-child", "archived-root"].map((id) =>
            server.request<Snapshot>(
              `/api/orchestration/threads/${encodeURIComponent(threads.get(id)!)}`,
            ),
          ),
        );
        const [root, child, archived] = snapshots.map((snapshot) => snapshot.projection.thread);
        assert.equal(child!.lineage.parentThreadId, threads.get("family-root"));
        assert.equal(root!.settledOverride, "settled");
        assert.ok(archived!.archivedAt);
        assert.notEqual(root!.projectId, archived!.projectId);
        const attachment = snapshots[2]!.projection.messages.flatMap(
          (message) => message.attachments,
        )[0]!;
        assert.equal(attachment.type, "file");
        assert.equal(attachment.sizeBytes, image.length);
        assert.deepEqual(
          readFileSync(join(target, "userdata", "attachments", `${attachment.id}.png`)),
          image,
        );
      } finally {
        await server.stop();
      }

      const repeat = cli(...flags, "--yes");
      assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
      assert.equal(JSON.parse(repeat.stdout).backup, null);
      assert.deepEqual(
        JSON.parse(repeat.stdout).results.map((entry: { status: string }) => entry.status),
        Array.from({ length: 3 }, () => "already-imported"),
      );
      assert.equal(readdirSync(backups).length, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "CLI archives only the confirmed empty subagent and preserves its parent relationship",
  {
    timeout: 90_000,
    skip:
      process.platform === "win32" ||
      !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
  },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-import-family-placement-"));
    const source = join(home, "source");
    const target = join(home, "target");
    const flags = [
      "import-all",
      "--source",
      "codex",
      "--source-home",
      source,
      "--binary",
      resolve("native/cli-family-peer.mjs"),
      "--t3-home",
      target,
      "--json",
    ];
    try {
      mkdirSync(join(source, "workspace"), { recursive: true });
      writeFileSync(join(source, "bulk"), "");
      writeFileSync(join(source, "placement-children"), "");
      await initializeNativeTarget(target, 96);
      const preview = cli(...flags, "--dry-run");
      assert.equal(preview.status, 0, preview.stdout + preview.stderr);
      const planned = JSON.parse(preview.stdout);
      assert.deepEqual(planned.placementCounts, { active: 0, settled: 3, archived: 2 });
      const placements = Object.fromEntries(
        planned.results.map((entry: { sourceId: string; placement: { reason: string } }) => [
          entry.sourceId,
          entry.placement.reason,
        ]),
      );
      assert.deepEqual(placements, {
        "archived-root": "source-archive",
        "family-root": "inactive-family",
        "family-child": "historical-child",
        "empty-child": "empty-subagent",
        "failed-child": "historical-child",
      });
      const recent = cli(
        ...flags,
        "--dry-run",
        "--old-family-days",
        "3650",
        "--old-family-action",
        "archive",
      );
      assert.equal(recent.status, 0, recent.stdout + recent.stderr);
      const recentPlan = JSON.parse(recent.stdout);
      assert.deepEqual(recentPlan.placementCounts, { active: 1, settled: 2, archived: 2 });
      assert.deepEqual(
        recentPlan.results.find((entry: { sourceId: string }) => entry.sourceId === "family-root")
          .placement,
        {
          state: "active",
          reason: "recent-family",
          familyLastActivityAt: "2026-01-01T00:00:10.000Z",
        },
      );
      const cold = cli(
        "import",
        "--source",
        "codex",
        "--source-home",
        source,
        "--workspace",
        join(source, "workspace"),
        "--binary",
        resolve("native/cli-family-peer.mjs"),
        "--thread",
        "family-root",
        "--t3-home",
        target,
        "--no-resume",
        "--dry-run",
        "--old-family-action",
        "archive",
        "--json",
      );
      assert.equal(cold.status, 0, cold.stdout + cold.stderr);
      assert.deepEqual(JSON.parse(cold.stdout).placementCounts, {
        active: 0,
        settled: 0,
        archived: 4,
      });
      const keep = cli(
        ...flags,
        "--dry-run",
        "--old-family-action",
        "keep",
        "--no-archive-empty-children",
      );
      assert.equal(keep.status, 0, keep.stdout + keep.stderr);
      assert.deepEqual(JSON.parse(keep.stdout).placementCounts, {
        active: 1,
        settled: 3,
        archived: 1,
      });

      const saved = cli(...flags, "--yes");
      assert.equal(saved.status, 0, saved.stdout + saved.stderr);
      type Imported = { sourceId: string; threadId: string };
      const threads = new Map<string, string>(
        JSON.parse(saved.stdout).results.map((entry: Imported) => [entry.sourceId, entry.threadId]),
      );
      const server = await startIsolatedT3Server({ t3Home: target });
      try {
        const read = (sourceId: string) =>
          server.request<{
            projection: {
              thread: {
                archivedAt: string | null;
                settledOverride: string | null;
                lineage: { parentThreadId: string | null };
              };
              subagents: { childThreadId: string | null }[];
            };
          }>(`/api/orchestration/threads/${encodeURIComponent(threads.get(sourceId)!)}`);
        const [root, empty, failed] = await Promise.all([
          read("family-root"),
          read("empty-child"),
          read("failed-child"),
        ]);
        assert.ok(
          root.projection.subagents.some(
            (child) => child.childThreadId === threads.get("empty-child"),
          ),
        );
        assert.ok(empty.projection.thread.archivedAt);
        assert.equal(empty.projection.thread.lineage.parentThreadId, threads.get("family-root"));
        assert.equal(failed.projection.thread.archivedAt, null);
        assert.equal(failed.projection.thread.settledOverride, "settled");
      } finally {
        await server.stop();
      }
      const repeat = cli(...flags, "--yes", "--old-family-action", "archive");
      assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
      const repeated = JSON.parse(repeat.stdout);
      assert.equal(repeated.backup, null);
      assert.deepEqual(repeated.placementCounts, planned.placementCounts);
      assert.ok(
        repeated.results.every(
          (entry: { placement: { reason: string } }) =>
            entry.placement.reason === "already-imported",
        ),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "bulk Codex import distinguishes inherited-only compressed rollouts from missing history",
  {
    timeout: 90_000,
    skip:
      process.platform === "win32" ||
      !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
  },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-import-codex-inventory-"));
    const source = join(home, "source");
    const target = join(home, "target");
    const flags = [
      "import-all",
      "--source",
      "codex",
      "--codex-index-only",
      "--source-home",
      source,
      "--binary",
      resolve("native/cli-family-peer.mjs"),
      "--t3-home",
      target,
      "--json",
    ];
    try {
      mkdirSync(join(source, "workspace"), { recursive: true });
      writeFileSync(join(source, "bulk"), "");
      writeFileSync(join(source, "inventory-only-children"), "");
      const sessions = join(source, "sessions");
      mkdirSync(sessions);
      const compressedPath = join(sessions, "rollout-missing-child.jsonl.zst");
      const timestamp = "2026-01-01T00:00:00.000Z";
      const inherited = [
        {
          timestamp,
          ordinal: 0,
          type: "session_meta",
          payload: {
            id: "missing-child",
            history_mode: "paginated",
            subagent_history_start_ordinal: 2,
          },
        },
        { timestamp, ordinal: 1, type: "event_msg", payload: { type: "user_message" } },
      ];
      const compressed = zstdCompressSync(
        inherited.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
      writeFileSync(compressedPath, compressed);
      const headerOnly = {
        timestamp,
        ordinal: 0,
        type: "session_meta",
        payload: { id: "missing-root", history_mode: "paginated" },
      };
      writeFileSync(
        join(sessions, "rollout-missing-root.jsonl.zst"),
        zstdCompressSync(JSON.stringify(headerOnly) + "\n"),
      );
      await initializeNativeTarget(target, 96);
      const preview = cli(...flags, "--dry-run");
      assert.equal(preview.status, 0, preview.stdout + preview.stderr);
      const planned = JSON.parse(preview.stdout);
      assert.equal(planned.codexInventory, "native-state-index");
      assert.deepEqual(planned.failures, []);
      assert.deepEqual(
        planned.results.map((entry: { sourceId: string; turns: number }) => [
          entry.sourceId,
          entry.turns,
        ]),
        [
          ["family-root", 1],
          ["family-child", 1],
          ["missing-root", 0],
        ],
      );
      const [root, child, standalone] = planned.results;
      assert.deepEqual(root.retainedChildMetadata, ["missing-child", "missing-grandchild"]);
      assert.match(
        root.warnings.join("\n"),
        /1 compressed descendant rollout\(s\) contain only inherited parent history/,
      );
      assert.match(root.warnings.join("\n"), /1 descendant rollout path\(s\) are absent/);
      assert.equal(standalone.historyMetadataOnly, "missing-native-transcript");
      assert.match(
        standalone.warnings.join("\n"),
        /compressed rollout contains only a session header/i,
      );
      const withLocal = [
        ...inherited,
        { timestamp, ordinal: 2, type: "event_msg", payload: { type: "user_message" } },
      ];
      writeFileSync(
        compressedPath,
        zstdCompressSync(withLocal.map((line) => JSON.stringify(line)).join("\n") + "\n"),
      );
      const incomplete = cli(...flags, "--dry-run");
      assert.equal(incomplete.status, 6, incomplete.stdout + incomplete.stderr);
      const failure = JSON.parse(incomplete.stdout).failures.find(
        (entry: { sourceId: string }) => entry.sourceId === "family-root",
      );
      assert.match(failure.error, /compressed rollout contains local records.*no native turns/i);
      writeFileSync(compressedPath, compressed);
      const saved = cli(...flags, "--yes");
      assert.equal(saved.status, 0, saved.stdout + saved.stderr);
      const metadata = JSON.parse(
        cli("metadata", "--t3-home", target, "--thread", root.threadId, "--json").stdout,
      );
      assert.deepEqual(
        metadata.records.map(
          (record: { sourceId: string; parent: { sourceId: string }; archived: boolean }) => [
            record.sourceId,
            record.parent.sourceId,
            record.archived,
          ],
        ),
        [
          ["missing-child", "family-root", false],
          ["missing-grandchild", "missing-child", true],
        ],
      );
      const server = await startIsolatedT3Server({ t3Home: target });
      try {
        const reply = await server.request<{
          projection: { thread: { lineage: { parentThreadId: string } }; messages: unknown[] };
        }>(`/api/orchestration/threads/${encodeURIComponent(child.threadId)}`);
        assert.equal(reply.projection.thread.lineage.parentThreadId, root.threadId);
        assert.equal(reply.projection.messages.length, 2);
        const empty = await server.request<{
          projection: { runs: unknown[]; messages: unknown[] };
        }>(`/api/orchestration/threads/${encodeURIComponent(standalone.threadId)}`);
        assert.deepEqual(empty.projection.runs, []);
        assert.deepEqual(empty.projection.messages, []);
      } finally {
        await server.stop();
      }
      const repeat = cli(...flags, "--yes");
      assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
      assert.equal(JSON.parse(repeat.stdout).backup, null);
      assert.ok(
        JSON.parse(repeat.stdout).results.every(
          (entry: { status: string }) => entry.status === "already-imported",
        ),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "bulk import saves deferred families and retries only that work in the same T3 profile",
  {
    timeout: 90_000,
    skip:
      process.platform === "win32" ||
      !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
  },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-import-bulk-retry-"));
    const source = join(home, "source");
    const target = join(home, "target");
    const flags = [
      "import-all",
      "--source",
      "codex",
      "--source-home",
      source,
      "--binary",
      resolve("native/cli-family-peer.mjs"),
      "--t3-home",
      target,
      "--json",
      "--yes",
    ];
    try {
      mkdirSync(join(source, "workspace"), { recursive: true });
      writeFileSync(join(source, "bulk"), "");
      writeFileSync(join(source, "active-root"), "");
      await initializeNativeTarget(target, 96);
      const first = cli(...flags);
      assert.notEqual(first.status, 0);
      const partial = JSON.parse(first.stdout);
      assert.equal(partial.status, "partial");
      assert.ok(existsSync(partial.backup));
      assert.deepEqual(
        partial.results.map((entry: { sourceId: string }) => entry.sourceId),
        ["archived-root"],
      );
      assert.match(
        partial.failures.find((entry: { sourceId: string }) => entry.sourceId === "family-root")
          .error,
        /active or indeterminate/,
      );
      const manifest = JSON.parse(readFileSync(partial.retryFile, "utf8"));
      assert.equal(manifest.t3Home, target);
      assert.equal(manifest.sources[0].source, "codex");
      assert.deepEqual(manifest.sources[0].sessionIds, ["family-root", "family-child"]);

      const dryRetry = join(home, "dry-retry.json");
      const blocked = cli(
        "import-all",
        "--retry-from",
        partial.retryFile,
        "--retry-file",
        dryRetry,
        "--dry-run",
        "--json",
      );
      assert.equal(blocked.status, 6, blocked.stdout + blocked.stderr);
      const stillBlocked = JSON.parse(blocked.stdout);
      assert.equal(stillBlocked.backup, null);
      assert.equal(stillBlocked.retryFile, dryRetry);
      assert.deepEqual(stillBlocked.results, []);

      rmSync(join(source, "active-root"));
      const retryFlags = ["import-all", "--retry-from", partial.retryFile, "--yes", "--json"];
      const repeated = cli(...retryFlags);
      assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
      const imported = JSON.parse(repeated.stdout);
      assert.deepEqual(
        imported.results.map((entry: { sourceId: string; status: string }) => [
          entry.sourceId,
          entry.status,
        ]),
        [
          ["family-root", "imported"],
          ["family-child", "imported"],
        ],
      );
      assert.equal(imported.retryFile, null);
      const server = await startIsolatedT3Server({ t3Home: target });
      try {
        const [root, child] = imported.results;
        const { projection } = await server.request<{
          projection: { thread: { lineage: { parentThreadId: string } }; messages: unknown[] };
        }>(`/api/orchestration/threads/${encodeURIComponent(child.threadId)}`);
        assert.equal(projection.thread.lineage.parentThreadId, root.threadId);
        assert.equal(projection.messages.length, 2);
      } finally {
        await server.stop();
      }
      const replay = cli(...retryFlags);
      assert.equal(replay.status, 0, replay.stdout + replay.stderr);
      const replayed = JSON.parse(replay.stdout);
      assert.equal(replayed.backup, null);
      assert.deepEqual(
        replayed.results.map((entry: { status: string }) => entry.status),
        ["already-imported", "already-imported"],
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "CLI preserves native Codex archives and honors opt-in settlement in a real T3 server",
  {
    timeout: 90_000,
    skip:
      process.platform === "win32" ||
      !existsSync(process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3/bin/t3")),
  },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-native-archive-codex-"));
    const source = join(home, "source");
    const workspace = join(home, "workspace");
    const flags = [
      "--source",
      "codex",
      "--source-home",
      source,
      "--workspace",
      workspace,
      "--binary",
      resolve("native/codex-peer.mjs"),
    ];
    const importFlags = ["--thread", "session-1", "--no-resume", "--yes", "--json"];
    try {
      mkdirSync(source);
      mkdirSync(workspace);
      writeFileSync(join(source, "archived"), "");
      for (const placement of ["listed-archive", "unlisted-archive", "settled"]) {
        const archived = placement !== "settled";
        if (placement === "unlisted-archive") writeFileSync(join(source, "unlisted-archive"), "");
        if (!archived) rmSync(join(source, "unlisted-archive"));
        if (!archived) rmSync(join(source, "archived"));
        const target = join(home, placement);
        await initializeNativeTarget(target, 96);
        const result = cli("import", ...flags, ...importFlags, "--t3-home", target, "--settled");
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const threadId = JSON.parse(result.stdout).results[0].threadId;
        const server = await startIsolatedT3Server({ t3Home: target });
        try {
          const {
            projection: { thread },
          } = await server.request<{
            projection: { thread: { archivedAt: string | null; settledOverride: string | null } };
          }>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
          assert.equal(Boolean(thread.archivedAt), archived);
          assert.equal(thread.settledOverride, archived ? null : "settled");
        } finally {
          await server.stop();
        }
        const listing = cli("list", ...flags, ...(archived ? ["--archived"] : []), "--json");
        assert.equal(listing.status, 0, listing.stderr || listing.stdout);
        if (placement === "unlisted-archive")
          assert.deepEqual(JSON.parse(listing.stdout).sessions, []);
        else assert.equal(JSON.parse(listing.stdout).sessions[0].archived, archived);
        assert.equal(
          JSON.parse(
            cli("import", ...flags, ...importFlags, "--t3-home", target, "--settled").stdout,
          ).status,
          "already-imported",
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "CLI imports each native family member once when selection includes both root and child",
  { skip: process.platform === "win32" ? "Executable fixture uses a Unix shebang" : false },
  async () => {
    for (const selection of [["--all"], ["--thread", "family-child", "--thread", "family-root"]]) {
      const home = mkdtempSync(join(tmpdir(), "t3-import-cli-family-"));
      try {
        const source = join(home, "source");
        const target = join(home, "target");
        const workspace = join(home, "workspace");
        mkdirSync(source);
        mkdirSync(workspace);
        await initializeNativeTarget(target, 96);
        const result = cli(
          "import",
          ...selection,
          "--workspace",
          workspace,
          "--source-home",
          source,
          "--binary",
          resolve("native/cli-family-peer.mjs"),
          "--t3-home",
          target,
          "--no-resume",
          "--yes",
          "--json",
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.status, "imported");
        assert.deepEqual(
          output.results.map((entry: { sourceId: string }) => entry.sourceId).sort(),
          ["family-child", "family-root"],
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);
