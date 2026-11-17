import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
const peerSkip = process.platform === "win32" ? "Native RPC executable fixture uses a Unix shebang" : false;

test("packaged OMP bridge forwards native RPC and translates session quiescence for T3", { skip: peerSkip }, () => {
  const result = spawnSync(process.execPath, [resolve("dist/omp.js"), "--mode", "rpc"], {
    input: JSON.stringify({ id: "request-1", type: "prompt", message: "Keep native input" }) + "\n",
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, T3_IMPORT_OMP_BINARY: resolve("native/omp-rpc-peer.mjs") },
  });
  assert.equal(result.status, 0, result.stderr);
  const frames = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(frames, [
    { type: "response", id: "request-1", command: "prompt", success: true, data: { echoed: "Keep native input" } },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "session_settled must stay literal inside message text" }] } },
    { type: "agent_end", messages: [], isTerminal: false },
    { type: "agent_settled" },
  ]);
});

test("OMP bridge rejects an unvalidated native RPC version before starting a session", { skip: peerSkip }, () => {
  const result = spawnSync(process.execPath, [resolve("dist/omp.js"), "--mode", "rpc"], {
    input: "", encoding: "utf8", timeout: 10_000,
    env: { ...process.env, T3_IMPORT_OMP_BINARY: resolve("native/omp-rpc-peer.mjs"), OMP_PEER_VERSION: "99.0.0" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /18\.22\.0|unsupported.*version/i);
  assert.equal(result.stdout, "");
});
