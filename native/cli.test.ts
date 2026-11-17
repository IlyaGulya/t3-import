import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { initializeNativeTarget } from "./target.ts";

function cli(...args: string[]) {
  return spawnSync(process.execPath, [resolve(process.env.T3_IMPORTER_TEST_CLI || "dist/cli.js"), ...args], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
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
    ["import", "--workspace", "/synthetic", "--thread", "one", "--dry-run", "--project-root", "/target", "--project-id", "existing"],
  ]) {
    const result = cli(...args, "--binary", "never-start-this-source", "--json");
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "error");
    assert.doesNotMatch(output.error, /ENOENT|spawn|never-start/);
  }
});

test("CLI emits one structured error when the source executable cannot start", () => {
  const result = cli("show", "--thread", "fixture", "--binary", "t3-import-nonexistent-source-executable", "--json");
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
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("CLI imports each native family member once when selection includes both root and child", { skip: process.platform === "win32" ? "Executable fixture uses a Unix shebang" : false }, async () => {
  for (const selection of [["--all"], ["--thread", "family-child", "--thread", "family-root"]]) {
    const home = mkdtempSync(join(tmpdir(), "t3-import-cli-family-"));
    try {
      const source = join(home, "source"); const target = join(home, "target"); const workspace = join(home, "workspace");
      mkdirSync(source); mkdirSync(workspace);
      await initializeNativeTarget(target, 96);
      const result = cli("import", ...selection, "--workspace", workspace, "--source-home", source,
        "--binary", resolve("native/cli-family-peer.mjs"), "--t3-home", target, "--no-resume", "--yes", "--json");
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "imported");
      assert.deepEqual(output.results.map((entry: { sourceId: string }) => entry.sourceId).sort(), ["family-child", "family-root"]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});
