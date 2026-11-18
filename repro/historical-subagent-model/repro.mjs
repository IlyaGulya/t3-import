import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const sessionId = "91a30000-1111-4111-8111-111111111111";
const agentId = "a1111111111111111";
const toolUseId = "toolu_repro";
const model = "claude-haiku-4-5-20251001";
const title = "Historical subagent model repro";
const root = realpathSync(mkdtempSync(join(tmpdir(), "t3-subagent-model-repro-")));
const t3Home = join(root, "t3");
const claudeHome = join(root, "claude");
const workspace = join(root, "workspace");
const runtimeFile = join(t3Home, "userdata", "server-runtime.json");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("T3CODE_") && key !== "VITE_DEV_SERVER_URL",
  ),
);
Object.assign(env, { T3CODE_HOME: t3Home, T3CODE_TELEMETRY_ENABLED: "false" });

function writeHistory() {
  const project = join(claudeHome, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  const subagents = join(project, sessionId, "subagents");
  mkdirSync(subagents, { recursive: true });
  const record = (uuid, parentUuid, second, message) => ({
    uuid,
    parentUuid,
    sessionId,
    type: message.role,
    message,
    cwd: workspace,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    isSidechain: false,
    version: "2.1.321",
    userType: "external",
  });
  const write = (path, entries) =>
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const parentModel = "claude-opus-4-6";
  const parent = [
    record("root-user", null, 0, { role: "user", content: title }),
    record("root-spawn", "root-user", 1, {
      role: "assistant",
      model: parentModel,
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Agent",
          input: { description: "Historical child", prompt: "Say hello" },
        },
      ],
    }),
    record("root-result", "root-spawn", 4, {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Hello" }],
    }),
    record("root-done", "root-result", 5, {
      role: "assistant",
      model: parentModel,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "The subagent said hello." }],
    }),
  ];
  // Fill the initial ten-turn window and the server's two extra lookbehind turns.
  for (let index = 1; index <= 12; index++) {
    const question = `question-${index}`;
    parent.push(
      record(question, parent.at(-1).uuid, 4 + index * 2, {
        role: "user",
        content: `Follow-up ${index}`,
      }),
      record(`answer-${index}`, question, 5 + index * 2, {
        role: "assistant",
        model: parentModel,
        stop_reason: "end_turn",
        content: [{ type: "text", text: `Answer ${index}` }],
      }),
    );
  }
  write(join(project, `${sessionId}.jsonl`), parent);
  write(join(subagents, `agent-${agentId}.jsonl`), [
    record("child-user", null, 2, { role: "user", content: "Say hello" }),
    record("child-done", "child-user", 3, {
      role: "assistant",
      model,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Hello" }],
    }),
  ]);
  writeFileSync(
    join(subagents, `agent-${agentId}.meta.json`),
    JSON.stringify({ toolUseId, agentType: "general-purpose" }),
  );
}

let server;
const interrupted = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => interrupted.abort());

async function startT3() {
  rmSync(runtimeFile, { force: true });
  const child = spawn(
    "t3",
    ["serve", "--base-dir", t3Home, "--host", "127.0.0.1", "--no-browser"],
    {
      cwd: workspace,
      env,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  server = { child, closed };
  for (let attempt = 0; attempt < 300; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("T3 exited during startup.");
    if (existsSync(runtimeFile)) {
      const { origin } = JSON.parse(readFileSync(runtimeFile, "utf8"));
      if (new URL(origin).hostname !== "127.0.0.1")
        throw new Error("Expected a loopback T3 server.");
      return origin;
    }
    await delay(100, undefined, { signal: interrupted.signal });
  }
  throw new Error("The isolated T3 server did not become ready.");
}

async function stopT3() {
  if (!server) return;
  const { child, closed } = server;
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  try {
    await closed;
  } finally {
    clearTimeout(timer);
    server = undefined;
  }
}

function cli(binary, args) {
  return JSON.parse(
    execFileSync(binary, args, { cwd: workspace, env, encoding: "utf8", timeout: 30000 }),
  );
}

try {
  mkdirSync(workspace);
  mkdirSync(join(t3Home, "userdata"), { recursive: true });
  writeFileSync(
    join(t3Home, "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        codex: { driver: "codex", enabled: false },
        claudeAgent: { driver: "claudeAgent", enabled: false },
        pi: { driver: "pi", enabled: false },
      },
    }),
  );
  writeHistory();
  await startT3();
  await stopT3();
  interrupted.signal.throwIfAborted();

  const imported = cli("npm", [
    "exec",
    "--yes",
    "--registry=https://registry.npmjs.org",
    "--package=@ilyagulya/t3-import@0.5.0-native.11",
    "--",
    "t3-import",
    "import",
    "--source",
    "claude",
    "--source-home",
    claudeHome,
    "--thread",
    sessionId,
    "--workspace",
    workspace,
    "--t3-home",
    t3Home,
    "--snapshot",
    "--no-resume",
    "--yes",
    "--json",
  ]);
  const thread = imported.results.find((result) => result.sourceId === sessionId);
  if (!thread?.threadId || imported.results.length !== 2)
    throw new Error("Expected the root and its one child to be imported.");

  const origin = await startT3();
  const { pairUrl } = cli("t3", [
    "auth",
    "pairing",
    "create",
    "--base-dir",
    t3Home,
    "--base-url",
    origin,
    "--json",
  ]);
  console.log(
    `Open: ${pairUrl}\nThread: ${thread.threadId}\nPress Ctrl+C to stop T3 and remove the fixture.`,
  );
  interrupted.signal.throwIfAborted();
  const exitCode = await Promise.race([server.closed, once(interrupted.signal, "abort")]);
  if (!interrupted.signal.aborted) throw new Error(`T3 stopped unexpectedly (exit ${exitCode}).`);
} catch (error) {
  if (!interrupted.signal.aborted) throw error;
} finally {
  await stopT3();
  rmSync(root, { recursive: true, force: true });
}
