export type NativeSource = "codex" | "omp" | "claude";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type NativeTerminalStatus = "completed" | "interrupted" | "failed";
export type NativeItemKind =
  | "user_message" | "assistant_message" | "reasoning" | "command_execution"
  | "file_change" | "web_search" | "compaction" | "proposed_plan"
  | "todo_list" | "dynamic_tool" | "system_notice";

export interface NativeImage {
  id: string;
  name: string;
  mimeType: string;
  path?: string;
  base64?: string;
  url?: string;
}

/** Content fields match T3 turn-item variants; all orchestration IDs are allocated by the writer. */
export interface NativeHistoryItem {
  id: string;
  kind: NativeItemKind;
  timestamp: string;
  status: NativeTerminalStatus;
  title?: string;
  /** Actual native model that produced this historical assistant item. */
  model?: string;
  data: { [key: string]: JsonValue };
  images?: NativeImage[];
}

export interface NativeHistoryTurn {
  id: string;
  /** Actual first assistant model; individual items retain any later model switches. */
  model?: string;
  status: NativeTerminalStatus;
  startedAt: string;
  completedAt: string;
  items: NativeHistoryItem[];
}

export interface NativeSourceSummary {
  source: NativeSource;
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  path?: string;
}

export interface NativeConversation extends NativeSourceSummary {
  /** Effective native storage root; used to check that the target provider can resume this history. */
  sourceHome?: string;
  /** Codex UUID; OMP session path for its Pi/RPC provider. */
  nativeSessionRef: string;
  /** False when the native API exposes a historical child snapshot without an independent resume target. */
  resumeSupported?: boolean;
  driver: "codex" | "pi" | "claudeAgent";
  /** Native child sessions, read through the same provider history API. */
  children?: NativeConversation[];
  /** Immediate native parent session and optional spawning history item. */
  parent?: { sourceId: string; nativeItemId?: string };
  turns: NativeHistoryTurn[];
  warnings: string[];
  /** True if any source turn is still running; importing must refuse it. */
  active: boolean;
}

export interface NativeReadOptions {
  workspace?: string;
  since?: string;
  archived?: boolean;
  sourceHome?: string;
  binary?: string;
  ompPackage?: string;
  bunBinary?: string;
  /** Deliberate Claude history-only snapshot; incomplete tails remain interrupted. */
  snapshot?: boolean;
}

export interface NativeSourceReader {
  list(options: NativeReadOptions): Promise<NativeSourceSummary[]>;
  read(id: string, options: NativeReadOptions): Promise<NativeConversation>;
  close(): Promise<void>;
}

export interface NativeWriteOptions {
  t3Home: string;
  dryRun: boolean;
  providerInstance?: string;
  resume: boolean;
  /** Destination grouping only; each native session keeps its original cwd. */
  projectRoot?: string;
  projectId?: string;
  /** Only used by tests/development, never initialize a missing user's database implicitly. */
  initialize?: boolean;
}

export interface NativeWriteResult {
  source: NativeSource;
  sourceId: string;
  threadId: string;
  projectId: string;
  status: "dry-run" | "imported" | "already-imported";
  turns: number;
  items: number;
  messages: number;
  resumable: boolean;
  warnings: string[];
}

export interface NativeImportResult {
  schemaVersion: 1;
  status: "dry-run" | "imported" | "already-imported" | "mixed";
  target: string;
  migration: number;
  backup: string | null;
  results: NativeWriteResult[];
}
