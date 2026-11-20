#!/usr/bin/env node
/** Executable Codex app-server fixture for public CLI family selection. */
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const at = 1767225600;
const childWorkspaceFile = join(process.env.CODEX_HOME, "child-workspace");
const bulk = existsSync(join(process.env.CODEX_HOME, "bulk"));
const inventoryOnly = existsSync(join(process.env.CODEX_HOME, "inventory-only-children"));
const placement = existsSync(join(process.env.CODEX_HOME, "placement-children"));
const timestampFor = (id) => (placement && id === "family-root" ? 946684800 : at);
const parents = {
  "family-child": "family-root",
  "empty-child": "family-root",
  "failed-child": "family-root",
  "missing-child": "family-root",
  "missing-grandchild": "missing-child",
};
const missing = (id) => id.startsWith("missing-");
const thread = (id) => ({
  id,
  sessionId: id,
  name: `Synthetic ${id}`,
  preview: "Synthetic request",
  cwd:
    id === "family-child" && existsSync(childWorkspaceFile)
      ? readFileSync(childWorkspaceFile, "utf8")
      : bulk
        ? join(process.env.CODEX_HOME, id === "archived-root" ? "deleted-workspace" : "workspace")
        : process.cwd(),
  createdAt: timestampFor(id),
  updatedAt: timestampFor(id) + 20,
  cliVersion: "test",
  model: "gpt-test",
  modelProvider: "openai",
  source: parents[id]
    ? { subAgent: { thread_spawn: { parent_thread_id: parents[id], depth: 1 } } }
    : "cli",
  parentThreadId: parents[id] ?? null,
  ...(missing(id) ? { path: join(process.env.CODEX_HOME, "sessions", `rollout-${id}.jsonl`) } : {}),
  ephemeral: false,
  projectId: null,
  historyMode: "paginated",
  status:
    id === "family-root" && existsSync(join(process.env.CODEX_HOME, "active-root"))
      ? { type: "active", activeFlags: [] }
      : { type: "idle" },
  turns: [],
});
const items = (id) =>
  id === "empty-child" || id === "failed-child"
    ? []
    : [
        {
          id: `${id}-user`,
          type: "userMessage",
          content: [
            { type: "text", text: "Synthetic request" },
            ...(id === "archived-root" && existsSync(join(process.env.CODEX_HOME, "large.png"))
              ? [{ type: "localImage", path: join(process.env.CODEX_HOME, "large.png") }]
              : []),
          ],
        },
        ...(id === "family-root" && !inventoryOnly
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
        {
          id: `${id}-answer`,
          type: "agentMessage",
          text: "Synthetic response",
          phase: "final_answer",
        },
      ];
const turn = (id) => ({
  id: `${id}-turn`,
  status: id === "failed-child" ? "failed" : "completed",
  startedAt: timestampFor(id),
  completedAt: timestampFor(id) + 10,
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
      if (inventoryOnly && !request.params.useStateDbOnly) {
        process.stdout.write(
          JSON.stringify({
            id: request.id,
            error: { code: -32603, message: "Fixture requires native indexed listing" },
          }) + "\n",
        );
        continue;
      }
      result = {
        data: bulk
          ? request.params.archived
            ? inventoryOnly
              ? [thread("missing-grandchild")]
              : [thread("archived-root")]
            : inventoryOnly
              ? ["family-child", "family-root", "missing-child", "missing-root"].map(thread)
              : [
                  thread("family-child"),
                  thread("family-root"),
                  ...(placement ? [thread("empty-child"), thread("failed-child")] : []),
                ]
          : [thread("family-root"), thread("family-child")],
        nextCursor: null,
      };
      break;
    case "thread/read":
      result = {
        thread: {
          ...thread(id),
          turns: request.params.includeTurns && !missing(id) ? [turn(id)] : [],
        },
      };
      break;
    case "thread/turns/list":
      result = { data: missing(id) ? [] : [turn(id)], nextCursor: null };
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
