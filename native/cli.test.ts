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
      assert.equal(JSON.parse(preview.stdout).results.length, 3);
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
  "bulk import reports an active family and retries it without duplicating other history",
  { skip: process.platform === "win32" ? "Executable fixture uses a Unix shebang" : false },
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

      rmSync(join(source, "active-root"));
      const repeated = cli(...flags);
      assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
      assert.deepEqual(
        JSON.parse(repeated.stdout).results.map((entry: { sourceId: string; status: string }) => [
          entry.sourceId,
          entry.status,
        ]),
        [
          ["family-root", "imported"],
          ["family-child", "imported"],
          ["archived-root", "already-imported"],
        ],
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
