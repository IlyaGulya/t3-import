import { getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, listSubagents, type SDKSessionInfo, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { NativeConversation, NativeHistoryItem, NativeHistoryTurn, NativeImage, NativeReadOptions, JsonValue, NativeSourceSummary } from "../src/native/types.js";

interface Request { operation: "list" | "read"; options: NativeReadOptions; sourceHome: string; id?: string }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function canonical(path: string): string { try { return realpathSync(resolve(path)); } catch { return resolve(path); } }
function samePath(a: string, b: string): boolean { const x = canonical(a), y = canonical(b); return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y; }
function iso(value: number | undefined, fallback: string): string { return value !== undefined && Number.isFinite(value) ? new Date(value).toISOString() : fallback; }
function summary(info: SDKSessionInfo): NativeSourceSummary {
  const updatedAt = iso(info.lastModified, "1970-01-01T00:00:00.000Z");
  return { source: "claude", id: info.sessionId, title: info.customTitle || info.summary || "Claude session", workspace: info.cwd || "", createdAt: iso(info.createdAt, updatedAt), updatedAt };
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.flatMap(block => { const entry = object(block); return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : []; }).join("\n\n") : "";
}
function images(content: unknown, id: string, warnings: Set<string>): NativeImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap<NativeImage>((value, index) => {
    const block = object(value), source = object(block.source);
    if (block.type !== "image") return [];
    const name = `${id}-${index}`;
    if (source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") return [{ id: name, name: `${name}.${source.media_type.split("/")[1] || "png"}`, mimeType: source.media_type, base64: source.data }];
    if (source.type === "url" && typeof source.url === "string") return [{ id: name, name: `${name}.png`, mimeType: "image/png", url: source.url }];
    warnings.add("A native Claude image lacks readable bytes or a URL; its complete native content remains in tool history when available.");
    return [];
  });
}
function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]));
  return String(value);
}
function mapMessages(messages: SessionMessage[], info: SDKSessionInfo, sourceHome: string, snapshot = false): NativeConversation {
  const meta = summary(info);
  const warnings = new Set<string>();
  const turns: NativeHistoryTurn[] = [];
  const calls = new Map<string, NativeHistoryItem>();
  let current: NativeHistoryTurn | undefined;
  let settled = true;
  let model: string | undefined;
  for (const entry of messages) {
    const nativeTimestamp: unknown = Reflect.get(entry, "timestamp");
    const timestamp = typeof nativeTimestamp === "string" && Number.isFinite(Date.parse(nativeTimestamp)) ? new Date(nativeTimestamp).toISOString() : meta.createdAt;
    if (typeof nativeTimestamp !== "string") warnings.add("Claude's native history API omitted some record timestamps; session time bounds are used for those records.");
    const message = object(entry.message);
    const blocks = Array.isArray(message.content) ? message.content.map(object) : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
    const compactSummary = Reflect.get(entry, "isCompactSummary") === true;
    const hasUserContent = entry.type === "user" && !compactSummary && blocks.some(block => block.type !== "tool_result");
    const leadingNotices = current && current.items.every(item => item.kind === "system_notice" || item.kind === "compaction");
    if (hasUserContent && settled && leadingNotices) {
      current!.id = entry.uuid;
    } else if (hasUserContent && settled || !current) {
      current = { id: entry.uuid, status: "completed", startedAt: timestamp, completedAt: timestamp, items: [] };
      turns.push(current);
    }
    const emit = (kind: NativeHistoryItem["kind"], id: string, data: NativeHistoryItem["data"], extra: Partial<NativeHistoryItem> = {}) => {
      const item: NativeHistoryItem = { id, timestamp, status: "completed", kind, data, ...extra };
      current!.items.push(item); return item;
    };
    if (compactSummary) { emit("compaction", entry.uuid, { driver: "claudeAgent", summary: contentText(message.content) }); continue; }
    if (hasUserContent) {
      const attached = images(message.content, entry.uuid, warnings);
      const retained = blocks.map((block, index) => ({ block, index })).filter(({ block }) => !["text", "image", "tool_result"].includes(String(block.type)));
      const references = retained.map(({ block }) => `[${String(block.type || "Unknown")} input: ${String(block.title || block.type || "attachment")}]`);
      emit("user_message", entry.uuid, { text: [contentText(message.content), ...references].filter(Boolean).join("\n\n") }, attached.length ? { images: attached } : {});
      for (const { block, index } of retained) {
        const type = String(block.type || "unknown");
        emit("dynamic_tool", `${entry.uuid}:input:${index}`, { toolName: `claude.input.${type}`, input: {}, output: json(block) }, { title: String(block.title || `${type} input`) });
        warnings.add(`Claude ${type} input has no native T3 attachment presentation; its complete native payload was retained in historical content.`);
      }
      settled = false;
    }
    if (entry.type === "assistant") {
      const synthetic = message.model === "<synthetic>";
      const nativeModel = typeof message.model === "string" && !synthetic ? message.model : undefined;
      if (nativeModel) { model = nativeModel; current!.model ??= model; }
      const provenance = nativeModel ? { model: nativeModel } : {};
      for (const [index, block] of blocks.entries()) {
        const id = `${entry.uuid}:${index}`;
        if (block.type === "text") {
          if (synthetic) emit("system_notice", id, { message: String(block.text || "") });
          else emit("assistant_message", id, { text: String(block.text || ""), phase: message.stop_reason === "tool_use" ? "commentary" : "final_answer" }, provenance);
        }
        else if (block.type === "thinking") emit("reasoning", id, { text: String(block.thinking || "") }, provenance);
        else if (block.type === "tool_use") {
          const input = object(block.input);
          const command = block.name === "Bash" && typeof input.command === "string" ? input.command : undefined;
          const nativeId = typeof block.id === "string" ? block.id : id;
          const item = emit(command ? "command_execution" : "dynamic_tool", nativeId, command ? { input: command, nativeInput: json(input) } : { toolName: String(block.name || "claude.tool"), input: json(input) }, { ...provenance, title: command || String(block.name || "Claude tool"), status: "interrupted" });
          if (calls.has(nativeId)) throw new Error(`Claude SDK returned duplicate tool call '${nativeId}'.`);
          calls.set(nativeId, item);
        } else if (block.type === "image") emit("assistant_message", id, { text: "" }, { ...provenance, images: images([block], id, warnings) });
        else { warnings.add(`Claude block '${String(block.type)}' is retained as generic native content.`); emit("dynamic_tool", id, { toolName: `claude.${String(block.type)}`, input: {}, output: json(block) }, provenance); }
      }
      settled = ["end_turn", "stop_sequence"].includes(String(message.stop_reason));
      if (message.stop_reason == null && blocks.some(block => block.type === "text") && !blocks.some(block => block.type === "tool_use") && !current!.items.some(item => (item.kind === "command_execution" || item.kind === "dynamic_tool") && item.status === "interrupted")) {
        settled = true;
        warnings.add("Some persisted Claude text replies omit a stop reason; they are treated as settled historical replies when no native tool call remains unfinished. The SDK history API does not expose live process ownership.");
      }
      if (message.stop_reason === "max_tokens") { current!.status = "interrupted"; settled = true; }
      if (synthetic) settled = true;
    }
    if (entry.type === "user") for (const [index, block] of blocks.entries()) if (block.type === "tool_result") {
      const call = typeof block.tool_use_id === "string" ? calls.get(block.tool_use_id) : undefined;
      const status = block.is_error === true ? "failed" : "completed";
      if (call) { call.status = status; call.data.output = call.kind === "command_execution" ? contentText(block.content) : json(block.content); if (block.is_error === true) call.data.outputIndicatesFailure = true; const attached = images(block.content, entry.uuid, warnings); if (attached.length) call.images = [...(call.images ?? []), ...attached]; }
      else { warnings.add("A native Claude tool result has no initiating call in the selected history; its complete content was retained."); emit("dynamic_tool", `${entry.uuid}:tool-result:${index}`, { toolName: "claude.tool_result", input: {}, output: json(block) }, { status }); }
    }
    if (entry.type === "system") {
      if (entry.message === undefined) warnings.add("Claude SDK omitted the payload of native system records, including possible compaction boundaries; their positions remain visible, and native compaction summaries are retained when provided.");
      emit("system_notice", entry.uuid, { message: contentText(message.content) || `Claude ${String(message.subtype || "system notice (payload unavailable in native SDK)")}`, nativeContent: json(message) });
    }
    current!.completedAt = timestamp;
    if (Reflect.get(entry, "interruptedByShutdown") === true) { current!.status = "interrupted"; settled = true; }
  }
  if (!settled && current) current.status = "interrupted";
  if (snapshot) warnings.add("Claude snapshot imported without live process ownership verification; unfinished native tails remain interrupted and this history cannot bind a continuation. Use a copied, stable native store.");
  return { ...meta, ...(model ? { model } : {}), sourceHome, nativeSessionRef: info.sessionId, driver: "claudeAgent", turns, warnings: [...warnings], active: !settled && !snapshot, ...(snapshot ? { resumeSupported: false } : {}) };
}
async function execute(request: Request): Promise<NativeSourceSummary[] | NativeConversation> {
  if (!request || !["list", "read"].includes(request.operation)) throw new Error("Invalid Claude history operation.");
  if (request.options.archived) throw new Error("Claude SDK has no native archived-session listing; omit --archived.");
  const options = request.options.workspace ? { dir: canonical(request.options.workspace) } : {};
  if (request.operation === "list") {
    const sessions = await listSessions({ ...options, includeWorktrees: false });
    return sessions.map(summary).filter(info => (!request.options.workspace || samePath(info.workspace, request.options.workspace)) && (!request.options.since || Date.parse(info.updatedAt) >= Date.parse(request.options.since)));
  }
  if (!request.id) throw new Error("Claude session ID is required.");
  const info = await getSessionInfo(request.id, options);
  if (!info) throw new Error(`Claude session '${request.id}' was not found by its native SDK.`);
  if (!info.cwd || request.options.workspace && !samePath(info.cwd, request.options.workspace)) throw new Error("Claude session has no matching workspace.");
  const messages = await getSessionMessages(request.id, { ...options, includeSystemMessages: true });
  if (!messages.length) throw new Error("Claude SDK returned no historical messages.");
  const result = mapMessages(messages, info, request.sourceHome, request.options.snapshot);
  const agents = new Map<string, { conversation: NativeConversation; parentAgent: string | null }>();
  for (const agentId of (await listSubagents(request.id, options)).sort()) {
    const entries = await getSubagentMessages(request.id, agentId, options);
    if (!entries.length) { result.warnings.push(`Native Claude subagent '${agentId}' has no readable selected history; it was omitted.`); continue; }
    const child = mapMessages(entries, info, request.sourceHome, request.options.snapshot);
    child.id = `${request.id}:agent:${agentId}`;
    child.nativeSessionRef = child.id;
    child.resumeSupported = false;
    child.title = `Claude subagent ${agentId}`;
    const toolUseId = entries.find(entry => entry.parent_tool_use_id)?.parent_tool_use_id;
    const parentAgent = entries.find(entry => entry.parent_agent_id)?.parent_agent_id ?? null;
    child.parent = { sourceId: parentAgent ? `${request.id}:agent:${parentAgent}` : request.id, ...(toolUseId ? { nativeItemId: toolUseId } : {}) };
    child.createdAt = child.turns[0]!.startedAt;
    child.updatedAt = child.turns.at(-1)!.completedAt;
    agents.set(agentId, { conversation: child, parentAgent });
  }
  for (const [agentId, { conversation: child, parentAgent }] of agents) {
    const visited = new Set([agentId]);
    let parent = parentAgent;
    while (parent && agents.has(parent)) {
      if (visited.has(parent)) throw new Error("Claude native subagent metadata contains a parent cycle.");
      visited.add(parent); parent = agents.get(parent)!.parentAgent;
    }
    const owner = parentAgent ? agents.get(parentAgent)?.conversation : result;
    if (!owner) { result.warnings.push(`Claude subagent '${agentId}' names an unavailable native parent; it is attached to the root with an explicit warning.`); child.parent = { sourceId: result.id }; }
    const parentConversation = owner ?? result;
    const launch = child.parent?.nativeItemId ? parentConversation.turns.flatMap(turn => turn.items).find(item => item.id === child.parent!.nativeItemId) : undefined;
    const input = object(launch?.data.input);
    if (typeof input.description === "string" && input.description.trim()) child.title = input.description;
    (parentConversation.children ??= []).push(child);
  }
  const after = await getSessionInfo(request.id, options);
  if (!after || info.lastModified !== after.lastModified || info.fileSize !== after.fileSize) { result.active = true; result.warnings.push("Claude source changed while reading; wait for it to settle."); }
  return result;
}
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  process.stdout.write(JSON.stringify({ ok: true, value: await execute(JSON.parse(Buffer.concat(chunks).toString("utf8"))) }));
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); }
