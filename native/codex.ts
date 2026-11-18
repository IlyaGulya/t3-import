import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { FILE_HEADERS_ONLY, formatPatch, parsePatch, structuredPatch } from "diff";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexClient from "@t3-native/codex/client";
import type * as CodexSchema from "@t3-native/codex/schema";
import type {
  JsonValue,
  NativeConversation,
  NativeHistoryItem,
  NativeHistoryTurn,
  NativeImage,
  NativeReadOptions,
  NativeSourceReader,
  NativeSourceSummary,
  NativeTerminalStatus,
} from "../src/native/types.js";

type RpcMethod = "thread/list" | "thread/read" | "thread/turns/list" | "thread/items/list";
type RpcResponses = {
  "thread/list": CodexSchema.V2ThreadListResponse;
  "thread/read": CodexSchema.V2ThreadReadResponse;
  "thread/turns/list": CodexSchema.V2ThreadTurnsListResponse;
  "thread/items/list": CodexSchema.V2ThreadItemsListResponse;
};
type Thread = CodexSchema.V2ThreadReadResponse__Thread;
type Turn = CodexSchema.V2ThreadTurnsListResponse__Turn;
type Item = CodexSchema.V2ThreadTurnsListResponse__ThreadItem;
type ItemEntry = CodexSchema.V2ThreadItemsListResponse__ThreadItemEntry;

/** Test injection replaces RPC responses, not the source-format reader. Production always uses T3's client. */
export interface CodexHistoryRpc {
  request<M extends RpcMethod>(
    method: M,
    params: Record<string, unknown>,
  ): Promise<RpcResponses[M]>;
  close(): Promise<void>;
}

interface ReaderDependencies {
  connect?: (options: NativeReadOptions) => Promise<CodexHistoryRpc>;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 100_000;
const SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

function describeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

async function connectNative(options: NativeReadOptions): Promise<CodexHistoryRpc> {
  const clientLayer = Layer.unwrap(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const env = {
        ...process.env,
        ...(options.sourceHome ? { CODEX_HOME: resolve(options.sourceHome) } : {}),
      };
      const command = yield* resolveSpawnCommand(options.binary ?? "codex", ["app-server"], {
        env,
        bypassNpmShim: true,
      });
      const handle = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          cwd: options.workspace ? canonicalPath(options.workspace) : process.cwd(),
          shell: command.shell,
          forceKillAfter: "5 seconds",
          ...(options.sourceHome
            ? { env: { ...process.env, CODEX_HOME: resolve(options.sourceHome) } }
            : {}),
        }),
      );
      return CodexClient.layerChildProcess(handle, { logIncoming: false, logOutgoing: false });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  const runtime = ManagedRuntime.make(clientLayer);
  let disposed = false;
  const runRequest = <M extends RpcMethod>(
    method: M,
    params: Record<string, unknown>,
  ): Promise<RpcResponses[M]> =>
    runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request(method, params as never);
      }).pipe(
        Effect.timeout("2 minutes"),
        Effect.catch((error) => Effect.die(describeError(error))),
      ),
    ) as Promise<RpcResponses[M]>;
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        yield* client.request("initialize", {
          clientInfo: {
            name: "t3-import-native",
            title: "T3 native history importer",
            version: __IMPORTER_VERSION__,
          },
          capabilities: { experimentalApi: true, optOutNotificationMethods: null },
        });
        yield* client.notify("initialized", undefined);
        // Reading history must not acknowledge approval/tool requests that could execute work.
        yield* client.handleUnknownServerRequest((method) =>
          Effect.fail(
            new Error(`Unexpected Codex request during history reading: ${method}`) as never,
          ),
        );
      }).pipe(Effect.timeout("30 seconds")),
    );
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  return {
    request: (method, params) => {
      if (disposed) return Promise.reject(new Error("Codex history reader is closed."));
      return runRequest(method, params);
    },
    close: async () => {
      if (!disposed) {
        disposed = true;
        await runtime.dispose();
      }
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function methodUnavailable(error: unknown): boolean {
  const visited = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 8 || value === null || visited.has(value)) return false;
    visited.add(value);
    const object = record(value);
    if (!object) return false;
    if (
      object.code === -32601 &&
      (object.operation === undefined || object.operation === "receive-response")
    )
      return true;
    // Effect's Promise rejection retains the typed failure in its cause tree.
    for (const key of Reflect.ownKeys(object)) {
      if (visit(Reflect.get(object, key), depth + 1)) return true;
    }
    return false;
  };
  return visit(error, 0);
}

