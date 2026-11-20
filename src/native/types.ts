export type NativeSource = "codex" | "omp" | "claude";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type NativeTerminalStatus = "completed" | "interrupted" | "failed";
export type NativeItemKind =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "web_search"
  | "compaction"
  | "proposed_plan"
  | "todo_list"
  | "dynamic_tool"
  | "run_interrupt_result"
  | "system_notice";

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
  /** Genuine native tool interval endpoints, when the source exposes them. */
  startedAt?: string;
  completedAt?: string;
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
  /** Source archive status; undefined when the native surface cannot establish it. */
  archived?: boolean;
  /** Native parent of a listed child session, when the history API reports one. */
  parentSessionId?: string;
  model?: string;
  path?: string;
}

export interface NativeConversation extends NativeSourceSummary {
  /** Complete text versions explicitly recorded by native tools, not live disk reads. */
  fileSnapshots?: Array<{ path: string; content: string; nativeItemId: string; timestamp: string }>;
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
  parent?: { sourceId: string; nativeItemId?: string; relationship?: "subagent" | "fork" };
  /** Selected native metadata retained outside visible chat (opaque SDK records). */
  nativeMetadata?: JsonValue[];
  /** The native source supplied stable metadata but no transcript turns. */
  historyMetadataOnly?: "missing-native-transcript" | "no-visible-turns";
  /** Native child IDs whose unavailable transcripts are represented by metadata on this thread. */
  retainedChildMetadata?: string[];
  sourceCoverage?: NativeSourceCoverage;
  turns: NativeHistoryTurn[];
  warnings: string[];
  /** True if any source turn is still running; importing must refuse it. */
  active: boolean;
}

export interface NativeHistoryCollection<T> extends Iterable<T> {
  readonly length: number;
}

export interface NativeHistoryTurnView extends Omit<NativeHistoryTurn, "items"> {
  items: NativeHistoryCollection<NativeHistoryItem>;
}

/** A replayable history view, optionally backed by temporary reader storage. */
export interface NativeConversationView extends Omit<
  NativeConversation,
  "turns" | "nativeMetadata" | "children"
> {
  turns: NativeHistoryCollection<NativeHistoryTurnView>;
  nativeMetadata?: NativeHistoryCollection<JsonValue>;
  children?: NativeConversationView[];
}

export type NativeHistoryStage = <T>(value: T) => () => T;

export interface NativeReadOptions {
  workspace?: string;
  since?: string;
  archived?: boolean;
  sourceHome?: string;
  binary?: string;
  ompPackage?: string;
  bunBinary?: string;
  /** Codex inventory from its state index, without an app-server rollout scan. */
  codexIndexOnly?: boolean;
  /** Deliberate Claude history-only snapshot; incomplete tails remain interrupted. */
  snapshot?: boolean;
}

export interface NativeSourceReader {
  list(options: NativeReadOptions): Promise<NativeSourceSummary[]>;
  read(id: string, options: NativeReadOptions): Promise<NativeConversation>;
  readSnapshot?(
    id: string,
    options: NativeReadOptions,
    stage: NativeHistoryStage,
  ): Promise<NativeConversationView>;
  close(): Promise<void>;
}

export interface NativeWriteOptions {
  /** Materialize recorded text into an isolated target workspace; history-only. */
  restoreWorkspace?: boolean;
  t3Home: string;
  dryRun: boolean;
  providerInstance?: string;
  resume: boolean;
  /** Put newly imported, non-archived roots on T3's Settled shelf. */
  settled?: boolean;
  oldFamilyDays?: number;
  oldFamilyAction?: "keep" | "settle" | "archive";
  archiveEmptyChildren?: boolean;
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
  placement: NativeThreadPlacement;
  historyMetadataOnly?: NativeConversation["historyMetadataOnly"];
  retainedChildMetadata?: string[];
  quality?: {
    targetSchema: "validated";
    serverVerification: "not-run";
    metadataEscrowedFields: number;
    sourceCoverage?: NativeSourceCoverage;
  };
  warnings: string[];
}

export interface NativeThreadPlacement {
  state: "active" | "settled" | "archived";
  reason:
    | "recent-family"
    | "inactive-family"
    | "inactive-family-kept"
    | "historical-child"
    | "empty-subagent"
    | "source-archive"
    | "metadata-only"
    | "requested-settle"
    | "already-imported";
  familyLastActivityAt?: string;
}

export interface NativeImportResult {
  schemaVersion: 1;
  status: "dry-run" | "imported" | "already-imported" | "mixed";
  target: string;
  migration: number;
  backup: string | null;
  placementCounts: Record<NativeThreadPlacement["state"], number>;
  results: NativeWriteResult[];
}

/** Evidence committed before T3 serves the import; contains hashes, never transcript bodies. */
export interface NativeAuditEntry {
  id: string;
  fields: string[];
  sha256: string;
}
export interface NativeAuditManifest {
  schemaVersion: 1;
  threadId: string;
  source: NativeSource;
  sourceId: string;
  children: string[];
  warnings: string[];
  escrowedFields: number;
  project?: { id: string; workspaceRoot: string };
  sourceCoverage?: NativeSourceCoverage;
  collections: Record<string, NativeAuditEntry[]>;
  details: NativeAuditEntry[];
  metadataDigest?: string;
  metadataRecords?: number;
  assets: Array<{ name: string; relativePath?: string; sha256: string; sizeBytes: number }>;
}

/** Native selected-record accounting; does not claim access to provider-hidden fields. */
export interface NativeSourceCoverage {
  schemaVersion: 1;
  selectedRecords: number;
  mappedRecords: number;
  metadataOnlyRecords: number;
  missingRecordIds: string[];
  nativeKinds: Record<string, number>;
}
