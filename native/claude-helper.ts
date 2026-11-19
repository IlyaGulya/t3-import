import {
  getSessionInfo,
  getSessionMessages,
  importSessionToStore,
  getSubagentMessages,
  listSessions,
  listSubagents,
  type SDKSessionInfo,
  type SessionMessage,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeToolCard, completeClaudeToolCard } from "./claude-tools.js";
import { sendClaudeValue, sendClaudeError } from "./claude-transport.js";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
  NativeConversation,
  NativeHistoryItem,
  NativeHistoryTurn,
  NativeImage,
  NativeReadOptions,
  JsonValue,
  NativeSourceSummary,
} from "../src/native/types.js";

interface Request {
  operation: "list" | "read";
  options: NativeReadOptions;
  sourceHome: string;
  id?: string;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function canonical(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}
function samePath(a: string, b: string): boolean {
  const x = canonical(a),
    y = canonical(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}
function iso(value: number | undefined, fallback: string): string {
  return value !== undefined && Number.isFinite(value) ? new Date(value).toISOString() : fallback;
}
function summary(info: SDKSessionInfo): NativeSourceSummary {
  const updatedAt = iso(info.lastModified, "1970-01-01T00:00:00.000Z");
  return {
    source: "claude",
    id: info.sessionId,
    title: info.customTitle || info.summary || "Claude session",
    workspace: info.cwd || "",
    createdAt: iso(info.createdAt, updatedAt),
    updatedAt,
  };
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .flatMap((block) => {
          const entry = object(block);
          return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
        })
        .join("\n\n")
    : "";
}
// Same native abort rows recognized by T3's ClaudeAdapterV2.claudeResumeSessionAt.
function isUserInterruption(entry: SessionMessage): boolean {
  if (entry.type !== "user") return false;
  const content = object(entry.message).content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return (
    Array.isArray(blocks) &&
    blocks.length > 0 &&
    blocks.every((value) => {
      const block = object(value);
      return (
        block.type === "text" &&
        (block.text === "[Request interrupted by user]" ||
          block.text === "[Request interrupted by user for tool use]")
      );
    })
  );
}
function isLocalCommandRecord(
  entry: SessionMessage,
  native: SessionStoreEntry | undefined,
): boolean {
  if (entry.type === "system")
    return (
      native?.subtype === "local_command" &&
      /^<(?:command-name|command-message|local-command-(?:stdout|stderr|caveat))>/u.test(
        contentText(native.content).trimStart(),
      )
    );
  if (entry.type !== "user") return false;
  const content = object(entry.message).content;
  if (typeof content !== "string") return false;
  // T3's Claude adapter treats CLI local-command stdout as a turnless echo.
  if (content.startsWith("<local-command-stdout>")) return true;
  const command =
    /^<command-name>\/(compact|context|cost|usage|stats|status|model|permissions|config|help|clear|exit)<\/command-name>[\s\S]*<command-args>[\s\S]*<\/command-args>\s*$/u;
  return command.test(content);
}
function images(content: unknown, id: string, warnings: Set<string>): NativeImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap<NativeImage>((value, index) => {
    const block = object(value),
      source = object(block.source);
    if (block.type !== "image") return [];
    const name = `${id}-${index}`;
    if (
      source.type === "base64" &&
      typeof source.data === "string" &&
      typeof source.media_type === "string"
    )
      return [
        {
          id: name,
          name: `${name}.${source.media_type.split("/")[1] || "png"}`,
          mimeType: source.media_type,
          base64: source.data,
        },
      ];
    if (source.type === "url" && typeof source.url === "string")
      return [{ id: name, name: `${name}.png`, mimeType: "image/png", url: source.url }];
    warnings.add(
      "A native Claude image lacks readable bytes or a URL; its complete native content remains in tool history when available.",
    );
    return [];
  });
}
function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, json(child)]),
    );
  return String(value);
}
function supplementalRecord(entry: SessionStoreEntry): SessionStoreEntry {
  const message = object(entry.message);
  const { content: _content, ...header } = message;
  return {
    ...entry,
    ...(entry.message === undefined
      ? {}
      : { message: Object.keys(message).length ? header : entry.message }),
  };
}
function recordDigest(
  digests: Map<string, ReturnType<typeof createHash>>,
  key: string,
  entries: SessionStoreEntry[],
): void {
  let digest = digests.get(key);
  if (!digest) digests.set(key, (digest = createHash("sha256")));
  for (const entry of entries) digest.update(JSON.stringify(entry)).update("\n");
}

