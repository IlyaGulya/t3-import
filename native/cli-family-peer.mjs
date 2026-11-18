#!/usr/bin/env node
/** Executable Codex app-server fixture for public CLI family selection. */
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const at = 1767225600;
const childWorkspaceFile = join(process.env.CODEX_HOME, "child-workspace");
const thread = (id) => ({
  id,
  sessionId: id,
  name: `Synthetic ${id}`,
  preview: "Synthetic request",
  cwd:
    id === "family-child" && existsSync(childWorkspaceFile)
      ? readFileSync(childWorkspaceFile, "utf8")
      : process.cwd(),
  createdAt: at,
  updatedAt: at + 20,
  cliVersion: "test",
  model: "gpt-test",
  modelProvider: "openai",
  source:
    id === "family-child"
      ? { subAgent: { thread_spawn: { parent_thread_id: "family-root", depth: 1 } } }
      : "cli",
  parentThreadId: id === "family-child" ? "family-root" : null,
  ephemeral: false,
  projectId: null,
  historyMode: "paginated",
  status: { type: "idle" },
  turns: [],
});
const items = (id) => [
  { id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: "Synthetic request" }] },
  ...(id === "family-root"
    ? [
        {
          id: "family-spawn",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "family-root",
          receiverThreadIds: ["family-child"],
          agentsStates: { "family-child": { status: "completed", message: null } },
          status: "completed",
          prompt: "Synthetic child request",
        },
      ]
    : []),
  { id: `${id}-answer`, type: "agentMessage", text: "Synthetic response", phase: "final_answer" },
];
const turn = (id) => ({
  id: `${id}-turn`,
  status: "completed",
  startedAt: at,
  completedAt: at + 10,
  itemsView: "full",
  items: items(id),
});
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  const id = request.params?.threadId;
  switch (request.method) {
    case "initialize":
      result = {
        userAgent: "mock-codex-family",
        codexHome: process.env.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "macos",
      };
      break;
    case "thread/list":
      result = { data: [thread("family-root"), thread("family-child")], nextCursor: null };
      break;
    case "thread/read":
      result = { thread: { ...thread(id), turns: request.params.includeTurns ? [turn(id)] : [] } };
      break;
    case "thread/turns/list":
      result = { data: [turn(id)], nextCursor: null };
      break;
    case "thread/items/list":
      result = {
        data: items(id).map((item) => ({ turnId: `${id}-turn`, item })),
        nextCursor: null,
      };
      break;
    default:
      process.stdout.write(
        JSON.stringify({ id: request.id, error: { code: -32601, message: "Method not found" } }) +
          "\n",
      );
      continue;
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
}
