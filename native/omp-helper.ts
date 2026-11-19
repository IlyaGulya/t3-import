/** Runs under Bun so the installed OMP package executes its own native session implementation. */
import { createReadStream } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { writeNativeJson } from "./json-output.js";
import type {
  NativeConversation,
  NativeHistoryItem,
  NativeHistoryTurn,
  NativeImage,
  NativeReadOptions,
  NativeSourceSummary,
  NativeTerminalStatus,
  JsonValue,
} from "../src/native/types.js";

// Runtime imports are deliberately resolved from the validated installed package, never reimplemented here.
// OMP's Bun-only package types are not imported into the Node CLI's dependency graph.
import type * as Loader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type * as Listing from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type * as Storage from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type * as Migrations from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import type * as EntryModule from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type * as Manager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type * as Context from "@oh-my-pi/pi-coding-agent/session/session-context";
import type * as Blobs from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type * as SubSessions from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import type * as SelectiveCommit from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import type * as Exit from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import type * as Dirs from "@oh-my-pi/pi-utils/dirs";
import type * as Logger from "@oh-my-pi/pi-utils/logger";
import type * as Transcript from "@oh-my-pi/pi-tui/chat/transcript-entry";
type Entry = EntryModule.SessionEntry;
interface Request {
  operation: "list" | "read";
  packageRoot: string;
  options: NativeReadOptions;
  id?: string;
  path?: string;
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
function unwrapNotice(text: string, tag: "system-notice" | "irc"): string {
  const value = text.trim();
  const open = `<${tag}>`,
    close = `</${tag}>`;
  return value.startsWith(open) && value.endsWith(close)
    ? value.slice(open.length, -close.length).trim()
    : value;
}
function jsonObject(value: JsonValue | undefined) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function taskLaunchItems(conversation: NativeConversation): Map<string, string | null> {
  const launches = new Map<string, string | null>();
  for (const turn of conversation.turns)
    for (const item of turn.items) {
      if (
        item.kind !== "dynamic_tool" ||
        item.data.toolName !== "task" ||
        item.status !== "completed" ||
        !Array.isArray(jsonObject(item.data.input)?.tasks)
      )
        continue;
      // OMP allocates transcript IDs before starting tasks and persists them in task results/progress.
      const details = jsonObject(jsonObject(item.data.output)?.details);
      for (const records of [details?.results, details?.progress]) {
        if (!Array.isArray(records)) continue;
        for (const entry of records) {
          const id = jsonObject(entry)?.id;
          if (typeof id !== "string" || !id) continue;
          const previous = launches.get(id);
          launches.set(id, previous === undefined || previous === item.id ? item.id : null);
        }
      }
    }
  return launches;
}

function moveEmptySubsessionsToMetadata(owner: NativeConversation): void {
  if (!owner.children?.length) return;
  owner.children = owner.children.filter((child) => {
    moveEmptySubsessionsToMetadata(child);
    if (
      child.active ||
      child.turns.length ||
      child.children?.length ||
      child.sourceCoverage?.selectedRecords !== 0
    )
      return true;

    (owner.nativeMetadata ??= []).push(
      json({
        type: "omp_empty_subsession",
        sourceId: child.id,
        nativeSessionRef: child.nativeSessionRef,
        parent: child.parent,
        sourceCoverage: child.sourceCoverage,
        nativeMetadata: child.nativeMetadata,
        warnings: child.warnings,
      }),
    );
    owner.warnings.push(
      `OMP child '${child.id}' has no transcript; its native allocation is retained in parent metadata.`,
    );
    return false;
  });
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}
async function sameWorkspace(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([canonical(left), canonical(right)]);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function inside(root: string, path: string): boolean {
  const entry = relative(root, path);
  return entry !== "" && !isAbsolute(entry) && entry !== ".." && !entry.startsWith(`..${sep}`);
}
function iso(value: unknown, fallback = "1970-01-01T00:00:00.000Z"): string {
  const date = new Date(
    value instanceof Date || typeof value === "string" || typeof value === "number"
      ? value
      : fallback,
  );
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}
async function snapshot(path: string): Promise<string> {
  const before = await stat(path, { bigint: true });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await stat(path, { bigint: true });
  const key = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  if (key(before) !== key(after))
    throw new Error("OMP source changed while snapshotting; wait for the session to settle.");
  return `${key(after)}:${hash.digest("hex")}`;
}

async function execute(request: Request): Promise<NativeSourceSummary[] | NativeConversation> {
  if (
    !request ||
    !["list", "read"].includes(request.operation) ||
    typeof request.packageRoot !== "string" ||
    !request.options
  )
    throw new Error("Invalid OMP native helper request.");
  const manifest = JSON.parse(await readFile(join(request.packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@oh-my-pi/pi-coding-agent" || manifest.version !== "18.22.0")
    throw new Error("Unsupported OMP source package: expected @oh-my-pi/pi-coding-agent@18.22.0.");
  const bun = globalThis.Bun;
  if (!bun?.resolveSync) throw new Error("OMP native history helper must run with Bun.");
  const logger = (await import(
    pathToFileURL(bun.resolveSync("@oh-my-pi/pi-utils/logger", request.packageRoot)).href
  )) as typeof Logger;
  // Native default logging creates/rotates files outside the session store. Its supported
  // forwarding API keeps this reader read-only and preserves diagnostics on stderr.
  if (typeof logger.setLogForwarder !== "function")
    throw new Error("OMP native read-only log forwarding is unavailable.");
  logger.setLogForwarder({
    emit(event) {
      process.stderr.write(`OMP ${event.level}: ${event.message}\n`);
    },
    flush() {},
  });
  const module = <T>(name: string): Promise<T> =>
    import(
      pathToFileURL(join(request.packageRoot, "src/session", `${name}.ts`)).href
    ) as Promise<T>;
  const [
    loader,
    listing,
    storageModule,
    migrations,
    entryModule,
    manager,
    contextModule,
    blobs,
    exit,
    subSessions,
  ] = await Promise.all([
    module<typeof Loader>("session-loader"),
    module<typeof Listing>("session-listing"),
    module<typeof Storage>("session-storage"),
    module<typeof Migrations>("session-migrations"),
    module<typeof EntryModule>("session-entries"),
    module<typeof Manager>("session-manager"),
    module<typeof Context>("session-context"),
    module<typeof Blobs>("blob-store"),
    module<typeof Exit>("exit-diagnostics"),
    module<typeof SubSessions>("sub-sessions"),
  ]);
  const [dirs, transcript] = await Promise.all([
    import(
      pathToFileURL(bun.resolveSync("@oh-my-pi/pi-utils/dirs", request.packageRoot)).href
    ) as Promise<typeof Dirs>,
    import(
      pathToFileURL(bun.resolveSync("@oh-my-pi/pi-tui/chat/transcript-entry", request.packageRoot))
        .href
    ) as Promise<typeof Transcript>,
  ]);
  for (const [object, name] of [
    [loader, "loadSessionFile"],
    [loader, "parseSessionContent"],
    [loader, "resolveBlobRefsInEntries"],
    [listing, "listAllSessions"],
    [listing, "readSessionInfo"],
    [storageModule, "isSessionLeaseHeld"],
    [manager, "SessionEntryIndex"],
    [manager, "lastModelChangeRole"],
    [contextModule, "getRestorableSessionModels"],
    [contextModule, "buildSessionContext"],
    [contextModule, "isTranscriptEntry"],
    [transcript, "isUserRequestEntry"],
    [transcript, "transcriptEntryMessage"],
    [exit, "sessionExitFollowsLastMessage"],
    [exit, "collectPendingToolCalls"],
    [subSessions, "collectSubSessions"],
  ] as const) {
    if (typeof Reflect.get(object, name) !== "function")
      throw new Error(
        `OMP native history API '${name}' is unavailable; no custom parser fallback is used.`,
      );
  }
  const options = request.options;
  const since = options.since === undefined ? undefined : Date.parse(options.since);
  if (since !== undefined && Number.isNaN(since))
    throw new Error(`Invalid --since date: ${options.since}`);
  const agentDir = await canonical(options.sourceHome || dirs.getAgentDir());
  const configuredSessionsRoot = dirs.getSessionsDir(agentDir);
  const sessionsRoot = await canonical(configuredSessionsRoot);
  // Match the pinned OMP GC layout and top-level session buckets.
  const archiveRoot = await canonical(join(dirname(configuredSessionsRoot), "archive", "sessions"));
  const storage = new storageModule.FileSessionStorage();
  const summarize = (info: Listing.SessionInfo): NativeSourceSummary => ({
    source: "omp",
    id: info.id,
    title: listing.sessionDisplayName(info) || "Untitled OMP session",
    workspace: info.cwd,
    createdAt: iso(info.created),
    updatedAt: iso(info.modified),
    path: info.path,
  });
  const readCompressed = async (path: string) =>
    loader.parseSessionContent(
      new TextDecoder().decode(bun.gunzipSync(await bun.file(path).bytes())),
    );
  const summarizeArchive = (
    loaded: Loader.SessionLoadResult,
    path: string,
  ): NativeSourceSummary => {
    const header = loaded.entries[0];
    if (loaded.invalidHeader || header?.type !== "session" || typeof header.cwd !== "string")
      throw new Error(`OMP could not identify the archived session '${path}'.`);
    const createdAt = iso(header.timestamp);
    const updatedAt = loaded.entries.reduce((latest, entry) => {
      const recorded = iso(entry.timestamp, latest);
      return recorded > latest ? recorded : latest;
    }, createdAt);
    return {
      source: "omp",
      id: header.id,
      title: loaded.titleSlot?.title || header.title || "Untitled OMP session",
      workspace: header.cwd,
      createdAt,
      updatedAt,
      archived: true,
      path,
    };
  };
  const list = async (archived: boolean, filterSince = true): Promise<NativeSourceSummary[]> => {
    const root = archived ? archiveRoot : sessionsRoot;
    try {
      await access(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const infos: NativeSourceSummary[] = [];
    if (archived) {
      for await (const file of new bun.Glob("*/*.jsonl.gz").scan({ cwd: root, absolute: true })) {
        const path = await realpath(file);
        if (inside(root, path)) infos.push(summarizeArchive(await readCompressed(path), path));
      }
      infos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    } else {
      infos.push(
        ...(await listing.listAllSessions(storage, root)).map((info) => ({
          ...summarize(info),
          archived: false,
        })),
      );
    }
    const seen = new Map<string, string>();
    const selected: NativeSourceSummary[] = [];
    for (const info of infos) {
      if (seen.has(info.id) && seen.get(info.id) !== info.path)
        throw new Error(
          `Multiple OMP files claim session '${info.id}'; use an explicit session file path.`,
        );
      seen.set(info.id, info.path!);
      if (options.workspace && !(await sameWorkspace(info.workspace, options.workspace))) continue;
      if (filterSince && since !== undefined && Date.parse(info.updatedAt) < since) continue;
      selected.push(info);
    }
    return selected;
  };
  if (request.operation === "list") return await list(options.archived === true);
  if (!request.id) throw new Error("OMP session ID or file path is required.");
  const isPath =
    request.id.includes("/") || request.id.includes("\\") || /\.jsonl(?:\.gz)?$/u.test(request.id);
  let path = request.path ?? (isPath ? resolve(request.id) : undefined);
  if (!path) {
    const current = options.archived
      ? undefined
      : (await list(false, false)).find((info) => info.id === request.id);
    const match = current ?? (await list(true, false)).find((info) => info.id === request.id);
    if (!match?.path)
      throw new Error(`OMP session '${request.id}' was not found in the selected native store.`);
    path = match.path;
  }
  path = await realpath(path!);
  const compressed = path.endsWith(".jsonl.gz");
  const archived = compressed && inside(archiveRoot, path);
  if (options.archived && !archived) throw new Error("OMP session is outside the cold archive.");
  const before = await snapshot(path);
  const loaded = compressed
    ? await readCompressed(path)
    : await loader.loadSessionFile(path, storage, { throwIfMissing: true });
  if (loaded.invalidHeader || !loaded.entries.length)
    throw new Error("OMP source has no valid session header; refusing incomplete history.");
  if (loaded.malformedRecords)
    throw new Error(
      `OMP's native loader reported ${loaded.malformedRecords} malformed record(s); refusing partial history.`,
    );
  const header = loaded.entries[0]!;
  if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")
    throw new Error("OMP native session header is incomplete.");
  if (typeof header.version === "number" && header.version > entryModule.CURRENT_SESSION_VERSION)
    throw new Error(
      `OMP session version ${header.version} is newer than the native loader supports.`,
    );
  if ((request.path || !isPath) && header.id !== request.id)
    throw new Error("OMP session file changed identity after discovery.");
  if (options.workspace && !(await sameWorkspace(header.cwd, options.workspace)))
    throw new Error(`OMP session '${header.id}' belongs to another workspace.`);
  const normalizeHistory = async (
    fileEntries: EntryModule.FileEntry[],
    source: NativeSourceSummary,
    sourcePath: string,
    aborted = false,
  ): Promise<NativeConversation> => {
    const header = fileEntries[0];
    if (
      !header ||
      header.type !== "session" ||
      typeof header.id !== "string" ||
      typeof header.cwd !== "string"
    )
      throw new Error("OMP native child session header is incomplete.");
    if (typeof header.version === "number" && header.version > entryModule.CURRENT_SESSION_VERSION)
      throw new Error(
        `OMP session version ${header.version} is newer than the native loader supports.`,
      );
    const leaseBefore = storageModule.isSessionLeaseHeld(header.id);
    migrations.migrateToCurrentVersion(fileEntries); // In-memory migration only; no writable SessionManager is opened.
    await loader.resolveBlobRefsInEntries(
      fileEntries,
      new blobs.BlobStore(dirs.getBlobsDir(agentDir)),
    );
    const entries = fileEntries.filter((entry: EntryModule.FileEntry) => entry.type !== "session");
    const index = new manager.SessionEntryIndex();
    index.rebuild(entries);
    const branch = index.pathTo();
    const pending = exit.collectPendingToolCalls(branch);
    const nativeContext = contextModule.buildSessionContext(
      entries,
      index.leafId(),
      index.entriesById(),
      {
        transcript: true,
        collapseCompactedHistory: false,
        inFlightToolCallIds: new Set(
          pending
            .map((call) => call.toolCallId)
            .filter((id): id is string => typeof id === "string"),
        ),
      },
    );
    const warnings = new Set<string>();
    if (
      entries.filter(
        (entry: EntryModule.FileEntry) =>
          entry.type === "message" || entry.type === "custom_message",
      ).length >
      branch.filter((entry) => entry.type === "message" || entry.type === "custom_message").length
    )
      warnings.add(
        "Only OMP's selected active branch is imported; alternative branches remain in the native source file.",
      );
    if (header.continuationOf)
      warnings.add(
        "This OMP file continues another native session; its stored history is imported without inventing or concatenating a second session.",
      );
    const nativeMetadata: JsonValue[] = [];
    const visibleRecords = new Map<string, string>();
    const mappedRecords = new Set<string>();
    const metadataRecords = new Set<string>();
    // Native bookkeeping does not become missing visible transcript rows.
    // Unknown variants are conservatively escrowed and reported below.
    const invisibleKinds = new Set<Entry["type"]>([
      "custom",
      "model_usage",
      "thinking_level_change",
      "service_tier_change",
      "label",
      "title_change",
      "ttsr_injection",
      "credential_pin",
      "session_init",
      "mode_change",
    ]);
    const turns: NativeHistoryTurn[] = [];
    let current: NativeHistoryTurn | undefined;
    let settled = true;
    let assistantModel: string | undefined;
    let emissionModel: string | undefined;
    const toolCalls = new Map<string, NativeHistoryItem>();
    const baseAt = iso(header.timestamp);
    const begin = (entry: Entry) => {
      const timestamp = iso(entry.timestamp, baseAt);
      current = {
        id: entry.id,
        status: "completed",
        startedAt: timestamp,
        completedAt: timestamp,
        items: [],
      };
      turns.push(current);
      settled = false;
      return current;
    };
    const emit = (
      entry: Entry,
      kind: NativeHistoryItem["kind"],
      data: NativeHistoryItem["data"],
      extra: Partial<NativeHistoryItem> = {},
    ) => {
      const turn = current ?? begin(entry);
      const item: NativeHistoryItem = {
        id: entry.id,
        kind,
        timestamp: iso(entry.timestamp, turn.completedAt),
        status: "completed",
        data,
        ...(emissionModel ? { model: emissionModel } : {}),
        ...extra,
      };
      if (kind === "system_notice" && item.images?.length)
        warnings.add(
          "Images on OMP system notices are retained in native content; T3 does not display notice attachments.",
        );
      turn.items.push(item);
      mappedRecords.add(entry.id);
      // Session metadata may be recorded hours after a native stop. It remains
      // visible at its original time, without reopening completed provider work.
      if (!settled) turn.completedAt = item.timestamp;
      return item;
    };
    const images = (content: unknown, id: string): NativeImage[] => {
      if (!Array.isArray(content)) return [];
      return content.flatMap((block, at) => {
        if (block?.type !== "image") return [];
        if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
          warnings.add(
            "An OMP image has no readable data or MIME type and was retained only in its native tool payload.",
          );
          return [];
        }
        if (blobs.parseBlobRef(block.data)) {
          warnings.add(
            `OMP image blob '${block.data}' is missing from the native blob store; its reference was retained.`,
          );
          return [];
        }
        return [
          {
            id: `${id}:image:${at}`,
            name: `${id}-${at}.${block.mimeType.split("/")[1] || "png"}`,
            mimeType: block.mimeType,
            base64: block.data,
          },
        ];
      });
    };
    const text = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      const references = content.flatMap((block) =>
        block?.type === "image" && typeof block.data === "string" && blobs.parseBlobRef(block.data)
          ? [`[Unavailable image: ${block.data}]`]
          : [],
      );
      return [transcript.textContent(content, "\n\n"), ...references].filter(Boolean).join("\n\n");
    };
    const withImages = (content: unknown, id: string): Partial<NativeHistoryItem> => {
      const result = images(content, id);
      return result.length ? { images: result } : {};
    };
    for (const entry of branch) {
      if (!contextModule.isTranscriptEntry(entry) && !invisibleKinds.has(entry.type))
        visibleRecords.set(entry.id, entry.type);
      if (contextModule.isTranscriptEntry(entry)) {
        const message = transcript.transcriptEntryMessage(entry);
        if (!message)
          throw new Error(
            `OMP native transcript rejected message '${entry.id}'; refusing partial history.`,
          );
        const user = transcript.isUserRequestEntry(entry);
        // Native transcript normalization owns display/attribution; the native TUI
        // suppresses non-display extension content, while real request initiators stay intact.
        if (
          (message.role === "custom" || message.role === "hookMessage") &&
          !message.display &&
          !user
        )
          continue;
        visibleRecords.set(entry.id, `${entry.type}.${message.role}`);
        if (
          user &&
          message.role === "user" &&
          message.steering !== true &&
          current &&
          !settled &&
          current.items.some((item) => item.kind === "user_message") &&
          current.items.every((item) =>
            ["user_message", "compaction", "system_notice"].includes(item.kind),
          )
        ) {
          // OMP persists steering explicitly. A later ordinary request without any
          // recorded assistant work supersedes an unanswered historical request;
          // it does not prove a user abort or belong to the same response duration.
          current.status = "interrupted";
          current.completedAt = current.items.findLast(
            (item) => item.kind === "user_message",
          )!.timestamp;
          nativeMetadata.push(
            json({
              type: "omp_unanswered_request",
              uuid: current.id,
              replacementId: entry.id,
              reason: "No recorded assistant work before a later native non-steering request.",
            }),
          );
          warnings.add(
            `superseded_unanswered_request: '${current.id}' has no recorded assistant work before non-steering request '${entry.id}'; preserved as interrupted history without claiming a user abort.`,
          );
          settled = true;
        }
        if (user && (!current || settled)) begin(entry);
        if (user) {
          if (!("content" in message))
            throw new Error(
              "OMP native request classification returned a message without content.",
            );
          emit(
            entry,
            "user_message",
            { text: text(message.content), nativeContent: json(message.content) },
            withImages(message.content, entry.id),
          );
          settled = false;
          continue;
        }
        if (message.role === "assistant") {
          nativeMetadata.push(
            json({
              type: "omp_assistant_metadata",
              uuid: entry.id,
              api: message.api,
              provider: message.provider,
              model: message.model,
              usage: message.usage,
              stopReason: message.stopReason,
              errorMessage: message.errorMessage,
            }),
          );
          metadataRecords.add(entry.id);
          assistantModel =
            typeof message.model === "string"
              ? `${message.provider}/${message.model}`
              : assistantModel;
          current ??= begin(entry);
          if (assistantModel) current.model ??= assistantModel;
          emissionModel = assistantModel;
          const status: NativeTerminalStatus =
            message.stopReason === "error"
              ? "failed"
              : ["aborted", "length"].includes(message.stopReason)
                ? "interrupted"
                : "completed";
          for (const [at, block] of message.content.entries()) {
            const id = `${entry.id}:${at}`;
            if (block.type === "text")
              emit(
                entry,
                "assistant_message",
                {
                  text: block.text,
                  ...(message.stopReason === "toolUse"
                    ? { phase: "commentary" }
                    : { phase: "final_answer" }),
                },
                { id, status },
              );
            else if (block.type === "thinking")
              emit(entry, "reasoning", { text: block.thinking || "" }, { id, status });
            else if (block.type === "toolCall") {
              const args = block.arguments ?? {};
              const command =
                block.name === "bash" && typeof args.command === "string"
                  ? args.command
                  : undefined;
              const isCommand = command !== undefined;
              const item = emit(
                entry,
                isCommand ? "command_execution" : "dynamic_tool",
                isCommand
                  ? { input: command!, nativeInput: json(args) }
                  : { toolName: block.name, input: json(args) },
                {
                  id,
                  title: command ?? block.name,
                  status: "interrupted",
                  startedAt: iso(entry.timestamp, baseAt),
                },
              );
              if (toolCalls.has(block.id))
                throw new Error(
                  `OMP repeated native tool call ID '${block.id}'; refusing ambiguous tool results.`,
                );
              toolCalls.set(block.id, item);
            } else if (block.type === "image")
              emit(
                entry,
                "assistant_message",
                { text: text([block]), nativeContent: json(block) },
                { id, status, ...withImages([block], id) },
              );
            else {
              warnings.add(
                `OMP assistant block '${block.type}' is retained as native tool content.`,
              );
              emit(
                entry,
                "dynamic_tool",
                { toolName: `omp.${block.type}`, input: {}, output: json(block) },
                { id, status },
              );
            }
          }
          if (message.errorMessage)
            emit(
              entry,
              "system_notice",
              { message: message.errorMessage, level: status === "failed" ? "error" : "info" },
              { id: `${entry.id}:error`, status },
            );
          current ??= begin(entry);
          current.status = status;
          current.completedAt = iso(entry.timestamp, current.completedAt);
          emissionModel = undefined;
          settled =
            message.stopReason !== "toolUse" &&
            ["stop", "length", "aborted", "error"].includes(message.stopReason);
          continue;
        }
        if (message.role === "toolResult") {
          const call = toolCalls.get(message.toolCallId);
          const output = text(message.content);
          const status = message.isError ? "failed" : "completed";
          if (call) {
            mappedRecords.add(entry.id);
            nativeMetadata.push(
              json({
                type: "omp_tool_result_metadata",
                uuid: entry.id,
                mappedItemId: call.id,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                details: message.details,
                isError: message.isError,
              }),
            );
            call.status = status;
            const completedAt = iso(entry.timestamp, baseAt);
            if (call.startedAt && Date.parse(completedAt) < Date.parse(call.startedAt)) {
              nativeMetadata.push(
                json({
                  type: "omp_tool_clock_skew",
                  uuid: entry.id,
                  mappedItemId: call.id,
                  startedAt: call.startedAt,
                  completedAt,
                }),
              );
              delete call.startedAt;
              warnings.add(
                `OMP tool '${call.id}' ends before it starts; both native timestamps were retained in metadata.`,
              );
            } else {
              call.completedAt = completedAt;
            }
            call.data.output =
              call.kind === "command_execution"
                ? output
                : json({
                    content: message.content,
                    details: message.details,
                    isError: message.isError,
                  });
            const exitCode =
              message.details && typeof message.details === "object"
                ? Reflect.get(message.details, "exitCode")
                : undefined;
            if (typeof exitCode === "number") call.data.exitCode = exitCode;
            if (message.isError) call.data.outputIndicatesFailure = true;
            const attached = images(message.content, entry.id);
            if (attached.length) call.images = [...(call.images || []), ...attached];
            if (Date.parse(completedAt) >= Date.parse(current!.completedAt))
              current!.completedAt = completedAt;
          } else {
            warnings.add(
              "An OMP tool result has no initiating call in the selected branch; its complete content was retained.",
            );
            emit(
              entry,
              "dynamic_tool",
              { toolName: message.toolName || "omp.toolResult", input: {}, output: json(message) },
              { status, ...withImages(message.content, entry.id) },
            );
          }
          continue;
        }
        if (message.role === "bashExecution" || message.role === "pythonExecution") {
          if (!current || settled) begin(entry);
          const command = message.role === "bashExecution" ? message.command : message.code;
          emit(
            entry,
            "command_execution",
            {
              input: command,
              output: message.output ?? "",
              ...(typeof message.exitCode === "number" ? { exitCode: message.exitCode } : {}),
              nativeContent: json(message),
            },
            {
              title: command,
              status: message.cancelled ? "interrupted" : message.exitCode ? "failed" : "completed",
              ...withImages(message.role === "bashExecution" ? message.images : [], entry.id),
            },
          );
          settled = true;
          continue;
        }
        if (message.role === "fileMention") {
          emit(
            entry,
            "system_notice",
            {
              message:
                message.files
                  .map((file) =>
                    file.skippedReason
                      ? `Skipped ${file.path} (${file.skippedReason})`
                      : `Read ${file.path}`,
                  )
                  .join("\n") || "Referenced files",
              level: "info",
              nativeContent: json(message),
            },
            withImages(
              message.files.flatMap((file) => (file.image ? [file.image] : [])),
              entry.id,
            ),
          );
          continue;
        }
        const content = "content" in message ? message.content : undefined;
        if (message.role === "custom" || message.role === "hookMessage") {
          if (message.customType === "async-result") {
            // OMP's transcript uses the structured job identities; the wrapped body is model context.
            const details = message.details as
              | { jobId?: string; jobs?: Array<{ jobId?: string }> }
              | undefined;
            const ids = (details?.jobs?.length ? details.jobs : [details]).flatMap((job) =>
              typeof job?.jobId === "string" ? [job.jobId] : [],
            );
            const title =
              ids.length > 1
                ? `${ids.length} background jobs completed`
                : "Background job completed";
            const output = unwrapNotice(text(content), "system-notice")
              .replace(
                /^(?:Background job [^\n]+ has completed\.|\d+ background jobs have completed\.)\s*(?:Resume your work using the results? below\.\s*)?/u,
                "",
              )
              .trim();
            emit(
              entry,
              "system_notice",
              {
                message: [ids.length ? `${title}: ${ids.join(", ")}` : title, output]
                  .filter(Boolean)
                  .join("\n\n"),
                level: "info",
                nativeContent: json(message),
              },
              withImages(content, entry.id),
            );
            continue;
          }
          if (message.customType === "irc:incoming") {
            const details = message.details as { from?: string; message?: string } | undefined;
            const from = typeof details?.from === "string" ? details.from : undefined;
            const body =
              typeof details?.message === "string"
                ? details.message
                : unwrapNotice(text(content), "irc");
            emit(
              entry,
              "system_notice",
              {
                message: [from ? `Message from ${from}` : "Agent message", body]
                  .filter(Boolean)
                  .join("\n\n"),
                level: "info",
                nativeContent: json(message),
              },
              withImages(content, entry.id),
            );
            continue;
          }
        }
        const description =
          "summary" in message
            ? String(message.summary)
            : `OMP ${message.role}: ${"customType" in message ? message.customType : entry.id}`;
        emit(
          entry,
          "system_notice",
          { message: text(content) || description, nativeContent: json(message) },
          withImages(content, entry.id),
        );
        continue;
      }
      if (entry.type === "model_change")
        emit(
          entry,
          "system_notice",
          {
            message: `OMP model changed (${entry.role || "default"}): ${entry.model}`,
            level: "info",
            nativeContent: json(entry),
          },
          { model: entry.model },
        );
      else if (entry.type === "compaction")
        emit(entry, "compaction", {
          driver: "pi",
          summary: entry.summary || "",
          nativeContent: json(entry),
        });
      else if (entry.type === "branch_summary")
        emit(entry, "system_notice", {
          message: entry.summary || "OMP branch summary",
          level: "info",
          nativeContent: json(entry),
        });
      else if (entry.type === "reset_boundary")
        emit(entry, "system_notice", {
          message:
            "OMP conversation context cleared; preceding historical messages remain visible.",
          level: "info",
        });
      else if (entry.type === "model_usage")
        nativeMetadata.push(json({ type: "omp_model_usage", nativeContent: entry }));
      else if (!invisibleKinds.has(entry.type)) {
        nativeMetadata.push(
          json({ type: "omp_opaque_record", uuid: entry.id, nativeContent: entry }),
        );
        metadataRecords.add(entry.id);
        warnings.add(
          `OMP native entry '${String(entry.type)}' has no known presentation; its selected payload was retained in native metadata.`,
        );
      }
    }
    const closedTail =
      aborted || source.archived === true || exit.sessionExitFollowsLastMessage(branch);
    const incompleteTail = Boolean(current && !settled);
    const snapshotTail = request.options.snapshot === true && incompleteTail && !closedTail;
    if (incompleteTail) {
      current!.status = "interrupted";
      warnings.add(
        source.archived === true
          ? "The OMP cold archive contains an unfinished last turn; the tail is preserved as interrupted."
          : closedTail
            ? "OMP recorded a process exit before completing its last turn; the tail is preserved as interrupted."
            : snapshotTail
              ? "The OMP snapshot preserves the unfinished native tail as interrupted history without a continuation."
              : "The OMP session ends in an incomplete turn without a native process-exit marker; importing must wait for a settled source.",
      );
    }
    if (pending.length)
      warnings.add(
        "Unfinished OMP tool calls are preserved as interrupted activity without fabricated results.",
      );

    const leaseAfter = storageModule.isSessionLeaseHeld(header.id);
    const active =
      leaseBefore !== false ||
      leaseAfter !== false ||
      (incompleteTail && !closedTail && !snapshotTail);
    if (leaseBefore !== false || leaseAfter !== false)
      warnings.add(
        "OMP's native session ownership probe reports a live owner or an unknown lease; importing must wait.",
      );

    const model =
      contextModule.getRestorableSessionModels(
        nativeContext.models,
        manager.lastModelChangeRole(branch),
      )[0] || assistantModel;
    if (aborted)
      warnings.add(
        "OMP native tombstone marks this child as aborted; unfinished history remains interrupted without a live continuation.",
      );
    return {
      ...source,
      title: header.title || source.title,
      workspace: header.cwd,
      ...(model ? { model } : {}),
      sourceHome: agentDir,
      nativeSessionRef: sourcePath,
      ...(snapshotTail ? { resumeSupported: false } : {}),
      driver: "pi",
      nativeMetadata,
      sourceCoverage: {
        schemaVersion: 1,
        selectedRecords: visibleRecords.size,
        mappedRecords: [...visibleRecords.keys()].filter((id) => mappedRecords.has(id)).length,
        metadataOnlyRecords: [...visibleRecords.keys()].filter(
          (id) => !mappedRecords.has(id) && metadataRecords.has(id),
        ).length,
        missingRecordIds: [...visibleRecords.keys()].filter(
          (id) => !mappedRecords.has(id) && !metadataRecords.has(id),
        ),
        nativeKinds: Object.fromEntries(
          [...new Set(visibleRecords.values())].map((kind) => [
            kind,
            [...visibleRecords.values()].filter((value) => value === kind).length,
          ]),
        ),
      },
      turns,
      warnings: [...warnings],
      active,
    };
  };
  let source: NativeSourceSummary;
  if (compressed) {
    const { archived: _archiveMarker, ...summary } = summarizeArchive(loaded, path);
    source = archived ? { ...summary, archived: true } : summary;
  } else {
    const info = await listing.readSessionInfo(path);
    if (!info) throw new Error("OMP native discovery cannot describe the loaded source file.");
    source = { ...summarize(info), ...(inside(sessionsRoot, path) ? { archived: false } : {}) };
  }
  const result = await normalizeHistory(loaded.entries, source, path);
  if (compressed) result.resumeSupported = false;
  const collect = async () => {
    let needsJournalCheck = false;
    const records = await subSessions.collectSubSessions(path, {
      includeCompressed: true,
      includeAdvisors: true,
      onUnreadable(key) {
        if (key === "changes") {
          needsJournalCheck = true;
          return;
        }
        throw new Error(
          `OMP native child '${key}' has an unreadable session header; refusing partial family history.`,
        );
      },
    });
    if (needsJournalCheck) {
      const { ChangeJournal } = (await import(
        pathToFileURL(join(request.packageRoot, "src/commit/selective/journal.ts")).href
      )) as typeof SelectiveCommit;
      const journal = await ChangeJournal.at(path.slice(0, compressed ? -9 : -6)).read();
      if (
        journal.length === 0 ||
        !journal.every(
          (entry) =>
            entry &&
            typeof entry.agent === "string" &&
            ["change", "call", "commit"].includes(entry.type),
        )
      )
        throw new Error(
          "OMP native child 'changes' has an unreadable session header and is not a native change journal.",
        );
    }
    return records;
  };
  const signature = (records: Record<string, SubSessions.SubSession>): string => {
    const digest = createHash("sha256");
    for (const [key, record] of Object.entries(records).sort(([a], [b]) => a.localeCompare(b)))
      digest.update(JSON.stringify([key, record]));
    return digest.digest("hex");
  };
  let collected = await collect();
  const originalChildren = signature(collected);
  const children = new Map<string, NativeConversation>();
  const childAgentIds = new Map<string, string>();
  const nativeIds = new Map<NativeConversation, string>([[result, header.id]]);
  for (const [key, record] of Object.entries(collected).sort(([a], [b]) => a.localeCompare(b))) {
    if (!record.header || typeof record.header.cwd !== "string")
      throw new Error(
        `OMP native child '${key}' has no usable header; refusing partial family history.`,
      );
    if (record.malformedRecords)
      throw new Error(
        `OMP native child '${key}' contains ${record.malformedRecords} malformed record(s); refusing partial family history.`,
      );
    let childPath = join(path.slice(0, compressed ? -9 : -6), `${key}.jsonl`);
    try {
      await access(childPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      childPath += ".gz";
      await access(childPath);
    }
    const nativeHeader = json(record.header);
    const child = await normalizeHistory(
      [record.header, ...record.entries],
      {
        source: "omp",
        id: `${result.id}:agent:${key}`,
        title: record.header.title || `OMP ${record.agentId}`,
        workspace: record.header.cwd,
        createdAt: iso(record.header.timestamp),
        updatedAt: iso(record.entries.at(-1)?.timestamp, iso(record.header.timestamp)),
        path: childPath,
        ...(archived ? { archived: true } : {}),
      },
      childPath,
      record.aborted,
    );
    child.resumeSupported = false;
    child.parent = { sourceId: record.parent ? `${result.id}:agent:${record.parent}` : result.id };
    child.nativeMetadata = [
      ...(child.nativeMetadata ?? []),
      json({
        type: "omp_subsession",
        key,
        parent: record.parent,
        header: nativeHeader,
        aborted: record.aborted,
      }),
    ];
    children.set(key, child);
    childAgentIds.set(key, record.agentId);
    nativeIds.set(child, record.header.id);
  }
  // Native loaders own discovery, decompression and parsing; re-reading through
  // that same API detects changing/added/deleted children without a second parser.
  collected = {};
  if (originalChildren !== signature(await collect()))
    throw new Error(
      "OMP native child history changed while reading; refusing an inconsistent family snapshot.",
    );
  const owners = new Map<string, NativeConversation>([
    [result.id, result],
    ...[...children.values()].map((child) => [child.id, child] as const),
  ]);
  const launchesByOwner = new Map<string, ReturnType<typeof taskLaunchItems>>();
  for (const [key, child] of children) {
    const owner = owners.get(child.parent!.sourceId);
    if (!owner)
      throw new Error(
        `OMP native child '${key}' names an unavailable parent; refusing incomplete lineage.`,
      );
    let launches = launchesByOwner.get(owner.id);
    if (!launches) {
      launches = taskLaunchItems(owner);
      launchesByOwner.set(owner.id, launches);
    }
    const nativeItemId = launches.get(childAgentIds.get(key)!);
    if (nativeItemId) child.parent!.nativeItemId = nativeItemId;
    (owner.children ??= []).push(child);
  }
  for (const [conversation, nativeId] of nativeIds)
    if (storageModule.isSessionLeaseHeld(nativeId) !== false) {
      conversation.active = true;
      conversation.warnings.push(
        "OMP's native session ownership probe reports a live owner or an unknown lease after family reading; importing must wait.",
      );
    }
  if (before !== (await snapshot(path))) {
    result.active = true;
    result.warnings.push(
      "The OMP source changed during reading; importing must wait for it to settle.",
    );
  }
  // The final native lease check must run before omitting an empty transcript.
  moveEmptySubsessionsToMetadata(result);
  return result;
}

// stdout is a single transport response; diagnostics from the native package stay on stderr.
const nativeLog = console.log;
console.log = (...values) => console.error(...values);
try {
  const input = await Bun.stdin.text();
  const value = await execute(JSON.parse(input));
  await writeNativeJson({ ok: true, value }, false);
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
} finally {
  console.log = nativeLog;
}