/** Ask the SDK to select each saved compaction epoch; never walk parentUuid links here. */
async function historicalEpochs(
  sessionId: string,
  records: SessionStoreEntry[],
  tail: SessionMessage[],
) {
  const positions = new Map<string, number[]>();
  for (const [index, entry] of records.entries()) {
    if (!entry.uuid) continue;
    const occurrences = positions.get(entry.uuid) ?? [];
    occurrences.push(index);
    positions.set(entry.uuid, occurrences);
  }
  const before = (uuid: string, limit: number) =>
    positions.get(uuid)?.findLast((index) => index < limit);
  const epochs = [tail];
  const warnings: string[] = [];
  const visited = new Set<string>();
  let current = tail,
    ceiling = records.length;
  while (true) {
    const boundary = current.findLast(
      (entry) =>
        !visited.has(entry.uuid) &&
        records[before(entry.uuid, ceiling) ?? -1]?.subtype === "compact_boundary",
    );
    if (!boundary) break;
    visited.add(boundary.uuid);
    const boundaryIndex = before(boundary.uuid, ceiling)!;
    const native = records[boundaryIndex]!;
    const anchor =
      typeof native.logicalParentUuid === "string" ? native.logicalParentUuid : undefined;
    if (!anchor || current.some((entry) => entry.uuid === anchor)) continue;
    const anchorIndex = before(anchor, boundaryIndex);
    if (anchorIndex === undefined && positions.has(anchor)) {
      warnings.push(
        `native_history_gap: compaction '${boundary.uuid}' names a saved head outside its preceding epoch; retained the SDK-selected history.`,
      );
      continue;
    }
    const cut = anchorIndex === undefined ? boundaryIndex : anchorIndex + 1;
    ceiling = cut;
    if (anchorIndex === undefined)
      warnings.push(
        `native_history_gap: compaction '${boundary.uuid}' names an absent saved head; the SDK selects the available preceding epoch without inventing missing records.`,
      );
    if (!cut) continue;
    const previous = await getSessionMessages(sessionId, {
      includeSystemMessages: true,
      sessionStore: {
        async load() {
          return records.slice(0, cut);
        },
        async append() {
          throw new Error("Claude historical epoch store is read-only.");
        },
      },
    });
    if (
      anchorIndex !== undefined &&
      ["user", "assistant"].includes(records[anchorIndex]!.type) &&
      previous.at(-1)?.uuid !== anchor
    )
      throw new Error("Claude SDK disagrees with the saved pre-compaction head.");
    epochs.unshift(previous);
    current = previous;
  }
  const selected = new Map<string, SessionMessage>();
  for (const epoch of epochs) for (const entry of epoch) selected.set(entry.uuid, entry);
  return { messages: [...selected.values()], warnings };
}

