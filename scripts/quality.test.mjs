import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "t3-import-quality-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function lint(root, ...files) {
  return spawnSync(
    process.execPath,
    [join(packageRoot, "scripts/lint.mjs"), "--root", root, ...files],
    { encoding: "utf8" },
  );
}

test("lint requires reasons for suppressions while accepting a justified native exception", () => {
  const f = fixture({ "native/sample.ts": "// @ts-ignore\nexport const value: string = 1;\n" });
  try {
    const rejected = lint(f.root, "native/sample.ts");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /Say why/);
    writeFileSync(
      join(f.root, "native/sample.ts"),
      "// @ts-ignore -- Test an intentionally incompatible native signature.\nexport const value: string = 1;\n",
    );
    const accepted = lint(f.root, "native/sample.ts");
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  } finally {
    f.cleanup();
  }
});

test("lint rejects stale disables rather than silently carrying exemptions", () => {
  const f = fixture({
    "native/sample.ts":
      "// oxlint-disable-next-line no-unused-vars -- Previously needed for the native bridge.\nexport const value = 1;\n",
  });
  try {
    const result = lint(f.root, "native/sample.ts");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Unused.*disable|unused.*disable/i);
  } finally {
    f.cleanup();
  }
});

test("reader boundaries reject writer dependencies through aliases and re-export barrels", () => {
  const f = fixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "#target": ["native/target.ts"] } },
    }),
    "native/target.ts": "export const write = () => {};\n",
    "native/barrel.ts": "export { write } from '#target';\n",
    "native/codex.ts": "import { write } from './barrel.js'; export const leak = write;\n",
  });
  try {
    const result = lint(f.root, "native/codex.ts");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /reader.*target|reader.*writer/i);
  } finally {
    f.cleanup();
  }
});

test("reader boundaries cover literal dynamic imports and type/CLI runtime bypasses", () => {
  const f = fixture({
    "native/target.ts": "export const writer = 1;\n",
    "native/claude.ts": "export const bypass = () => import('./target.js');\n",
    "native/cli.ts": "export { query } from '@anthropic-ai/claude-agent-sdk';\n",
    "src/native/types.ts": "import 'node:fs'; export interface View { id: string }\n",
  });
  try {
    const result = lint(f.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /reader.*writer/i);
    assert.match(result.stdout + result.stderr, /CLI must call reader\/writer/);
    assert.match(result.stdout + result.stderr, /normalized contracts.*runtime imports/);
  } finally {
    f.cleanup();
  }
});

test("Codex native history cannot acquire a model-turn request through a wrapper", () => {
  const f = fixture({
    "native/codex.ts":
      "declare const client: { request(method: string): void }; function invoke(method: string) { client.request(method); } invoke('turn/start');\n",
  });
  try {
    const result = lint(f.root, "native/codex.ts");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Codex history.*allowlist/);
    writeFileSync(
      join(f.root, "native/codex.ts"),
      "declare const client: { request(method: string): void }; type Method = 'thread/read' | 'thread/list'; function invoke(method: Method) { client.request(method); } invoke('thread/read');\n",
    );
    const accepted = lint(f.root, "native/codex.ts");
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  } finally {
    f.cleanup();
  }
});

test("Claude readers cannot import live query APIs from an otherwise permitted native SDK", () => {
  const f = fixture({
    "native/claude-helper.ts":
      "import { query as start } from '@anthropic-ai/claude-agent-sdk'; export const live = start;\n",
  });
  try {
    const result = lint(f.root, "native/claude-helper.ts");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Claude.*history API/);
  } finally {
    f.cleanup();
  }
});

