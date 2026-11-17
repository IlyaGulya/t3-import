/** Runs under Bun so the installed OMP package executes its own native session implementation. */
import { createReadStream } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeConversation, NativeHistoryItem, NativeHistoryTurn, NativeImage, NativeReadOptions, NativeSourceSummary, NativeTerminalStatus, JsonValue } from "../src/native/types.js";

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
import type * as Exit from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import type * as Dirs from "@oh-my-pi/pi-utils/dirs";
import type * as Logger from "@oh-my-pi/pi-utils/logger";
import type * as Transcript from "@oh-my-pi/pi-tui/chat/transcript-entry";
type Entry = EntryModule.SessionEntry;
interface Request { operation: "list" | "read"; packageRoot: string; options: NativeReadOptions; id?: string; path?: string }

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]));
  return String(value);
}
async function canonical(path: string): Promise<string> { try { return await realpath(resolve(path)); } catch { return resolve(path); } }
async function sameWorkspace(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([canonical(left), canonical(right)]);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function iso(value: unknown, fallback = "1970-01-01T00:00:00.000Z"): string {
  const date = new Date(value instanceof Date || typeof value === "string" || typeof value === "number" ? value : fallback);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}
async function snapshot(path: string): Promise<string> {
  const before = await stat(path, { bigint: true });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await stat(path, { bigint: true });
  const key = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  if (key(before) !== key(after)) throw new Error("OMP source changed while snapshotting; wait for the session to settle.");
  return `${key(after)}:${hash.digest("hex")}`;
}

async function execute(request: Request): Promise<NativeSourceSummary[] | NativeConversation> {
  if (!request || !["list", "read"].includes(request.operation) || typeof request.packageRoot !== "string" || !request.options) throw new Error("Invalid OMP native helper request.");
  const manifest = JSON.parse(await readFile(join(request.packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@oh-my-pi/pi-coding-agent" || manifest.version !== "18.22.0") throw new Error("Unsupported OMP source package: expected @oh-my-pi/pi-coding-agent@18.22.0.");
  const bun = globalThis.Bun;
  if (!bun?.resolveSync) throw new Error("OMP native history helper must run with Bun.");
  const logger = await import(pathToFileURL(bun.resolveSync("@oh-my-pi/pi-utils/logger", request.packageRoot)).href) as typeof Logger;
  // Native default logging creates/rotates files outside the session store. Its supported
  // forwarding API keeps this reader read-only and preserves diagnostics on stderr.
  if (typeof logger.setLogForwarder !== "function") throw new Error("OMP native read-only log forwarding is unavailable.");
  logger.setLogForwarder({ emit(event) { process.stderr.write(`OMP ${event.level}: ${event.message}\n`); }, flush() {} });
  const module = <T>(name: string): Promise<T> => import(pathToFileURL(join(request.packageRoot, "src/session", `${name}.ts`)).href) as Promise<T>;
  const [loader, listing, storageModule, migrations, entryModule, manager, contextModule, blobs, exit] = await Promise.all([
    module<typeof Loader>("session-loader"), module<typeof Listing>("session-listing"), module<typeof Storage>("session-storage"), module<typeof Migrations>("session-migrations"), module<typeof EntryModule>("session-entries"), module<typeof Manager>("session-manager"), module<typeof Context>("session-context"), module<typeof Blobs>("blob-store"), module<typeof Exit>("exit-diagnostics"),
  ]);
  const [dirs, transcript] = await Promise.all([
    import(pathToFileURL(bun.resolveSync("@oh-my-pi/pi-utils/dirs", request.packageRoot)).href) as Promise<typeof Dirs>,
    import(pathToFileURL(bun.resolveSync("@oh-my-pi/pi-tui/chat/transcript-entry", request.packageRoot)).href) as Promise<typeof Transcript>,
  ]);
  for (const [object, name] of [[loader, "loadSessionFile"], [loader, "resolveBlobRefsInEntries"], [listing, "listAllSessions"], [listing, "readSessionInfo"], [storageModule, "isSessionLeaseHeld"], [manager, "SessionEntryIndex"], [manager, "lastModelChangeRole"], [contextModule, "getRestorableSessionModels"], [contextModule, "buildSessionContext"], [contextModule, "isTranscriptEntry"], [transcript, "isUserRequestEntry"], [transcript, "transcriptEntryMessage"], [exit, "sessionExitFollowsLastMessage"], [exit, "collectPendingToolCalls"]] as const) {
    if (typeof Reflect.get(object, name) !== "function") throw new Error(`OMP native history API '${name}' is unavailable; no custom parser fallback is used.`);
  }
  const options = request.options;
  if (options.archived) throw new Error("OMP has no separate native archived-session listing; omit --archived.");
  const since = options.since === undefined ? undefined : Date.parse(options.since);
  if (since !== undefined && Number.isNaN(since)) throw new Error(`Invalid --since date: ${options.since}`);
  const agentDir = await canonical(options.sourceHome || dirs.getAgentDir());
  const sessionsRoot = dirs.getSessionsDir(agentDir);
  const storage = new storageModule.FileSessionStorage();
  const summarize = (info: Listing.SessionInfo): NativeSourceSummary => ({ source: "omp", id: info.id, title: listing.sessionDisplayName(info) || "Untitled OMP session", workspace: info.cwd, createdAt: iso(info.created), updatedAt: iso(info.modified), path: info.path });
  const list = async (): Promise<Listing.SessionInfo[]> => {
    try { await access(sessionsRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const infos = await listing.listAllSessions(storage, sessionsRoot);
    const seen = new Map<string, string>();
    const selected: Listing.SessionInfo[] = [];
    for (const info of infos) {
      if (seen.has(info.id) && seen.get(info.id) !== info.path) throw new Error(`Multiple OMP files claim session '${info.id}'; use an explicit session file path.`);
      seen.set(info.id, info.path);
      if (options.workspace && !await sameWorkspace(info.cwd, options.workspace)) continue;
      if (since !== undefined && Date.parse(iso(info.modified)) < since) continue;
      selected.push(info);
    }
    return selected;
  };
  if (request.operation === "list") return (await list()).map(summarize);
  if (!request.id) throw new Error("OMP session ID or file path is required.");
  let path = request.path;
  if (!path && (request.id.includes("/") || request.id.includes("\\") || request.id.endsWith(".jsonl"))) path = resolve(request.id);
  if (!path) {
    const matches = (await list()).filter((info) => info.id === request.id);
    if (matches.length !== 1) throw new Error(`OMP session '${request.id}' was not found in the selected native store.`);
    path = matches[0]!.path;
  }
  path = await realpath(path!);
  const before = await snapshot(path);
  const loaded = await loader.loadSessionFile(path, storage, { throwIfMissing: true });
  if (loaded.invalidHeader || !loaded.entries.length) throw new Error("OMP source has no valid session header; refusing incomplete history.");
  if (loaded.malformedRecords) throw new Error(`OMP's native loader reported ${loaded.malformedRecords} malformed record(s); refusing partial history.`);
  const header = loaded.entries[0]!;
  if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error("OMP native session header is incomplete.");
  if (typeof header.version === "number" && header.version > entryModule.CURRENT_SESSION_VERSION) throw new Error(`OMP session version ${header.version} is newer than the native loader supports.`);
  if (request.path && header.id !== request.id) throw new Error("OMP session file changed identity after discovery.");
  if (options.workspace && !await sameWorkspace(header.cwd, options.workspace)) throw new Error(`OMP session '${header.id}' belongs to another workspace.`);
  const leaseBefore = storageModule.isSessionLeaseHeld(header.id);
  migrations.migrateToCurrentVersion(loaded.entries); // In-memory migration only; no writable SessionManager is opened.
  await loader.resolveBlobRefsInEntries(loaded.entries, new blobs.BlobStore(dirs.getBlobsDir(agentDir)));
  const entries = loaded.entries.filter((entry: EntryModule.FileEntry) => entry.type !== "session");
  const index = new manager.SessionEntryIndex();
  index.rebuild(entries);
  const branch = index.pathTo();
  const pending = exit.collectPendingToolCalls(branch);
  const nativeContext = contextModule.buildSessionContext(entries, index.leafId(), index.entriesById(), {
    transcript: true, collapseCompactedHistory: false,
    inFlightToolCallIds: new Set(pending.map((call) => call.toolCallId).filter((id): id is string => typeof id === "string")),
  });
  const warnings = new Set<string>();
  if (entries.filter((entry: EntryModule.FileEntry) => entry.type === "message" || entry.type === "custom_message").length > branch.filter((entry) => entry.type === "message" || entry.type === "custom_message").length) warnings.add("Only OMP's selected active branch is imported; alternative branches remain in the native source file.");
  if (header.continuationOf) warnings.add("This OMP file continues another native session; its stored history is imported without inventing or concatenating a second session.");
  const turns: NativeHistoryTurn[] = [];
  let current: NativeHistoryTurn | undefined;
  let settled = true;
  let assistantModel: string | undefined;
  let emissionModel: string | undefined;
  const toolCalls = new Map<string, NativeHistoryItem>();
  const baseAt = iso(header.timestamp);
  const begin = (entry: Entry) => {
    const timestamp = iso(entry.timestamp, baseAt);
    current = { id: entry.id, status: "completed", startedAt: timestamp, completedAt: timestamp, items: [] };
    turns.push(current); settled = false;
    return current;
  };
  const emit = (entry: Entry, kind: NativeHistoryItem["kind"], data: NativeHistoryItem["data"], extra: Partial<NativeHistoryItem> = {}) => {
    const turn = current ?? begin(entry);
    const item: NativeHistoryItem = { id: entry.id, kind, timestamp: iso(entry.timestamp, turn.completedAt), status: "completed", data, ...(emissionModel ? { model: emissionModel } : {}), ...extra };
    if (kind === "system_notice" && item.images?.length) warnings.add("Images on OMP system notices are retained in native content; T3 does not display notice attachments.");
    turn.items.push(item);
    // Session metadata may be recorded hours after a native stop. It remains
    // visible at its original time, without reopening completed provider work.
    if (!settled) turn.completedAt = item.timestamp;
    return item;
  };
  const images = (content: unknown, id: string): NativeImage[] => {
    if (!Array.isArray(content)) return [];
    return content.flatMap((block, at) => {
      if (block?.type !== "image") return [];
      if (typeof block.data !== "string" || typeof block.mimeType !== "string") { warnings.add("An OMP image has no readable data or MIME type and was retained only in its native tool payload."); return []; }
      if (blobs.parseBlobRef(block.data)) { warnings.add(`OMP image blob '${block.data}' is missing from the native blob store; its reference was retained.`); return []; }
      return [{ id: `${id}:image:${at}`, name: `${id}-${at}.${block.mimeType.split("/")[1] || "png"}`, mimeType: block.mimeType, base64: block.data }];
    });
  };
  const text = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const references = content.flatMap((block) => block?.type === "image" && typeof block.data === "string" && blobs.parseBlobRef(block.data) ? [`[Unavailable image: ${block.data}]`] : []);
    return [transcript.textContent(content, "\n\n"), ...references].filter(Boolean).join("\n\n");
  };
  const withImages = (content: unknown, id: string): Partial<NativeHistoryItem> => { const result = images(content, id); return result.length ? { images: result } : {}; };
  for (const entry of branch) {
    if (contextModule.isTranscriptEntry(entry)) {
      const message = transcript.transcriptEntryMessage(entry);
      if (!message) throw new Error(`OMP native transcript rejected message '${entry.id}'; refusing partial history.`);
      const user = transcript.isUserRequestEntry(entry);
      // Native transcript normalization owns display/attribution; the native TUI
      // suppresses non-display extension content, while real request initiators stay intact.
      if ((message.role === "custom" || message.role === "hookMessage") && !message.display && !user) continue;
      if (user && (!current || settled)) begin(entry);
      if (user) {
        if (!("content" in message)) throw new Error("OMP native request classification returned a message without content.");
        emit(entry, "user_message", { text: text(message.content), nativeContent: json(message.content) }, withImages(message.content, entry.id));
        settled = false;
        continue;
      }
      if (message.role === "assistant") {
        assistantModel = typeof message.model === "string" ? `${message.provider}/${message.model}` : assistantModel;
        current ??= begin(entry);
        if (assistantModel) current.model ??= assistantModel;
        emissionModel = assistantModel;
        const status: NativeTerminalStatus = message.stopReason === "error" ? "failed" : ["aborted", "length"].includes(message.stopReason) ? "interrupted" : "completed";
        for (const [at, block] of message.content.entries()) {
          const id = `${entry.id}:${at}`;
          if (block.type === "text") emit(entry, "assistant_message", { text: block.text, ...(message.stopReason === "toolUse" ? { phase: "commentary" } : { phase: "final_answer" }) }, { id, status });
          else if (block.type === "thinking") emit(entry, "reasoning", { text: block.thinking || "" }, { id, status });
          else if (block.type === "toolCall") {
            const args = block.arguments ?? {};
            const command = block.name === "bash" && typeof args.command === "string" ? args.command : undefined;
            const isCommand = command !== undefined;
            const item = emit(entry, isCommand ? "command_execution" : "dynamic_tool", isCommand ? { input: command!, nativeInput: json(args) } : { toolName: block.name, input: json(args) }, { id, title: command ?? block.name, status: "interrupted" });
            if (toolCalls.has(block.id)) throw new Error(`OMP repeated native tool call ID '${block.id}'; refusing ambiguous tool results.`);
            toolCalls.set(block.id, item);
          } else if (block.type === "image") emit(entry, "assistant_message", { text: text([block]), nativeContent: json(block) }, { id, status, ...withImages([block], id) });
          else { warnings.add(`OMP assistant block '${block.type}' is retained as native tool content.`); emit(entry, "dynamic_tool", { toolName: `omp.${block.type}`, input: {}, output: json(block) }, { id, status }); }
        }
        if (message.errorMessage) emit(entry, "system_notice", { message: message.errorMessage }, { id: `${entry.id}:error`, status });
        current ??= begin(entry);
        current.status = status;
        current.completedAt = iso(entry.timestamp, current.completedAt);
        emissionModel = undefined;
        settled = message.stopReason !== "toolUse" && ["stop", "length", "aborted", "error"].includes(message.stopReason);
        continue;
      }
      if (message.role === "toolResult") {
        const call = toolCalls.get(message.toolCallId);
        const output = text(message.content);
        const status = message.isError ? "failed" : "completed";
        if (call) {
          call.status = status;
          call.data.output = call.kind === "command_execution" ? output : json({ content: message.content, details: message.details, isError: message.isError });
          const exitCode = message.details && typeof message.details === "object" ? Reflect.get(message.details, "exitCode") : undefined;
          if (typeof exitCode === "number") call.data.exitCode = exitCode;
          if (message.isError) call.data.outputIndicatesFailure = true;
          const attached = images(message.content, entry.id); if (attached.length) call.images = [...(call.images || []), ...attached];
          current!.completedAt = iso(entry.timestamp, current!.completedAt);
        } else { warnings.add("An OMP tool result has no initiating call in the selected branch; its complete content was retained."); emit(entry, "dynamic_tool", { toolName: message.toolName || "omp.toolResult", input: {}, output: json(message) }, { status, ...withImages(message.content, entry.id) }); }
        continue;
      }
      if (message.role === "bashExecution" || message.role === "pythonExecution") {
        if (!current || settled) begin(entry);
        const command = message.role === "bashExecution" ? message.command : message.code;
        emit(entry, "command_execution", { input: command, output: message.output ?? "", ...(typeof message.exitCode === "number" ? { exitCode: message.exitCode } : {}), nativeContent: json(message) }, { title: command, status: message.cancelled ? "interrupted" : message.exitCode ? "failed" : "completed", ...withImages(message.role === "bashExecution" ? message.images : [], entry.id) });
        settled = true;
        continue;
      }
      const content = "content" in message ? message.content : undefined;
      const description = "summary" in message ? String(message.summary) : `OMP ${message.role}: ${"customType" in message ? message.customType : entry.id}`;
      emit(entry, "system_notice", { message: text(content) || description, nativeContent: json(message) }, withImages(content, entry.id));
      continue;
    }
    if (entry.type === "model_change") emit(entry, "system_notice", { message: `OMP model changed (${entry.role || "default"}): ${entry.model}`, nativeContent: json(entry) }, { model: entry.model });
    else if (entry.type === "compaction") emit(entry, "compaction", { driver: "pi", summary: entry.summary || "", nativeContent: json(entry) });
    else if (entry.type === "branch_summary") emit(entry, "system_notice", { message: entry.summary || "OMP branch summary", nativeContent: json(entry) });
    else if (entry.type === "reset_boundary") emit(entry, "system_notice", { message: "OMP conversation context cleared; preceding historical messages remain visible." });

  }
  const closedTail = exit.sessionExitFollowsLastMessage(branch);
  const incompleteTail = Boolean(current && !settled);
  if (incompleteTail) {
    current!.status = "interrupted";
    warnings.add(closedTail ? "OMP recorded a process exit before completing its last turn; the tail is preserved as interrupted." : "The OMP session ends in an incomplete turn without a native process-exit marker; importing must wait for a settled source.");
  }
  if (pending.length) warnings.add("Unfinished OMP tool calls are preserved as interrupted activity without fabricated results.");
  const info = await listing.readSessionInfo(path);
  if (!info) throw new Error("OMP native discovery cannot describe the loaded source file.");
  const after = await snapshot(path);
  const leaseAfter = storageModule.isSessionLeaseHeld(header.id);
  const active = leaseBefore !== false || leaseAfter !== false || before !== after || (incompleteTail && !closedTail);
  if (leaseBefore !== false || leaseAfter !== false) warnings.add("OMP's native session ownership probe reports a live owner or an unknown lease; importing must wait.");
  if (before !== after) warnings.add("The OMP source changed during reading; importing must wait for it to settle.");
  const model = contextModule.getRestorableSessionModels(nativeContext.models, manager.lastModelChangeRole(branch))[0] || assistantModel;
  return { ...summarize(info), id: header.id, title: loaded.titleSlot?.title || header.title || listing.sessionDisplayName(info), workspace: header.cwd,
    ...(model ? { model } : {}), sourceHome: agentDir, nativeSessionRef: path, driver: "pi", turns, warnings: [...warnings], active };
}

// stdout is a single transport response; diagnostics from the native package stay on stderr.
const nativeLog = console.log;
console.log = (...values) => console.error(...values);
try {
  const input = await Bun.stdin.text();
  const value = await execute(JSON.parse(input));
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
} finally { console.log = nativeLog; }