function mapMessages(
  messages: SessionMessage[],
  info: SDKSessionInfo,
  sourceHome: string,
  snapshot = false,
  metadata = new Map<string, SessionStoreEntry>(),
): NativeConversation {
  const meta = summary(info);
  const warnings = new Set<string>();
  const turns: NativeHistoryTurn[] = [];
  const calls = new Map<string, NativeHistoryItem>();
  const toolInputs = new Map<string, Record<string, unknown>>();
  const toolNames = new Map<string, string>();
  const fileSnapshots = new Map<string, NonNullable<NativeConversation["fileSnapshots"]>[number]>();
  let current: NativeHistoryTurn | undefined;
  let settled = true;
  let model: string | undefined;
  let pendingCompaction: NativeHistoryItem | undefined;
  const nativeMetadata: JsonValue[] = [];
  const mapped = new Set<string>();
  const retained = new Set<string>();
  let currentProviderError = false;
  const interruptedReplies = new Set<string>();
  const toolResponses = new Set<string>();
  let precedingAssistant: string | undefined;
  for (const entry of messages) {
    const message = object(entry.message);
    if (
      entry.type === "assistant" &&
      typeof message.id === "string" &&
      Array.isArray(message.content) &&
      message.content.some((block) => object(block).type === "tool_use")
    )
      toolResponses.add(message.id);
    if (entry.type === "assistant") precedingAssistant = entry.uuid;
    else if (isUserInterruption(entry)) {
      if (precedingAssistant) interruptedReplies.add(precedingAssistant);
    } else if (entry.type === "user") precedingAssistant = undefined;
  }
  for (const entry of messages) {
    const native = metadata.get(entry.uuid);
    if (entry.type !== "system") {
      nativeMetadata.push({
        type: "record_metadata",
        uuid: entry.uuid,
        payload: json(supplementalRecord(native ?? { ...entry })),
      });
      retained.add(entry.uuid);
    }
    if (isLocalCommandRecord(entry, native)) {
      nativeMetadata.push({
        type: "local_command_record",
        uuid: entry.uuid,
        payload: json({ ...native, ...entry, message: entry.message }),
      });
      retained.add(entry.uuid);
      continue;
    }
    if (entry.type === "system") {
      if (native) nativeMetadata.push(json(native));
      retained.add(entry.uuid);
      if (
        native?.subtype === "turn_duration" ||
        (native?.subtype !== "compact_boundary" &&
          !contentText(native?.content) &&
          !contentText(object(entry.message).content))
      ) {
        if (!native || native.subtype !== "turn_duration")
          warnings.add(
            `Claude system record '${String(native?.subtype ?? "unknown")}' was retained in native metadata without a fabricated chat notice.`,
          );
        if (!native) nativeMetadata.push(json(entry));
        continue;
      }
    }
    const nativeTimestamp: unknown = Reflect.get(entry, "timestamp");
    const timestamp =
      typeof nativeTimestamp === "string" && Number.isFinite(Date.parse(nativeTimestamp))
        ? new Date(nativeTimestamp).toISOString()
        : meta.createdAt;
    if (typeof nativeTimestamp !== "string")
      warnings.add(
        "Claude's native history API omitted some record timestamps; session time bounds are used for those records.",
      );
    const message = object(entry.message);
    const blocks = Array.isArray(message.content)
      ? message.content.map(object)
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [];
    const compactSummary = Reflect.get(entry, "isCompactSummary") === true;
    const interruption = isUserInterruption(entry);
    const hasUserContent =
      entry.type === "user" &&
      !interruption &&
      !compactSummary &&
      blocks.some((block) => block.type !== "tool_result");
    const leadingNotices =
      current &&
      current.items.every((item) => item.kind === "system_notice" || item.kind === "compaction");
    if (hasUserContent && settled && leadingNotices) {
      current!.id = entry.uuid;
      current!.startedAt = timestamp;
    } else if ((hasUserContent && settled) || !current) {
      current = {
        id: entry.uuid,
        status: "completed",
        startedAt: timestamp,
        completedAt: timestamp,
        items: [],
      };
      turns.push(current);
      currentProviderError = false;
    }
    const emit = (
      kind: NativeHistoryItem["kind"],
      id: string,
      data: NativeHistoryItem["data"],
      extra: Partial<NativeHistoryItem> = {},
    ) => {
      const item: NativeHistoryItem = { id, timestamp, status: "completed", kind, data, ...extra };
      current!.items.push(item);
      mapped.add(entry.uuid);
      return item;
    };
    if (interruption) {
      emit("run_interrupt_result", entry.uuid, { message: contentText(message.content) });
      current!.status = "interrupted";
      current!.completedAt = timestamp;
      settled = true;
      continue;
    }
    if (compactSummary) {
      mapped.add(entry.uuid);
      if (pendingCompaction) pendingCompaction.data.summary = contentText(message.content);
      else
        emit("compaction", entry.uuid, {
          driver: "claudeAgent",
          summary: contentText(message.content),
        });
      pendingCompaction = undefined;
      continue;
    }
    if (hasUserContent || entry.type === "assistant") pendingCompaction = undefined;
    if (hasUserContent) {
      const attached = images(message.content, entry.uuid, warnings);
      const retained = blocks
        .map((block, index) => ({ block, index }))
        .filter(({ block }) => !["text", "image", "tool_result"].includes(String(block.type)));
      const references = retained.map(
        ({ block }) =>
          `[${String(block.type || "Unknown")} input: ${String(block.title || block.type || "attachment")}]`,
      );
      emit(
        "user_message",
        entry.uuid,
        { text: [contentText(message.content), ...references].filter(Boolean).join("\n\n") },
        attached.length ? { images: attached } : {},
      );
      for (const { block, index } of retained) {
        const type = String(block.type || "unknown");
        emit(
          "dynamic_tool",
          `${entry.uuid}:input:${index}`,
          { toolName: `claude.input.${type}`, input: {}, output: json(block) },
          { title: String(block.title || `${type} input`) },
        );
        warnings.add(
          `Claude ${type} input has no native T3 attachment presentation; its complete native payload was retained in historical content.`,
        );
      }
      settled = false;
    }
    if (entry.type === "assistant") {
      if (
        (settled || contentText(message.content).trim() === "No response requested.") &&
        message.model === "<synthetic>" &&
        !interruptedReplies.has(entry.uuid) &&
        native?.isApiErrorMessage !== true
      ) {
        for (const [index, block] of blocks.entries())
          if (block.type === "text")
            emit("system_notice", `${entry.uuid}:${index}`, {
              message: String(block.text || ""),
              level: "info",
            });
        // This native acknowledgement is session activity, even when the preceding
        // response ended with settled tool results rather than a final text block.
        // An unfinished tool still keeps the historical tail interrupted.
        if (!current!.items.some((item) => calls.has(item.id) && item.status === "interrupted"))
          settled = true;
        continue;
      }
      if (currentProviderError) {
        current!.status = "completed";
        currentProviderError = false;
      }
      const synthetic = message.model === "<synthetic>";
      const nativeModel =
        typeof message.model === "string" && !synthetic ? message.model : undefined;
      if (nativeModel) {
        model = nativeModel;
        current!.model ??= model;
      }
      const provenance = nativeModel ? { model: nativeModel } : {};
      for (const [index, block] of blocks.entries()) {
        const id = `${entry.uuid}:${index}`;
        if (block.type === "text") {
          if (synthetic && !interruptedReplies.has(entry.uuid))
            emit("system_notice", id, {
              message: String(block.text || ""),
              level: native?.isApiErrorMessage === true ? "error" : "info",
            });
          else
            emit(
              "assistant_message",
              id,
              {
                text: String(block.text || ""),
                phase:
                  message.stop_reason === "tool_use" ||
                  (typeof message.id === "string" && toolResponses.has(message.id)) ||
                  blocks.some((block) => block.type === "tool_use")
                    ? "commentary"
                    : "final_answer",
              },
              {
                ...provenance,
                ...(interruptedReplies.has(entry.uuid) ? { status: "interrupted" as const } : {}),
              },
            );
        } else if (block.type === "thinking")
          emit("reasoning", id, { text: String(block.thinking || "") }, provenance);
        else if (block.type === "tool_use") {
          const input = object(block.input);
          const nativeId = typeof block.id === "string" ? block.id : id;
          const card = claudeToolCard(String(block.name || "claude.tool"), input);
          const item = emit(card.kind, nativeId, card.data, {
            ...provenance,
            title: card.title!,
            status: "interrupted",
          });
          toolInputs.set(nativeId, input);
          toolNames.set(nativeId, String(block.name));
          nativeMetadata.push({
            type: "tool_use",
            uuid: nativeId,
            toolName: String(block.name || "claude.tool"),
            input: json(input),
          });
          if (calls.has(nativeId))
            throw new Error(`Claude SDK returned duplicate tool call '${nativeId}'.`);
          calls.set(nativeId, item);
        } else if (block.type === "image")
          emit(
            "assistant_message",
            id,
            { text: "" },
            { ...provenance, images: images([block], id, warnings) },
          );
        else {
          warnings.add(
            `Claude block '${String(block.type)}' is retained as generic native content.`,
          );
          emit(
            "dynamic_tool",
            id,
            { toolName: `claude.${String(block.type)}`, input: {}, output: json(block) },
            provenance,
          );
        }
      }
      settled = ["end_turn", "stop_sequence"].includes(String(message.stop_reason));
      if (
        message.stop_reason == null &&
        blocks.some((block) => block.type === "text") &&
        !blocks.some((block) => block.type === "tool_use") &&
        !current!.items.some((item) => calls.has(item.id) && item.status === "interrupted")
      ) {
        settled = true;
        warnings.add(
          "Some persisted Claude text replies omit a stop reason; they are treated as settled historical replies when no native tool call remains unfinished. The SDK history API does not expose live process ownership.",
        );
      }
      if (message.stop_reason === "max_tokens") {
        current!.status = "interrupted";
        settled = true;
      }
      if (synthetic) settled = true;
      if (native?.isApiErrorMessage === true) {
        current!.status = "failed";
        currentProviderError = true;
        settled = true;
      }
    }
    if (entry.type === "user")
      for (const [index, block] of blocks.entries())
        if (block.type === "tool_result") {
          const call =
            typeof block.tool_use_id === "string" ? calls.get(block.tool_use_id) : undefined;
          const status = block.is_error === true ? "failed" : "completed";
          if (call) {
            call.status = status;
            call.startedAt = call.timestamp;
            call.completedAt = timestamp;
            mapped.add(entry.uuid);
            completeClaudeToolCard(
              call,
              toolInputs.get(call.id)!,
              json(block.content),
              metadata.get(entry.uuid)?.toolUseResult,
            );
            if (status === "completed") {
              const input = toolInputs.get(call.id)!,
                name = toolNames.get(call.id);
              const file = object(object(metadata.get(entry.uuid)?.toolUseResult).file);
              let path: string | undefined, content: string | undefined;
              if (
                name === "Write" &&
                typeof input.file_path === "string" &&
                typeof input.content === "string"
              ) {
                path = resolve(info.cwd!, input.file_path);
                content = input.content;
              } else if (
                name === "Read" &&
                typeof file.filePath === "string" &&
                typeof file.content === "string" &&
                file.startLine === 1 &&
                typeof file.numLines === "number" &&
                file.numLines === file.totalLines
              ) {
                path = resolve(info.cwd!, file.filePath);
                content = file.content;
              } else if (name === "Edit" && typeof input.file_path === "string") {
                path = resolve(info.cwd!, input.file_path);
                const prior = fileSnapshots.get(path)?.content;
                if (
                  prior !== undefined &&
                  typeof input.old_string === "string" &&
                  input.old_string &&
                  typeof input.new_string === "string"
                ) {
                  const parts = prior.split(input.old_string);
                  if (parts.length === 2 || (parts.length > 2 && input.replace_all === true))
                    content = parts.join(input.new_string);
                }
                if (content === undefined) fileSnapshots.delete(path);
              }
              if (path !== undefined && content !== undefined)
                fileSnapshots.set(path, { path, content, nativeItemId: call.id, timestamp });
            }
            nativeMetadata.push({
              type: "tool_result",
              uuid: `${entry.uuid}:${index}`,
              toolUseId: call.id,
              output: json(block.content),
              ...(metadata.get(entry.uuid)?.toolUseResult !== undefined
                ? { structured: json(metadata.get(entry.uuid)!.toolUseResult) }
                : {}),
            });
            if (block.is_error === true) call.data.outputIndicatesFailure = true;
            const attached = images(block.content, entry.uuid, warnings);
            if (attached.length) call.images = [...(call.images ?? []), ...attached];
          } else {
            warnings.add(
              "A native Claude tool result has no initiating call in the selected history; its complete content was retained.",
            );
            emit(
              "dynamic_tool",
              `${entry.uuid}:tool-result:${index}`,
              { toolName: "claude.tool_result", input: {}, output: json(block) },
              { status },
            );
          }
        }
    if (entry.type === "system" && native?.subtype === "compact_boundary") {
      const compact = object(native.compactMetadata);
      pendingCompaction = emit(
        "compaction",
        entry.uuid,
        {
          driver: "claudeAgent",
          ...(typeof compact.preTokens === "number" &&
          Number.isInteger(compact.preTokens) &&
          compact.preTokens >= 0
            ? { beforeTokenCount: compact.preTokens }
            : {}),
        },
        { title: "Compacting context" },
      );
    } else if (entry.type === "system") {
      const nativeLevel = native?.level;
      const level =
        nativeLevel === "info" || nativeLevel === "warning" || nativeLevel === "error"
          ? nativeLevel
          : native?.subtype === "away_summary" || native?.subtype === "local_command"
            ? "info"
            : undefined;
      emit("system_notice", entry.uuid, {
        message: contentText(native?.content) || contentText(message.content),
        ...(level === undefined ? {} : { level }),
      });
    }
    if (entry.type !== "system" || !settled) current!.completedAt = timestamp;
    if (Reflect.get(entry, "interruptedByShutdown") === true) {
      current!.status = "interrupted";
      settled = true;
    }
  }
  if (!settled && current) current.status = "interrupted";
  if (snapshot)
    warnings.add(
      "Claude snapshot imported without live process ownership verification; unfinished native tails remain interrupted and this history cannot bind a continuation. Use a copied, stable native store.",
    );
  return {
    ...meta,
    ...(model ? { model } : {}),
    sourceHome,
    nativeSessionRef: info.sessionId,
    driver: "claudeAgent",
    nativeMetadata,
    ...(fileSnapshots.size ? { fileSnapshots: [...fileSnapshots.values()] } : {}),
    sourceCoverage: {
      schemaVersion: 1,
      selectedRecords: messages.length,
      mappedRecords: mapped.size,
      metadataOnlyRecords: messages.filter(
        (entry) => !mapped.has(entry.uuid) && retained.has(entry.uuid),
      ).length,
      missingRecordIds: messages
        .filter((entry) => !mapped.has(entry.uuid) && !retained.has(entry.uuid))
        .map((entry) => entry.uuid),
      nativeKinds: Object.fromEntries(
        [...new Set(messages.map((entry) => entry.type))].map((type) => [
          type,
          messages.filter((entry) => entry.type === type).length,
        ]),
      ),
    },
    turns,
    warnings: [...warnings],
    active: !settled && !snapshot,
    ...(snapshot ? { resumeSupported: false } : {}),
  };
}
async function execute(request: Request): Promise<NativeSourceSummary[] | NativeConversation> {
  if (!request || !["list", "read"].includes(request.operation))
    throw new Error("Invalid Claude history operation.");
  if (request.options.archived)
    throw new Error("Claude SDK has no native archived-session listing; omit --archived.");
  const options = request.options.workspace ? { dir: canonical(request.options.workspace) } : {};
  if (request.operation === "list") {
    const sessions = await listSessions({ ...options, includeWorktrees: false });
    return sessions
      .map(summary)
      .filter(
        (info) =>
          (!request.options.workspace || samePath(info.workspace, request.options.workspace)) &&
          (!request.options.since ||
            Date.parse(info.updatedAt) >= Date.parse(request.options.since)),
      );
  }
  if (!request.id) throw new Error("Claude session ID is required.");
  let info = await getSessionInfo(request.id, options);
  let fallbackDigest: string | undefined;
  if (!info) {
    // The file metadata reader samples the head/tail and can miss a first
    // request longer than that window. The SDK's complete store import still
    // decodes it. Limit message text only in this metadata-only view; history
    // below remains the unmodified result of the full native history reader.
    const records: SessionStoreEntry[] = [];
    const digest = createHash("sha256");
    await importSessionToStore(
      request.id,
      {
        async append(_key, entries) {
          for (const entry of entries) digest.update(JSON.stringify(entry)).update("\n");
          records.push(...entries);
        },
        async load() {
          return null;
        },
      },
      { ...options, includeSubagents: false },
    );
    fallbackDigest = digest.digest("hex");
    info = await getSessionInfo(request.id, {
      sessionStore: {
        async load() {
          return records.map((entry) => {
            const message = object(entry.message);
            return entry.message === undefined
              ? entry
              : {
                  ...entry,
                  message: { ...message, content: contentText(message.content).slice(0, 512) },
                };
          });
        },
        async append() {
          throw new Error("Claude metadata history store is read-only.");
        },
      },
    });
    const lastNativeTime = records.findLast(
      (entry) =>
        typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)),
    )?.timestamp;
    if (info && lastNativeTime) {
      const { fileSize: _fileSize, ...metadataInfo } = info;
      info = { ...metadataInfo, lastModified: Date.parse(lastNativeTime) };
    } else info = undefined;
  }
  if (!info) throw new Error(`Claude session '${request.id}' was not found by its native SDK.`);
  if (info.cwd && request.options.workspace && !samePath(info.cwd, request.options.workspace))
    throw new Error("Claude session has no matching workspace.");
  let historyInfo = info;
  const messages = await getSessionMessages(request.id, {
    ...options,
    includeSystemMessages: true,
  });
  if (!messages.length) throw new Error("Claude SDK returned no historical messages.");
  // The SDK owns branch selection and file parsing. Enrich one selected
  // history at a time as its native store batches arrive, without retaining
  // another full copy of a large subagent family.
  const discoveredAgents = await listSubagents(request.id, options);
  const agentIds = new Set(discoveredAgents);
  const duplicateAgents = new Set(
    discoveredAgents.filter((agent, index) => discoveredAgents.indexOf(agent) !== index),
  );
  const agents = new Map<
    string,
    {
      conversation: NativeConversation;
      parentAgent: string | null;
      matchedRecords: number;
      metadataRecords: number;
    }
  >();
  let root: NativeConversation | undefined;
  let rootMessages = new Map<string, SessionMessage>();
  let currentKey = "";
  let currentAgent: string | undefined;
  let currentMessages = messages;
  let selected = new Set(currentMessages.map((entry) => entry.uuid));
  let metadata = new Map<string, SessionStoreEntry>();
  let matched = new Set<string>();
  let childRecords: SessionStoreEntry[] = [];
  const finishHistory = async () => {
    if (currentKey === "") {
      const history = await historicalEpochs(request.id!, childRecords, currentMessages);
      currentMessages = history.messages;
      rootMessages = new Map(currentMessages.map((entry) => [entry.uuid, entry]));
      selected = new Set(currentMessages.map((entry) => entry.uuid));
      const recoveredWorkspace = !info.cwd
        ? childRecords.findLast(
            (entry) =>
              entry.uuid &&
              selected.has(entry.uuid) &&
              typeof entry.cwd === "string" &&
              isAbsolute(entry.cwd),
          )?.cwd
        : undefined;
      if (typeof recoveredWorkspace === "string")
        historyInfo = { ...info, cwd: recoveredWorkspace };
      if (
        !historyInfo.cwd ||
        (request.options.workspace && !samePath(historyInfo.cwd, request.options.workspace))
      )
        throw new Error("Claude session has no matching workspace.");
      metadata = new Map(
        childRecords
          .filter((entry) => entry.uuid && selected.has(entry.uuid))
          .map((entry) => [
            entry.uuid!,
            entry.type === "system" ? entry : supplementalRecord(entry),
          ]),
      );
      root = mapMessages(
        currentMessages,
        historyInfo,
        request.sourceHome,
        request.options.snapshot,
        metadata,
      );
      root.warnings.push(...history.warnings);
      if (recoveredWorkspace)
        root.warnings.push("Claude workspace recovered from its selected native history.");
    } else if (currentAgent) {
      if (!duplicateAgents.has(currentAgent)) {
        // The SDK already decoded this transcript and its sidecar. Reuse its
        // store reader rather than recursively rediscovering the whole family
        // once per unique agent (quadratic filesystem work on large archives).
        currentMessages = await getSubagentMessages(request.id!, currentAgent, {
          sessionStore: {
            async listSubkeys() {
              return [currentKey];
            },
            async load() {
              return childRecords;
            },
            async append() {
              throw new Error("The scoped Claude child store is read-only.");
            },
          },
        });
      }
      if (!currentMessages.length) return;
      // The child API drops system records before walking its chain, which can
      // sever earlier messages. Scope this one transcript as its own conversation
      // and let the SDK's full history reader resolve compaction/branches. The
      // child API's last selected UUID fixes the head; no parent-link walk lives here.
      const head = currentMessages.at(-1)!;
      const cut = childRecords.findLastIndex((entry) => entry.uuid === head.uuid);
      if (cut < 0) return; // A duplicate agent ID at a different native subpath.
      const scoped = childRecords
        .slice(0, cut + 1)
        .map((entry) => ({ ...entry, isSidechain: false, isMeta: false, teamName: undefined }));
      const scopedStore = {
        async load() {
          return scoped;
        },
        async append() {
          throw new Error("The scoped Claude history store is read-only.");
        },
      };
      const complete = await getSessionMessages(request.id!, {
        includeSystemMessages: true,
        sessionStore: scopedStore,
      });
      const scopedInfo = await getSessionInfo(request.id!, { sessionStore: scopedStore });
      if (complete.at(-1)?.uuid !== head.uuid)
        throw new Error("Claude native history readers disagree on the selected child head.");
      const history = await historicalEpochs(request.id!, scoped, complete);
      currentMessages = history.messages.map((entry) => ({
        ...entry,
        parent_tool_use_id: head.parent_tool_use_id,
        parent_agent_id: head.parent_agent_id,
      }));
      const inherited = currentMessages.filter((entry) => {
        const original = rootMessages.get(entry.uuid);
        return (
          original &&
          JSON.stringify(object(original.message).content) ===
            JSON.stringify(object(entry.message).content)
        );
      });
      // Native context forks can rewrite the leading prompt UUID while keeping
      // the following assistant UUIDs. Only the identical prefix before that
      // proven shared context is inherited; later repeated questions stay visible.
      const inheritedSourceIds = new Map(inherited.map((entry) => [entry.uuid, entry.uuid]));
      if (
        !head.parent_tool_use_id &&
        !head.parent_agent_id &&
        inherited.some((entry) => entry.type === "assistant")
      ) {
        const sharedIds = new Set(inherited.map((entry) => entry.uuid));
        const firstShared = currentMessages.findIndex((entry) => sharedIds.has(entry.uuid));
        const prompts = new Map(
          [...rootMessages.values()]
            .filter((entry) => entry.type === "user")
            .map((entry) => [JSON.stringify(object(entry.message).content), entry.uuid]),
        );
        for (const entry of currentMessages.slice(0, firstShared)) {
          const original =
            entry.type === "user"
              ? prompts.get(JSON.stringify(object(entry.message).content))
              : undefined;
          if (original) {
            inherited.push(entry);
            inheritedSourceIds.set(entry.uuid, original);
          }
        }
      }
      const inheritedIds = new Set(inherited.map((entry) => entry.uuid));
      currentMessages = currentMessages.filter((entry) => !inheritedIds.has(entry.uuid));
      if (!currentMessages.length) return;
      selected = new Set(currentMessages.map((entry) => entry.uuid));
      metadata = new Map();
      matched = new Set();
      for (const entry of childRecords)
        if (entry.uuid && selected.has(entry.uuid)) {
          matched.add(entry.uuid);
          if (entry.type === "system") metadata.set(entry.uuid, entry);
          else metadata.set(entry.uuid, supplementalRecord(entry));
        }
      // Native discovery can repeat an ID at distinct subpaths. Branch choice
      // still comes exclusively from getSubagentMessages; an unrelated stream
      // must not overwrite the selected history's richer metadata.
      const prior = agents.get(currentAgent);
      if (
        prior &&
        (prior.matchedRecords > matched.size ||
          (prior.matchedRecords === matched.size && prior.metadataRecords >= metadata.size))
      )
        return;
      const child = mapMessages(
        currentMessages,
        scopedInfo?.cwd ? { ...historyInfo, cwd: scopedInfo.cwd } : historyInfo,
        request.sourceHome,
        request.options.snapshot,
        metadata,
      );
      child.warnings.push(...history.warnings);
      if (inherited.length) {
        child.nativeMetadata!.push({
          type: "inherited_history",
          sourceId: request.id!,
          records: inherited.map((entry) => ({
            uuid: entry.uuid,
            sourceUuid: inheritedSourceIds.get(entry.uuid)!,
            header: json(metadata.get(entry.uuid) ?? supplementalRecord(entry)),
            contentSha256: createHash("sha256")
              .update(JSON.stringify(object(entry.message).content) ?? "null")
              .digest("hex"),
          })),
        });
        child.sourceCoverage!.selectedRecords += inherited.length;
        child.sourceCoverage!.metadataOnlyRecords += inherited.length;
        for (const entry of inherited)
          child.sourceCoverage!.nativeKinds[entry.type] =
            (child.sourceCoverage!.nativeKinds[entry.type] ?? 0) + 1;
      }
      if (!scopedInfo?.cwd)
        child.warnings.push(
          "native_child_cwd_unavailable: the SDK supplied no child directory; the parent workspace is retained as an explicit fallback.",
        );
      child.id = `${request.id}:agent:${currentAgent}`;
      child.nativeSessionRef = child.id;
      child.resumeSupported = false;
      child.title = `Claude subagent ${currentAgent}`;
      const toolUseId = currentMessages.find(
        (entry) => entry.parent_tool_use_id,
      )?.parent_tool_use_id;
      const parentAgent =
        currentMessages.find((entry) => entry.parent_agent_id)?.parent_agent_id ?? null;
      child.parent = {
        sourceId: parentAgent ? `${request.id}:agent:${parentAgent}` : request.id!,
        ...(toolUseId ? { nativeItemId: toolUseId } : {}),
      };
      if (inherited.some((entry) => entry.type === "assistant") && !toolUseId && !parentAgent) {
        const parentItems = root!.turns.flatMap((turn) => turn.items);
        const anchor = inherited.toReversed().flatMap((entry) => {
          const content = object(entry.message).content;
          const ids = [
            entry.uuid,
            ...(Array.isArray(content)
              ? content.flatMap((block, index) => [
                  `${entry.uuid}:${index}`,
                  String(object(block).id ?? ""),
                ])
              : []),
          ];
          return parentItems.filter((item) => ids.includes(item.id));
        })[0];
        child.parent = {
          sourceId: request.id!,
          relationship: "fork",
          ...(anchor ? { nativeItemId: anchor.id } : {}),
        };
        child.title = `Claude history fork ${currentAgent}`;
      }
      child.createdAt = child.turns[0]!.startedAt;
      child.updatedAt = child.turns.at(-1)!.completedAt;
      agents.set(currentAgent, {
        conversation: child,
        parentAgent,
        matchedRecords: matched.size,
        metadataRecords: metadata.size,
      });
    }
  };
  const visited = new Set([currentKey]);
  const firstDigests = new Map<string, ReturnType<typeof createHash>>();
  await importSessionToStore(
    request.id,
    {
      async append(key, entries) {
        const nextKey = key.subpath ?? "";
        recordDigest(firstDigests, nextKey, entries);
        if (nextKey !== currentKey) {
          await finishHistory();
          if (visited.has(nextKey))
            throw new Error("Claude SDK repeated a completed native history stream.");
          visited.add(nextKey);
          currentKey = nextKey;
          const name = nextKey.split("/").at(-1) ?? "";
          const agentId = name.startsWith("agent-") ? name.slice(6) : "";
          currentAgent = agentIds.has(agentId) ? agentId : undefined;
          // Duplicate IDs need the SDK's global first-path choice. Unique
          // agents can use the scoped native store once its batches arrive.
          currentMessages =
            currentAgent && duplicateAgents.has(currentAgent)
              ? await getSubagentMessages(request.id!, currentAgent, options)
              : [];
          selected = new Set(currentMessages.map((entry) => entry.uuid));
          metadata = new Map();
          matched = new Set();
          childRecords = [];
        }
        if (currentAgent || currentKey === "") childRecords.push(...entries);
        for (const entry of entries)
          if (entry.uuid && selected.has(entry.uuid)) {
            matched.add(entry.uuid);
            if (entry.type === "system") metadata.set(entry.uuid, entry);
            else metadata.set(entry.uuid, supplementalRecord(entry));
          }
      },
      async load() {
        return null;
      },
    },
    { ...options, includeSubagents: true },
  );
  await finishHistory();
  const beforeFamily = new Map(
    [...firstDigests].map(([key, digest]) => [key, digest.digest("hex")]),
  );
  const lastDigests = new Map<string, ReturnType<typeof createHash>>();
  await importSessionToStore(
    request.id,
    {
      async append(key, entries) {
        recordDigest(lastDigests, key.subpath ?? "", entries);
      },
      async load() {
        return null;
      },
    },
    { ...options, includeSubagents: true },
  );
  const afterFamily = new Map([...lastDigests].map(([key, digest]) => [key, digest.digest("hex")]));
  const familyChanged =
    beforeFamily.size !== afterFamily.size ||
    [...beforeFamily].some(([key, digest]) => afterFamily.get(key) !== digest);
  if (!root) throw new Error("Claude SDK returned no root metadata stream.");
  const result = root;
  // Legacy Claude versions identify spawned agents on the native tool result
  // instead of a child sidecar. Use that explicit identity, never timestamps.
  const launches = new Map<
    string,
    { owner: NativeConversation; parentAgent: string | null; toolUseId: string }
  >();
  for (const [parentAgent, owner] of [
    [null, result],
    ...[...agents].map(([id, value]) => [id, value.conversation] as const),
  ] as const) {
    for (const value of owner.nativeMetadata ?? []) {
      const entry = object(value),
        structured = object(entry.structured);
      if (
        entry.type !== "tool_result" ||
        typeof structured.agentId !== "string" ||
        typeof entry.toolUseId !== "string"
      )
        continue;
      const tool = (owner.nativeMetadata ?? [])
        .map(object)
        .find((item) => item.type === "tool_use" && item.uuid === entry.toolUseId);
      if (!tool || !["Agent", "Task"].includes(String(tool.toolName)) || object(tool.input).resume)
        continue;
      const prior = launches.get(structured.agentId);
      if (prior && (prior.owner.id !== owner.id || prior.toolUseId !== entry.toolUseId))
        throw new Error(
          `Claude native agent '${structured.agentId}' has ambiguous launch identities.`,
        );
      launches.set(structured.agentId, { owner, parentAgent, toolUseId: entry.toolUseId });
    }
  }
  for (const [agentId, record] of agents) {
    if (record.conversation.parent?.relationship === "fork") continue;
    if (record.conversation.parent?.nativeItemId) continue;
    const launch = launches.get(agentId);
    if (!launch) continue;
    record.parentAgent = launch.parentAgent;
    record.conversation.parent = { sourceId: launch.owner.id, nativeItemId: launch.toolUseId };
  }
  for (const agentId of agentIds)
    if (!agents.has(agentId))
      result.warnings.push(
        `Native Claude subagent '${agentId}' has no readable selected history; it was omitted.`,
      );
  for (const [agentId, { conversation: child, parentAgent }] of [...agents].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const visited = new Set([agentId]);
    let parent = parentAgent;
    while (parent && agents.has(parent)) {
      if (visited.has(parent))
        throw new Error("Claude native subagent metadata contains a parent cycle.");
      visited.add(parent);
      parent = agents.get(parent)!.parentAgent;
    }
    const owner = parentAgent ? agents.get(parentAgent)?.conversation : result;
    if (!owner) {
      result.warnings.push(
        `Claude subagent '${agentId}' names an unavailable native parent; it is attached to the root with an explicit warning.`,
      );
      child.parent = { sourceId: result.id };
    }
    const parentConversation = owner ?? result;
    const launch = child.parent?.nativeItemId
      ? parentConversation.turns
          .flatMap((turn) => turn.items)
          .find((item) => item.id === child.parent!.nativeItemId)
      : undefined;
    const input = object(launch?.data.input);
    if (typeof input.description === "string" && input.description.trim())
      child.title = input.description;
    (parentConversation.children ??= []).push(child);
  }
  let changed: boolean;
  if (fallbackDigest) {
    result.warnings.push(
      "native_session_metadata_fallback: the SDK file metadata window could not read this session; metadata uses its scoped store reader and the last native record time instead of file modification time.",
    );
    changed = afterFamily.get("") !== fallbackDigest;
  } else {
    const after = await getSessionInfo(request.id, options);
    changed =
      !after || info.lastModified !== after.lastModified || info.fileSize !== after.fileSize;
  }
  if (changed || familyChanged) {
    result.active = true;
    result.warnings.push("Claude source changed while reading; wait for it to settle.");
  }
  return result;
}
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
  await sendClaudeValue(await execute(request), request.operation === "read");
} catch (error) {
  await sendClaudeError(error);
}