function iso(
  value: number | null | undefined,
  fallback: string,
  unit: "seconds" | "milliseconds" = "seconds",
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const date = new Date(unit === "seconds" ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(json);
  const object = record(value);
  if (!object) return String(value);
  return Object.fromEntries(
    Object.entries(object)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, json(child)]),
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function sameWorkspace(left: string, right: string): boolean {
  const normalize = (path: string) =>
    process.platform === "win32" ? canonicalPath(path).toLowerCase() : canonicalPath(path);
  return normalize(left) === normalize(right);
}

function hasArchivedRollout(conversation: NativeConversation): boolean {
  if (!conversation.path || !conversation.sourceHome || !isAbsolute(conversation.path))
    return false;
  const archive = canonicalPath(resolve(conversation.sourceHome, "archived_sessions"));
  const path = relative(archive, canonicalPath(conversation.path));
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function summary(thread: Thread | CodexSchema.V2ThreadListResponse__Thread): NativeSourceSummary {
  const createdAt = iso(thread.createdAt, "1970-01-01T00:00:00.000Z");
  return {
    source: "codex",
    id: thread.id,
    title:
      thread.name?.trim() ||
      thread.agentNickname?.trim() ||
      thread.preview.trim().slice(0, 160) ||
      "Untitled Codex session",
    workspace: thread.cwd,
    createdAt,
    updatedAt: iso(thread.updatedAt, createdAt),
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.path ? { path: thread.path } : {}),
  };
}

function terminalStatus(
  status: string | undefined,
  fallback: NativeTerminalStatus = "completed",
): NativeTerminalStatus {
  if (status === "failed") return "failed";
  if (
    status === "interrupted" ||
    status === "cancelled" ||
    status === "declined" ||
    status === "inProgress"
  )
    return "interrupted";
  return fallback;
}

function mime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function image(value: string, id: string, local = false): NativeImage {
  const data = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/iu.exec(value);
  if (data)
    return {
      id,
      name: `${id}.${data[1]!.split("/")[1] === "jpeg" ? "jpg" : data[1]!.split("/")[1]}`,
      mimeType: data[1]!,
      base64: data[2]!,
    };
  if (local)
    return { id, name: basename(value) || `${id}.png`, mimeType: mime(value), path: value };
  return { id, name: `${id}.png`, mimeType: "image/png", url: value };
}

function itemHasActiveStatus(item: Item): boolean {
  return "status" in item && item.status === "inProgress";
}

type FileChange = Extract<Item, { type: "fileChange" }>["changes"][number];
function fileChangeDestination(change: FileChange): string {
  return change.kind.type === "update" && change.kind.move_path
    ? change.kind.move_path
    : change.path;
}

/** Match native T3's handling of complete patches, bare update hunks and raw add/delete contents. */
function fileChangePatch(change: FileChange): string | undefined {
  const destination = fileChangeDestination(change);
  const operation = change.kind.type;
  const fullPatch = change.diff.startsWith("diff --git ") || change.diff.startsWith("--- ");
  if (fullPatch) {
    if (operation === "update") return change.diff;
    try {
      const patches = parsePatch(change.diff);
      const normalizePath = (path: string | undefined) =>
        path?.replace(/^[ab]\//u, "").replaceAll("\\", "/");
      if (
        patches.length &&
        patches.every(
          (patch) =>
            patch.hunks.length &&
            normalizePath(operation === "add" ? patch.newFileName : patch.oldFileName) ===
              destination.replaceAll("\\", "/") &&
            patch.hunks.every((hunk) =>
              hunk.lines.every((line) =>
                operation === "add" ? !line.startsWith("-") : !line.startsWith("+"),
              ),
            ),
        )
      )
        return change.diff;
    } catch {
      /* An added/deleted file's contents can themselves resemble a patch. */
    }
  }
  if (operation === "add" || operation === "delete") {
    return formatPatch(
      operation === "add"
        ? structuredPatch("/dev/null", destination, "", change.diff)
        : structuredPatch(change.path, "/dev/null", change.diff, ""),
      FILE_HEADERS_ONLY,
    );
  }
  if (change.diff.trimStart().startsWith("@@ ")) {
    const header = (path: string) => (/[\t\r\n"]/u.test(path) ? JSON.stringify(path) : path);
    return `--- ${header(change.path)}\n+++ ${header(destination)}\n${change.diff.trimStart()}`;
  }
  return undefined;
}

/** The provider owns decoding and branch selection. This function only maps its typed display items. */
export function mapCodexItem(
  item: Item,
  timestamp: string,
  turnStatus: NativeTerminalStatus,
  warnings: Set<string>,
): NativeHistoryItem {
  const base = {
    id: item.id,
    timestamp,
    status: terminalStatus("status" in item ? item.status : undefined),
  };
  const dynamic = (name: string, input: unknown, output: unknown): NativeHistoryItem => ({
    ...base,
    kind: "dynamic_tool",
    title: name,
    data: {
      toolName: name || null,
      input: json(input),
      ...(output === undefined ? {} : { output: json(output) }),
    },
  });
  switch (item.type) {
    case "userMessage": {
      const text: string[] = [];
      const images: NativeImage[] = [];
      let opaqueInput = false;
      item.content.forEach((part, index) => {
        switch (part.type) {
          case "text":
            text.push(part.text);
            break;
          case "localImage":
            images.push(image(part.path, `${item.id}-${index}`, true));
            break;
          case "image":
            if ("url" in part) images.push(image(part.url, `${item.id}-${index}`));
            else {
              text.push(`[Codex image file: ${part.fileId}]`);
              warnings.add(
                "Codex file-ID-only images are retained as references; the app-server history API does not provide their local bytes.",
              );
            }
            break;
          case "mention":
          case "skill":
            text.push(`[${part.name}](${part.path})`);
            break;
          case "audio":
            text.push(`[Audio: ${part.url}]`);
            warnings.add(
              "Audio inputs are retained as references; T3's historical image attachment path cannot embed audio.",
            );
            break;
          case "localAudio":
            text.push(`[Audio: ${part.path}]`);
            warnings.add(
              "Audio inputs are retained as references; T3's historical image attachment path cannot embed audio.",
            );
            break;
          default: {
            const unknown = part as { type: string };
            opaqueInput = true;
            warnings.add(
              `Codex user input type '${unknown.type}' has no dedicated presentation; the complete user record is retained as native metadata.`,
            );
          }
        }
      });
      return {
        ...base,
        kind: "user_message",
        data: { text: text.join("\n\n"), ...(opaqueInput ? { nativeContent: json(item) } : {}) },
        ...(images.length ? { images } : {}),
      };
    }
    case "agentMessage": {
      const questions = (item.questions ?? [])
        .map((question) =>
          [question.title, ...(question.options ?? []).map((option) => `- ${option}`)].join("\n"),
        )
        .join("\n\n");
      const text = [item.text, questions && !item.text.includes(questions) ? questions : ""]
        .filter(Boolean)
        .join("\n\n");
      return {
        ...base,
        kind: "assistant_message",
        data: { text, ...(item.phase ? { phase: item.phase } : {}) },
      };
    }
    case "reasoning": {
      const sections = [item.summary?.join("\n\n"), item.content?.join("\n\n")].filter(
        (part): part is string => Boolean(part),
      );
      return { ...base, kind: "reasoning", data: { text: [...new Set(sections)].join("\n\n") } };
    }
    case "plan":
      return { ...base, kind: "proposed_plan", data: { markdown: item.text } };
    case "commandExecution":
      return {
        ...base,
        ...(item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0
          ? { status: "failed" as const }
          : {}),
        kind: "command_execution",
        title: item.command,
        data: {
          input: item.command,
          ...(item.aggregatedOutput === null || item.aggregatedOutput === undefined
            ? {}
            : { output: item.aggregatedOutput }),
          ...(item.exitCode === null || item.exitCode === undefined
            ? {}
            : { exitCode: item.exitCode }),
          ...(item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0
            ? { outputIndicatesFailure: true }
            : {}),
        },
      };
    case "fileChange": {
      const firstPath = item.changes[0]
        ? fileChangeDestination(item.changes[0])
        : "(no file changes)";
      const patches =
        item.changes.length <= 1
          ? []
          : item.changes.flatMap((change) => {
              const patch = fileChangePatch(change);
              if (patch === undefined) {
                warnings.add(
                  `Codex file change '${change.path}' has no renderable unified patch; its original payload is retained as native metadata.`,
                );
                return [];
              }
              return [patch.endsWith("\n") ? patch : `${patch}\n`];
            });
      return {
        ...base,
        kind: "file_change",
        title: firstPath,
        data: {
          fileName: firstPath,
          diffStr: item.changes.length <= 1 ? (item.changes[0]?.diff ?? "") : patches.join(""),
          nativeContent: json(item),
          changes: item.changes.map((change) => {
            const kind = record(change.kind);
            return {
              operation: typeof kind?.type === "string" ? kind.type : String(change.kind),
              path: fileChangeDestination(change),
              ...(typeof kind?.move_path === "string" ? { oldPath: change.path } : {}),
            };
          }),
        },
      };
    }
    case "webSearch": {
      const results = (item.results ?? []).flatMap((value) => {
        const result = record(value);
        if (!result) return [];
        return [
          {
            ...(typeof result.title === "string" ? { title: result.title } : {}),
            ...(typeof result.url === "string" && result.url ? { url: result.url } : {}),
            ...(typeof result.snippet === "string" ? { snippet: result.snippet } : {}),
          },
        ];
      });
      return {
        ...base,
        kind: "web_search",
        title: item.query,
        data: { patterns: [item.query], ...(results.length ? { results } : {}) },
      };
    }
    case "contextCompaction":
      return { ...base, kind: "compaction", data: { driver: "codex" } };
    case "mcpToolCall":
      return dynamic(`${item.server}.${item.tool}`, item.arguments, item.error ?? item.result);
    case "dynamicToolCall":
      return {
        ...dynamic(
          item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
          item.arguments,
          item.contentItems,
        ),
        ...(item.success === false ? { status: "failed" as const } : {}),
      };
    case "functionCallOutput":
      return dynamic(
        item.namespace ? `${item.namespace}.${item.name}` : item.name,
        {},
        item.output,
      );
    case "collabAgentToolCall":
      warnings.add(
        "Codex subagent activity is retained alongside child histories available from the native history API.",
      );
      return dynamic(
        item.tool,
        {
          senderThreadId: item.senderThreadId,
          prompt: item.prompt,
          receiverThreadIds: item.receiverThreadIds,
          model: item.model,
          reasoningEffort: item.reasoningEffort,
        },
        item.agentsStates,
      );
    case "subAgentActivity":
      warnings.add(
        "Codex subagent activity is retained alongside child histories available from the native history API.",
      );
      return dynamic(
        `subagent.${item.kind}`,
        { agentThreadId: item.agentThreadId, agentPath: item.agentPath },
        undefined,
      );
    case "imageView":
      return {
        ...dynamic("view_image", { path: item.path }, undefined),
        images: [image(item.path, item.id, true)],
      };
    case "imageGeneration": {
      const mapped = dynamic(
        "image_generation",
        { revisedPrompt: item.revisedPrompt },
        {
          status: item.status,
          failure: item.failure,
          savedPath: item.savedPath,
          fileId: item.fileId,
        },
      );
      const source = item.savedPath
        ? image(item.savedPath, item.id, true)
        : item.result
          ? image(
              item.result.startsWith("data:")
                ? item.result
                : `data:image/png;base64,${item.result}`,
              item.id,
            )
          : undefined;
      return { ...mapped, ...(source ? { images: [source] } : {}) };
    }
    case "hookPrompt":
      return {
        ...base,
        kind: "system_notice",
        data: { message: item.fragments.map((fragment) => fragment.text).join("\n\n") },
      };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { ...base, kind: "system_notice", data: { message: `${item.type}: ${item.review}` } };
    case "sleep":
      return dynamic("sleep", { durationMs: item.durationMs }, undefined);
    default: {
      const unknown = item as { id: string; type: string };
      warnings.add(
        `Codex item type '${unknown.type}' has no dedicated T3 presentation; its complete native content was retained as a generic tool.`,
      );
      return dynamic(`codex.${unknown.type}`, {}, item);
    }
  }
}

function assertCursor(
  cursor: string | null | undefined,
  seen: Set<string>,
  scope: string,
): string | null {
  if (cursor === undefined || cursor === null) return null;
  if (seen.has(cursor))
    throw new Error(
      `Codex repeated a pagination cursor while reading ${scope}; refusing partial history.`,
    );
  seen.add(cursor);
  return cursor;
}

async function allTurns(
  rpc: CodexHistoryRpc,
  thread: Thread,
): Promise<{ turns: Turn[]; paged: boolean }> {
  const turns: Turn[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const page = await rpc.request("thread/turns/list", {
        threadId: thread.id,
        cursor,
        limit: PAGE_SIZE,
        sortDirection: "asc",
        itemsView: "full",
      });
      for (const turn of page.data) {
        if (ids.has(turn.id))
          throw new Error(`Codex returned duplicate turn '${turn.id}' across history pages.`);
        ids.add(turn.id);
        turns.push(turn);
      }
      cursor = assertCursor(page.nextCursor, cursors, "turns");
      if (cursor === null) return { turns, paged: true };
    }
    throw new Error("Codex turn pagination exceeded the safety bound; refusing partial history.");
  } catch (error) {
    if (turns.length > 0 || !methodUnavailable(error)) throw error;
    const full = await rpc.request("thread/read", { threadId: thread.id, includeTurns: true });
    if (full.thread.historyMode === "paginated")
      throw new Error(
        "Codex uses paginated history but does not expose thread/turns/list; update Codex before importing.",
      );
    if (full.thread.turns.some((turn) => turn.itemsView && turn.itemsView !== "full"))
      throw new Error(
        "Codex legacy thread/read returned partial turn items; update Codex before importing.",
      );
    return { turns: [...full.thread.turns], paged: false };
  }
}

async function allItems(
  rpc: CodexHistoryRpc,
  threadId: string,
  turn: Turn,
  paged: boolean,
): Promise<ItemEntry[]> {
  const items: ItemEntry[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const page = await rpc.request("thread/items/list", {
        threadId,
        turnId: turn.id,
        cursor,
        limit: PAGE_SIZE,
        sortDirection: "asc",
      });
      for (const entry of page.data) {
        if (entry.turnId !== turn.id)
          throw new Error(`Codex returned an item for another turn while reading '${turn.id}'.`);
        if (ids.has(entry.item.id))
          throw new Error(`Codex returned duplicate item '${entry.item.id}' across history pages.`);
        ids.add(entry.item.id);
        items.push(entry);
      }
      cursor = assertCursor(page.nextCursor, cursors, "items");
      if (cursor === null) {
        if (items.length === 0 && turn.items.length > 0)
          throw new Error(`Codex returned empty item history for nonempty turn '${turn.id}'.`);
        return items;
      }
    }
    throw new Error("Codex item pagination exceeded the safety bound; refusing partial history.");
  } catch (error) {
    if (items.length > 0 || !methodUnavailable(error)) throw error;
    if (turn.itemsView !== undefined && turn.itemsView !== "full")
      throw new Error(
        `Codex returned only ${turn.itemsView} items for turn '${turn.id}', without an item pagination API.`,
      );
    // Older native APIs supplied complete items in thread/read; no rollout parsing is needed.
    if (paged && turn.itemsView !== "full")
      throw new Error(`Codex did not confirm full item hydration for turn '${turn.id}'.`);
    return turn.items.map((item) => ({ turnId: turn.id, item }));
  }
}

export function createCodexReader(dependencies: ReaderDependencies = {}): NativeSourceReader {
  let connection: Promise<CodexHistoryRpc> | undefined;
  let connectionKey: string | undefined;
  let closed = false;
  const connect = async (options: NativeReadOptions) => {
    if (closed) throw new Error("Codex history reader is closed.");
    const key = JSON.stringify([
      options.binary ?? "codex",
      options.sourceHome ? resolve(options.sourceHome) : null,
    ]);
    if (connectionKey !== undefined && key !== connectionKey)
      throw new Error(
        "One Codex reader cannot switch binaries or source homes; create a new reader.",
      );
    connectionKey = key;
    connection ??= (dependencies.connect ?? connectNative)(options);
    return connection;
  };
  const readOne = async (
    id: string,
    options: NativeReadOptions,
    seen: Set<string>,
    ancestry: Set<string>,
    knownThread?: Thread,
  ): Promise<NativeConversation> => {
    const rpc = await connect(options);
    const thread =
      knownThread ??
      (await rpc.request("thread/read", { threadId: id, includeTurns: false })).thread;
    if (thread.id !== id) throw new Error("Codex returned another session while reading history.");
    if (options.workspace && !sameWorkspace(thread.cwd, options.workspace))
      throw new Error(`Codex session '${id}' belongs to another workspace.`);
    const warnings = new Set<string>();
    const { turns: nativeTurns, paged } = await allTurns(rpc, thread);
    if (nativeTurns.length)
      warnings.add(
        "Codex native history provides only the current thread model; historical per-turn model provenance is unavailable.",
      );
    if (nativeTurns.length === 0 && thread.preview.trim())
      throw new Error(
        "Codex returned no turns for a nonempty session. Its native history store may be unavailable; refusing an incomplete import.",
      );
    let active = record(thread.status)?.type === "active";
    const turns: NativeHistoryTurn[] = [];
    const nativeMetadata: JsonValue[] = [];
    const sourceCoverage: NonNullable<NativeConversation["sourceCoverage"]> = {
      schemaVersion: 1,
      selectedRecords: 0,
      mappedRecords: 0,
      metadataOnlyRecords: 0,
      missingRecordIds: [],
      nativeKinds: {},
    };
    const nativeKinds = new Map<string, number>();
    if (nativeTurns.length)
      warnings.add(
        "Codex historical token usage is unavailable from the native history API; no usage was reconstructed.",
      );
    const references = new Map<
      string,
      { nativeItemId: string; spawned: boolean; prompt?: string }
    >();
    const baseAt = summary(thread).createdAt;
    for (const [turnIndex, turn] of nativeTurns.entries()) {
      const isTerminal = ["completed", "interrupted", "failed"].includes(turn.status);
      if (!isTerminal) active = true;
      const fallback = new Date(Date.parse(baseAt) + turnIndex).toISOString();
      const startedAt = iso(turn.startedAt, fallback);
      const completedAt = iso(turn.completedAt, startedAt);
      const status = terminalStatus(turn.status);
      const entries = await allItems(rpc, thread.id, turn, paged);
      const items = entries.map((entry, itemIndex) => {
        const native = entry.item;
        const nativeDuration = "durationMs" in native ? native.durationMs : undefined;
        if (typeof nativeDuration === "number" && Number.isFinite(nativeDuration)) {
          nativeMetadata.push({
            type: "codex.item_timing",
            turnId: turn.id,
            nativeId: native.id,
            durationMs: nativeDuration,
          });
        }
        if (native.type === "collabAgentToolCall")
          for (const childId of native.receiverThreadIds) {
            if (childId === id || native.agentsStates[childId]?.status === "notFound") continue;
            const spawned = native.tool === "spawnAgent";
            if (!references.has(childId) || spawned)
              references.set(childId, {
                nativeItemId: native.id,
                spawned,
                ...(typeof native.prompt === "string" ? { prompt: native.prompt } : {}),
              });
          }
        if (
          native.type === "subAgentActivity" &&
          native.agentThreadId !== id &&
          !references.has(native.agentThreadId)
        )
          references.set(native.agentThreadId, {
            nativeItemId: native.id,
            spawned: native.kind === "started",
          });
        if (itemHasActiveStatus(entry.item))
          warnings.add(
            "An unfinished native tool inside a terminal turn was retained as interrupted activity.",
          );
        const itemFallback = new Date(Date.parse(startedAt) + itemIndex).toISOString();
        const item = mapCodexItem(
          entry.item,
          iso(entry.completedAtMs ?? entry.startedAtMs, itemFallback, "milliseconds"),
          status,
          warnings,
        );
        const nativeStartedAt = iso(entry.startedAtMs, "", "milliseconds");
        const nativeCompletedAt = iso(entry.completedAtMs, "", "milliseconds");
        return {
          ...item,
          ...(nativeStartedAt ? { startedAt: nativeStartedAt } : {}),
          ...(nativeCompletedAt ? { completedAt: nativeCompletedAt } : {}),
        };
      });
      const mappedById = new Map(items.map((item) => [item.id, item]));
      sourceCoverage.selectedRecords += entries.length;
      for (const entry of entries) {
        nativeKinds.set(entry.item.type, (nativeKinds.get(entry.item.type) ?? 0) + 1);
        const mapped = mappedById.get(entry.item.id);
        if (!mapped) sourceCoverage.missingRecordIds.push(entry.item.id);
        else if (
          mapped.kind === "user_message" &&
          !String(mapped.data.text ?? "").trim() &&
          !mapped.images?.length &&
          mapped.data.nativeContent !== undefined
        )
          sourceCoverage.metadataOnlyRecords++;
        else sourceCoverage.mappedRecords++;
      }
      const turnDuration =
        typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs)
          ? turn.durationMs
          : undefined;
      if (turnDuration !== undefined || turn.error)
        nativeMetadata.push({
          type: "codex.turn_metadata",
          nativeId: turn.id,
          ...(turnDuration !== undefined ? { durationMs: turnDuration } : {}),
          ...(turn.error ? { error: json(turn.error) } : {}),
        });
      if (turn.error)
        items.push({
          id: `${turn.id}:terminal-error`,
          kind: "system_notice",
          timestamp: completedAt,
          status,
          data: { message: `Codex turn ${status}: ${turn.error.message}` },
        });
      turns.push({ id: turn.id, status, startedAt, completedAt, items });
    }
    const children: NativeConversation[] = [];
    for (const [childId, reference] of references) {
      if (ancestry.has(childId)) {
        if (reference.spawned)
          throw new Error(
            `Codex child-session lineage contains a cycle at '${childId}'; refusing partial history.`,
          );
        continue; // Child-to-parent communication is not a lineage edge.
      }
      if (seen.has(childId)) continue;
      const childThread = (
        await rpc.request("thread/read", { threadId: childId, includeTurns: false })
      ).thread;
      const source = record(childThread.source);
      const nativeParent =
        childThread.parentThreadId ??
        record(record(source?.subAgent)?.thread_spawn)?.parent_thread_id;
      if (nativeParent && nativeParent !== id) continue; // A wait may mention a descendant or a peer owned by another native parent.
      if (!nativeParent && !reference.spawned) {
        warnings.add(
          `Codex referenced session '${childId}' without native parent metadata or a spawn event; its tool reference was retained without inventing lineage.`,
        );
        continue;
      }
      seen.add(childId);
      if (seen.size > 10_000 || ancestry.size > 255)
        throw new Error(
          "Codex child-session traversal exceeded its safety bound; refusing partial history.",
        );
      const { workspace: _parentWorkspace, ...childOptions } = options;
      const child = await readOne(
        childId,
        childOptions,
        seen,
        new Set([...ancestry, childId]),
        childThread,
      );
      child.parent = { sourceId: id, nativeItemId: reference.nativeItemId };
      if (reference.spawned && reference.prompt?.trim()) {
        if (child.title === "Untitled Codex session")
          child.title = reference.prompt.trim().slice(0, 160);
        const first = child.turns[0];
        if (first && !first.items.some((item) => item.kind === "user_message")) {
          first.items.unshift({
            id: `${reference.nativeItemId}:spawn-input`,
            kind: "user_message",
            timestamp: first.startedAt,
            status: "completed",
            data: { text: reference.prompt },
          });
          child.warnings.push(
            "The initial child request was recovered from its native parent spawn call because child item history omitted that input.",
          );
        }
      }
      children.push(child);
      if (child.active) active = true;
    }
    const after = (await rpc.request("thread/read", { threadId: id, includeTurns: false })).thread;
    if (
      after.updatedAt !== thread.updatedAt ||
      after.cwd !== thread.cwd ||
      record(after.status)?.type === "active"
    )
      active = true;
    if (active)
      warnings.add(
        "The source session is active or changed during reading. Import must wait for it to settle.",
      );
    return {
      ...summary(thread),
      nativeSessionRef: thread.id,
      sourceHome: resolve(options.sourceHome || process.env.CODEX_HOME || `${homedir()}/.codex`),
      driver: "codex",
      turns,
      sourceCoverage: { ...sourceCoverage, nativeKinds: Object.fromEntries(nativeKinds) },
      ...(nativeMetadata.length ? { nativeMetadata } : {}),
      ...(children.length ? { children } : {}),
      warnings: [...warnings],
      active,
    };
  };
  const archiveStatus = new Map<string, boolean>();
  const listed = new Set<string>();
  const listKey = (options: NativeReadOptions) =>
    JSON.stringify([options.workspace, options.archived === true, options.since]);
  const list = async (options: NativeReadOptions): Promise<NativeSourceSummary[]> => {
    const archived = options.archived === true;
    const rpc = await connect(options);
    const since = options.since === undefined ? undefined : Date.parse(options.since);
    if (since !== undefined && Number.isNaN(since))
      throw new Error(`Invalid --since date: ${options.since}`);
    const results: NativeSourceSummary[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const page = await rpc.request("thread/list", {
        cursor,
        limit: PAGE_SIZE,
        archived,
        modelProviders: [],
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: SOURCE_KINDS,
        ...(options.workspace ? { cwd: canonicalPath(options.workspace) } : {}),
      });
      for (const thread of page.data) {
        if (ids.has(thread.id)) continue;
        ids.add(thread.id);
        const candidate = { ...summary(thread), archived };
        if (options.workspace && !sameWorkspace(candidate.workspace, options.workspace)) continue;
        if (since !== undefined && Date.parse(candidate.updatedAt) < since) continue;
        archiveStatus.set(candidate.id, archived);
        results.push(candidate);
      }
      cursor = assertCursor(page.nextCursor, cursors, "threads");
      if (cursor === null) {
        listed.add(listKey(options));
        return results;
      }
    }
    throw new Error(
      "Codex thread pagination exceeded the safety bound; refusing a partial session list.",
    );
  };
  return {
    list,
    async read(id, options) {
      const conversation = await readOne(id, options, new Set([id]), new Set([id]));
      const { since: _since, ...lookupOptions } = options;
      for (const archived of options.archived ? [true] : [false, true]) {
        if (archiveStatus.has(id) && (!options.archived || archiveStatus.get(id) === true)) break;
        const scope = {
          ...lookupOptions,
          workspace: options.workspace ?? conversation.workspace,
          archived,
        };
        if (!listed.has(listKey(scope))) await list(scope);
      }
      // The native picker may omit an internal thread even when thread/read can open its archive.
      const archived =
        archiveStatus.get(id) ?? (hasArchivedRollout(conversation) ? true : undefined);
      if (options.archived && archived !== true)
        throw new Error(`Codex did not list session '${id}' as archived in this workspace.`);
      return archived === undefined ? conversation : { ...conversation, archived };
    },
    async close() {
      if (closed) return;
      closed = true;
      // Failed connection creation already disposes its native runtime.
      if (connection) await (await connection.catch(() => undefined))?.close();
    },
  };
}