function verifyPlan(root) {
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, "scripts/verify.mjs"), "--changed", "--root", root, "--plan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("changed verification includes untracked/deleted code and conservatively runs the whole native suite", () => {
  const f = fixture({
    "native/deleted.ts": "export const value = 1;\n",
    "README.md": "# Fixture\n",
  });
  try {
    git(f.root, "init", "--quiet");
    git(f.root, "add", ".");
    git(
      f.root,
      "-c",
      "user.name=Quality Test",
      "-c",
      "user.email=quality@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    rmSync(join(f.root, "native/deleted.ts"));
    writeFileSync(join(f.root, "native/new.ts"), "export const next = 2;\n");
    const plan = verifyPlan(f.root);
    assert.deepEqual(plan.changedFiles, ["native/deleted.ts", "native/new.ts"]);
    assert.ok(plan.steps.includes("typecheck"));
    assert.ok(plan.steps.includes("native-tests"));
    assert.ok(plan.steps.includes("quality-tests"));
    assert.equal(plan.mode, "changed");
  } finally {
    f.cleanup();
  }
});

test("test policy rejects focused tests and unexplained wall clocks while retaining integration exceptions", () => {
  const f = fixture({
    "native/example.test.ts":
      "import { test } from 'node:test'; test.only('focused', () => Date.now());\n",
  });
  try {
    const rejected = lint(f.root, "native/example.test.ts");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /Focused tests/);
    assert.match(rejected.stdout + rejected.stderr, /fixed timestamp|clock/i);
    writeFileSync(
      join(f.root, "native/example.test.ts"),
      "import { test } from 'node:test';\ntest('bounded subprocess integration', () => {\n// Integration clock: measure real subprocess readiness, not historical source timestamps.\nconst observed = Date.now(); return observed;\n});\n",
    );
    const accepted = lint(f.root, "native/example.test.ts");
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  } finally {
    f.cleanup();
  }
});

test("writer keeps T3 mutations behind EventSink while allowing its own import ledger", () => {
  const f = fixture({
    "native/target.ts":
      "declare const db: { exec(sql: string): void }; db.exec('UPDATE orchestration_v2_projection_threads SET title = 1');\n",
  });
  try {
    const rejected = lint(f.root, "native/target.ts");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /EventSink/);
    writeFileSync(
      join(f.root, "native/target.ts"),
      "declare const db: { exec(sql: string): void }; db.exec('CREATE TABLE t3_native_imports (id TEXT)');\n",
    );
    const accepted = lint(f.root, "native/target.ts");
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  } finally {
    f.cleanup();
  }
});

test("changed verification uses a full fallback outside Git and avoids code tests for documentation only", () => {
  const f = fixture({ "README.md": "# Fixture\n" });
  try {
    const fallback = verifyPlan(f.root);
    assert.equal(fallback.mode, "full");
    assert.ok(fallback.steps.includes("native-tests"));
    git(f.root, "init", "--quiet");
    git(f.root, "add", ".");
    git(
      f.root,
      "-c",
      "user.name=Quality Test",
      "-c",
      "user.email=quality@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    assert.deepEqual(verifyPlan(f.root).steps, []);
    writeFileSync(join(f.root, "README.md"), "# Changed documentation\n");
    const docs = verifyPlan(f.root);
    assert.deepEqual(docs.changedFiles, ["README.md"]);
    assert.deepEqual(docs.steps, ["format", "lint"]);
  } finally {
    f.cleanup();
  }
});

test("reader filesystem mutation aliases cannot bypass native read-only ownership", () => {
  const f = fixture({
    "native/claude.ts":
      "import { writeFile as change } from 'node:fs/promises'; export const mutate = change;\n",
  });
  try {
    const result = lint(f.root, "native/claude.ts");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /filesystem mutation APIs/);
  } finally {
    f.cleanup();
  }
});

test("test policy rejects real-time sleeps in favor of observable process milestones", () => {
  const f = fixture({
    "native/sleep.test.ts":
      "import { test } from 'node:test'; import { setTimeout as delay } from 'node:timers/promises'; test('wait', async () => { await delay(10); });\n",
  });
  try {
    const rejected = lint(f.root, "native/sleep.test.ts");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /observable.*milestone/i);
  } finally {
    f.cleanup();
  }
});
