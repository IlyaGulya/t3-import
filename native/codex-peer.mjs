#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const at = 1767225600;
const legacy = existsSync(join(process.env.CODEX_HOME, "legacy"));
const thread = { id: "session-1", sessionId: "session-1", name: "Native fixture", preview: "question", cwd: process.cwd(),
  createdAt: at, updatedAt: at + 20, cliVersion: "test", model: "gpt-test", modelProvider: "openai", source: "cli",
  ephemeral: false, projectId: null, historyMode: "paginated", status: { type: "idle" }, turns: [] };
const items = [{ id: "user-1", type: "userMessage", content: [{ type: "text", text: "question" }] },
  { id: "answer-1", type: "agentMessage", text: "answer", phase: "final_answer" }];
const turn = { id: "turn-1", status: "completed", startedAt: at, completedAt: at + 10, itemsView: "full", items };
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  appendFileSync(join(process.env.CODEX_HOME, "requests.jsonl"), JSON.stringify(message) + "\n");
  if (message.id === undefined) continue;
  let result;
  switch (message.method) {
    case "initialize": result = { userAgent: "mock-codex", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" }; break;
    case "thread/read": result = { thread: { ...thread, historyMode: legacy ? "legacy" : "paginated", turns: message.params.includeTurns ? [turn] : [] } }; break;
    case "thread/turns/list":
      if (legacy) { process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue; }
      result = { data: [turn], nextCursor: null }; break;
    case "thread/items/list":
      if (legacy) { process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue; }
      result = { data: items.map((item) => ({ turnId: turn.id, item })), nextCursor: null }; break;
    default: process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue;
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
}
