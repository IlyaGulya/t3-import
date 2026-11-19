import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { ORCHESTRATION_V2_WS_METHODS, ThreadId, TurnItemId, WsRpcGroup } from "@t3tools/contracts";
import { auditFingerprint } from "./fidelity.js";
import {
  readNativeImportAudit,
  withNativeImportMetadata,
  verifyNativeImportAssets,
} from "./target.js";
import type {
  NativeAuditEntry,
  NativeAuditManifest,
  NativeSourceCoverage,
} from "../src/native/types.js";

export interface NativeAuditOptions {
  t3Home: string;
  threadId: string;
  server: string;
  token: string;
  structureOnly?: boolean;
  family?: boolean;
}
export interface NativeAuditDimension {
  expected: number;
  actual: number;
  verified: number;
  missing: number;
  extra: number;
  changed: number;
  skipped: number;
}
export interface NativeAuditIssue {
  code: string;
  threadId: string;
  dimension: string;
  id?: string;
  message?: string;
}
export type NativeAuditStatus = "verified" | "verified-with-limitations" | "partial" | "failed";
export interface NativeAuditThreadReport {
  threadId: string;
  source: string;
  sourceId: string;
  escrowedFields: number;
  sourceCoverage?: NativeSourceCoverage;
  warnings: string[];
  dimensions: Record<string, NativeAuditDimension>;
}
export interface NativeAuditReport {
  schemaVersion: 1;
  status: NativeAuditStatus;
  threadId: string;
  scope: "family" | "thread";
  mode: "full" | "structure-only";
  threads: NativeAuditThreadReport[];
  issues: NativeAuditIssue[];
  suppressedIssues: number;
}
const emptyDimension = (expected = 0): NativeAuditDimension => ({
  expected,
  actual: 0,
  verified: 0,
  missing: 0,
  extra: 0,
  changed: 0,
  skipped: 0,
});
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function selectedFields(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}
function checkedOrigin(server: string): URL {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error("Audit requires a valid local T3 server origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Audit accepts only a loopback T3 origin without credentials, paths or query parameters.",
    );
  return url;
}

/** Compare saved import evidence with actual server projections and hydrated native RPC items. */
export async function auditNativeImport(options: NativeAuditOptions): Promise<NativeAuditReport> {
  const origin = checkedOrigin(options.server);
  if (!options.token || /\s/u.test(options.token))
    throw new Error(
      "Audit requires a nonempty server token supplied through the selected environment variable.",
    );
  const report: NativeAuditReport = {
    schemaVersion: 1,
    status: "verified",
    threadId: options.threadId,
    scope: options.family === false ? "thread" : "family",
    mode: options.structureOnly ? "structure-only" : "full",
    threads: [],
    issues: [],
    suppressedIssues: 0,
  };
  let failures = 0;
  let limitations = false;
  let incomplete = Boolean(options.structureOnly);
  const issue = (entry: NativeAuditIssue, failure = true) => {
    if (failure) failures++;
    else limitations = true;
    if (report.issues.length < 2000) report.issues.push(entry);
    else report.suppressedIssues++;
  };
  const request = async (path: string, method: "GET" | "POST" = "GET"): Promise<unknown> => {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin)
      throw new Error("Audit refuses to send credentials to another origin.");
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: "error",
        headers: { authorization: `Bearer ${options.token}`, "x-t3-orchestration-protocol": "2" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(
        "The local T3 audit request failed; server credentials and response bodies are omitted.",
      );
    }
    if (new URL(response.url).origin !== origin.origin)
      throw new Error("The T3 audit response changed origin.");
    if (!response.ok)
      throw new Error(`The local T3 audit endpoint returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new Error("The local T3 audit endpoint returned invalid JSON.");
    }
  };
  const manifests: NativeAuditManifest[] = [];
  const queued = [options.threadId];
  const seen = new Set<string>();
  while (queued.length) {
    const threadId = queued.shift()!;
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    if (seen.size > 10_000)
      throw new Error("Audit family traversal exceeds the supported 10,000-thread bound.");
    let manifest: NativeAuditManifest;
    try {
      manifest = readNativeImportAudit(options.t3Home, threadId);
    } catch {
      issue({
        code: "manifest_unavailable",
        threadId,
        dimension: "manifest",
        message:
          "No usable import audit manifest; a fresh import is required for this verification.",
      });
      continue;
    }
    if (manifest.schemaVersion !== 1 || manifest.threadId !== threadId) {
      issue({ code: "manifest_invalid", threadId, dimension: "manifest" });
      continue;
    }
    manifests.push(manifest);
    if (options.family !== false) queued.push(...manifest.children);
  }
  const detailJobs: Array<{ expected: NativeAuditEntry; thread: NativeAuditThreadReport }> = [];
  let projectRows: unknown[] | undefined;
  let shellRead = false;
  for (const manifest of manifests) {
    const thread: NativeAuditThreadReport = {
      threadId: manifest.threadId,
      source: manifest.source,
      sourceId: manifest.sourceId,
      escrowedFields: manifest.escrowedFields,
      warnings: [...manifest.warnings],
      ...(manifest.sourceCoverage ? { sourceCoverage: manifest.sourceCoverage } : {}),
      dimensions: {},
    };
    report.threads.push(thread);
    const project = emptyDimension(1);
    thread.dimensions.project = project;
    if (!manifest.project) {
      incomplete = true;
      project.skipped = 1;
      issue(
        { code: "project_unverified", threadId: manifest.threadId, dimension: "project" },
        false,
      );
    } else {
      if (!shellRead) {
        shellRead = true;
        try {
          // Pinned native HTTP shellSnapshot returns the shell directly, not a snapshot envelope.
          const shell = record(await request("/api/orchestration/shell"));
          if (Array.isArray(shell?.projects)) projectRows = shell.projects;
        } catch {
          // Each affected manifest receives an explicit unavailable dimension below.
        }
      }
      if (!projectRows) {
        project.missing = 1;
        issue({
          code: "project_collection_unavailable",
          threadId: manifest.threadId,
          dimension: "project",
        });
      } else {
        const matches = projectRows.map(record).filter((row) => row?.id === manifest.project!.id);
        project.actual = matches.length;
        if (!matches.length) {
          project.missing = 1;
          issue({
            code: "project_missing",
            threadId: manifest.threadId,
            dimension: "project",
            id: manifest.project.id,
          });
        } else if (
          matches.length !== 1 ||
          matches[0]!.workspaceRoot !== manifest.project.workspaceRoot
        ) {
          project.changed = 1;
          issue({
            code: "project_changed",
            threadId: manifest.threadId,
            dimension: "project",
            id: manifest.project.id,
          });
        } else project.verified = 1;
      }
    }
    const coverage = manifest.sourceCoverage;
    const source = emptyDimension(coverage?.selectedRecords ?? 1);
    thread.dimensions.source = source;
    if (coverage) {
      source.actual = coverage.mappedRecords + coverage.metadataOnlyRecords;
      source.missing = coverage.missingRecordIds.length;
      source.verified = source.actual;
      for (const id of coverage.missingRecordIds)
        issue({
          code: "source_record_missing",
          threadId: manifest.threadId,
          dimension: "source",
          id,
        });
      if (
        ![coverage.selectedRecords, coverage.mappedRecords, coverage.metadataOnlyRecords].every(
          (value) => Number.isInteger(value) && value >= 0,
        ) ||
        source.actual + source.missing !== source.expected
      )
        issue({
          code: "source_coverage_inconsistent",
          threadId: manifest.threadId,
          dimension: "source",
        });
    } else {
      source.skipped = 1;
      issue(
        {
          code: "source_coverage_unmeasured",
          threadId: manifest.threadId,
          dimension: "source",
          message:
            "The reader supplied no selected native-record accounting; this audit does not establish source archive completeness.",
        },
        false,
      );
    }
    const metadata = emptyDimension(manifest.metadataRecords ?? 0);
    thread.dimensions.metadata = metadata;
    if (manifest.metadataDigest === undefined) {
      incomplete = true;
      metadata.skipped = metadata.expected;
      issue(
        { code: "metadata_unverified", threadId: manifest.threadId, dimension: "metadata" },
        false,
      );
    } else {
      try {
        const matches = await withNativeImportMetadata(
          options.t3Home,
          manifest.threadId,
          ({ records }) => {
            metadata.actual = records.length;
            return (
              metadata.expected === records.length &&
              auditFingerprint(records) === manifest.metadataDigest
            );
          },
        );
        if (!matches) {
          metadata.changed = Math.max(metadata.expected, metadata.actual, 1);
          issue({ code: "metadata_changed", threadId: manifest.threadId, dimension: "metadata" });
        } else metadata.verified = metadata.actual;
      } catch {
        metadata.missing = metadata.expected;
        issue({ code: "metadata_unavailable", threadId: manifest.threadId, dimension: "metadata" });
      }
    }
    let projection: Record<string, unknown>;
    try {
      const response = record(
        await request(`/api/orchestration/threads/${encodeURIComponent(manifest.threadId)}`),
      );
      const value = record(response?.projection);
      if (!value) throw new Error("invalid projection");
      projection = value;
    } catch {
      issue({
        code: "projection_unavailable",
        threadId: manifest.threadId,
        dimension: "projection",
        message: "The local T3 server did not provide this thread projection.",
      });
      continue;
    }
    const presentation = emptyDimension();
    thread.dimensions.presentation = presentation;
    for (const value of Array.isArray(projection.subagents) ? projection.subagents : []) {
      const child = record(value);
      presentation.expected++;
      presentation.actual++;
      if (child?.runId == null) {
        presentation.skipped++;
        incomplete = true;
        issue(
          {
            code: "presentation_unplaced_subagent",
            threadId: manifest.threadId,
            dimension: "presentation",
            ...(typeof child?.id === "string" ? { id: child.id } : {}),
            message:
              "The child history is retained but has no verified launch position in this transcript.",
          },
          false,
        );
      } else presentation.verified++;
    }
    const projectedItems = (Array.isArray(projection.turnItems) ? projection.turnItems : [])
      .map(record)
      .filter((item): item is Record<string, unknown> => item !== undefined);
    for (const item of projectedItems) {
      if (item.type !== "system_notice" || typeof item.message !== "string") continue;
      const message = item.message.trim();
      presentation.expected++;
      presentation.actual++;
      if (
        /^<(?:command-name|command-message|local-command-(?:stdout|stderr|caveat))>/u.test(message)
      ) {
        presentation.changed++;
        issue({
          code: "presentation_local_command_markup",
          threadId: manifest.threadId,
          dimension: "presentation",
          id: String(item.id),
          message: "Raw local command markup is visible as transcript activity.",
        });
      } else if (/^<(?:system-notice|irc)>/u.test(message)) {
        presentation.changed++;
        issue({
          code: "presentation_omp_notice_markup",
          threadId: manifest.threadId,
          dimension: "presentation",
          id: String(item.id),
          message: "An OMP model-context wrapper is visible as transcript activity.",
        });
      } else if (
        item.level !== "info" &&
        (message === "No response requested." || message.startsWith("OMP model changed ("))
      ) {
        presentation.changed++;
        issue({
          code: "presentation_neutral_notice_warning",
          threadId: manifest.threadId,
          dimension: "presentation",
          id: String(item.id),
          message: "Routine transcript activity is displayed as a warning.",
        });
      } else presentation.verified++;
    }
    const itemsById = new Map(projectedItems.map((item) => [item.id, item]));
    for (const card of projectedItems.filter(
      (item) => item.type === "subagent" && typeof item.parentItemId === "string",
    )) {
      const launch = itemsById.get(card.parentItemId);
      presentation.expected++;
      presentation.actual++;
      if (
        !launch ||
        launch.runId !== card.runId ||
        Number(card.ordinal) <= Number(launch.ordinal)
      ) {
        presentation.changed++;
        issue({
          code: "presentation_invalid_launch_position",
          threadId: manifest.threadId,
          dimension: "presentation",
          id: String(card.id),
          message: "A child card has a missing, mismatched or later launch item.",
        });
      } else if (
        projectedItems.some(
          (item) =>
            item.runId === card.runId &&
            item.type === "assistant_message" &&
            item.phase === "final_answer" &&
            Number(item.ordinal) >= Number(launch.ordinal) &&
            Number(item.ordinal) < Number(card.ordinal),
        )
      ) {
        presentation.skipped++;
        incomplete = true;
        issue(
          {
            code: "presentation_late_subagent",
            threadId: manifest.threadId,
            dimension: "presentation",
            id: String(card.id),
            message: "The child card is placed after a final reply rather than at its launch.",
          },
          false,
        );
      } else presentation.verified++;
    }
    const isFoldableWork = (item: Record<string, unknown>) =>
      !["user_message", "compaction", "run_interrupt_request", "run_interrupt_result"].includes(
        String(item.type),
      ) && !(item.type === "assistant_message" && item.phase === "final_answer");
    for (const value of Array.isArray(projection.runs) ? projection.runs : []) {
      const run = record(value);
      if (
        run?.status === "completed" &&
        projectedItems.some((item) => item.runId === run.id && item.type === "run_interrupt_result")
      ) {
        presentation.expected++;
        presentation.actual++;
        presentation.changed++;
        issue({
          code: "presentation_interrupted_run_completed",
          threadId: manifest.threadId,
          dimension: "presentation",
          id: String(run.id),
          message:
            "A native interruption confirmation belongs to a response classified as completed.",
        });
      }
      if (run?.status !== "completed") continue;
      const items = projectedItems
        .filter((item) => item.runId === run.id)
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
      const steer = items.findIndex(
        (item) => item.type === "user_message" && item.inputIntent === "steer",
      );
      presentation.expected++;
      presentation.actual++;
      if (
        steer >= 0 &&
        !items.some((item) => item.type === "run_interrupt_result") &&
        !items.slice(0, steer).some(isFoldableWork) &&
        items.slice(steer + 1).some(isFoldableWork)
      ) {
        presentation.skipped++;
        incomplete = true;
        issue(
          {
            code: "presentation_empty_initial_work",
            threadId: manifest.threadId,
            dimension: "presentation",
            id: String(run.id),
            message:
              "This response starts with an empty fold segment; native T3 can show a Worked-for toggle with no expandable work.",
          },
          false,
        );
      } else presentation.verified++;
    }
    for (const [name, expectedRows] of Object.entries(manifest.collections)) {
      const dimension = emptyDimension(expectedRows.length);
      thread.dimensions[name] = dimension;
      let value =
        name === "thread" && record(projection.thread) ? [projection.thread] : projection[name];
      if (name === "providerThreads" && Array.isArray(value)) {
        // Native snapshots also include provider threads attached through subagents.
        // Their identities belong to the explicitly declared child manifests; unrelated extras fail.
        const children = new Set(manifest.children);
        value = value.filter((row) => {
          const appThreadId = record(row)?.appThreadId;
          return typeof appThreadId !== "string" || !children.has(appThreadId);
        });
      }
      if (!Array.isArray(value)) {
        dimension.missing = expectedRows.length;
        issue({ code: "collection_unavailable", threadId: manifest.threadId, dimension: name });
        continue;
      }
      dimension.actual = value.length;
      const actual = new Map<string, Record<string, unknown>>();
      for (const row of value) {
        const item = record(row);
        if (!item || typeof item.id !== "string") {
          issue({ code: "invalid_record", threadId: manifest.threadId, dimension: name });
          continue;
        }
        if (actual.has(item.id))
          issue({
            code: "duplicate_record",
            threadId: manifest.threadId,
            dimension: name,
            id: item.id,
          });
        actual.set(item.id, item);
      }
      for (const expected of expectedRows) {
        const row = actual.get(expected.id);
        if (!row) {
          dimension.missing++;
          issue({
            code: "record_missing",
            threadId: manifest.threadId,
            dimension: name,
            id: expected.id,
          });
        } else if (auditFingerprint(selectedFields(row, expected.fields)) !== expected.sha256) {
          dimension.changed++;
          issue({
            code: "record_changed",
            threadId: manifest.threadId,
            dimension: name,
            id: expected.id,
          });
        } else dimension.verified++;
        actual.delete(expected.id);
      }
      dimension.extra = actual.size;
      for (const id of actual.keys())
        issue({ code: "record_extra", threadId: manifest.threadId, dimension: name, id });
    }
    const assets = emptyDimension(manifest.assets.length);
    assets.actual = manifest.assets.length;
    thread.dimensions.assets = assets;
    const assetIssues = verifyNativeImportAssets(options.t3Home, manifest);
    for (const entry of assetIssues) {
      if (entry.code === "asset_missing") {
        assets.missing++;
        assets.actual--;
      } else assets.changed++;
      issue({ ...entry, threadId: manifest.threadId, dimension: "assets" });
    }
    assets.verified = assets.expected - assets.missing - assets.changed;
    const details = emptyDimension(manifest.details.length);
    thread.dimensions.details = details;
    if (options.structureOnly) {
      details.skipped = manifest.details.length;
      issue(
        {
          code: "details_unverified",
          threadId: manifest.threadId,
          dimension: "details",
          message:
            "Structure-only mode deliberately omits native on-demand item body verification.",
        },
        false,
      );
    } else for (const expected of manifest.details) detailJobs.push({ expected, thread });
  }
  if (detailJobs.length) {
    const response = record(await request("/api/auth/websocket-ticket", "POST"));
    if (typeof response?.ticket !== "string" || !response.ticket)
      throw new Error("The local T3 server did not issue an audit RPC ticket.");
    const url = new URL("/ws", origin.origin.replace(/^http/u, "ws"));
    url.searchParams.set("orchestrationProtocol", "2");
    url.searchParams.set("wsTicket", response.ticket);
    const completedDetails = new Set<string>();
    const detailKey = (threadId: string, itemId: string) => `${threadId}\0${itemId}`;
    // One scoped native client multiplexes the whole audit. No socket per item.
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(WsRpcGroup);
          yield* Effect.forEach(
            detailJobs,
            ({ expected, thread }) =>
              client[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
                threadId: ThreadId.make(thread.threadId),
                itemId: TurnItemId.make(expected.id),
              }).pipe(
                Effect.timeout("30 seconds"),
                Effect.tap((response) =>
                  Effect.sync(() => {
                    completedDetails.add(detailKey(thread.threadId, expected.id));
                    const dimension = thread.dimensions.details!;
                    const item = record(response.item);
                    if (!item) {
                      dimension.missing++;
                      issue({
                        code: "detail_missing",
                        threadId: thread.threadId,
                        dimension: "details",
                        id: expected.id,
                      });
                    } else {
                      dimension.actual++;
                      if (
                        auditFingerprint(selectedFields(item, expected.fields)) !== expected.sha256
                      ) {
                        dimension.changed++;
                        issue({
                          code: "detail_changed",
                          threadId: thread.threadId,
                          dimension: "details",
                          id: expected.id,
                        });
                      } else dimension.verified++;
                    }
                  }),
                ),
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    completedDetails.add(detailKey(thread.threadId, expected.id));
                    thread.dimensions.details!.skipped++;
                    issue({
                      code: "detail_unavailable",
                      threadId: thread.threadId,
                      dimension: "details",
                      id: expected.id,
                      message:
                        "Native RPC detail retrieval failed; its transport diagnostics are omitted to protect credentials.",
                    });
                  }),
                ),
              ),
            { concurrency: 4 },
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
              Layer.provide(
                Layer.mergeAll(Socket.layerWebSocket(url.href), RpcSerialization.layerJson),
              ),
              Layer.provide(Socket.layerWebSocketConstructorGlobal),
            ),
          ),
        ),
      );
    } catch {
      // A transport-layer startup failure may contain its ticket-bearing URL.
      // Report only IDs of unverified records, never the underlying exception.
      for (const { expected, thread } of detailJobs)
        if (!completedDetails.has(detailKey(thread.threadId, expected.id))) {
          thread.dimensions.details!.skipped++;
          issue({
            code: "detail_unavailable",
            threadId: thread.threadId,
            dimension: "details",
            id: expected.id,
            message: "The native RPC audit connection was unavailable.",
          });
        }
    }
  }
  report.status = failures
    ? "failed"
    : incomplete
      ? "partial"
      : limitations ||
          manifests.some((manifest) => manifest.warnings.length || manifest.escrowedFields)
        ? "verified-with-limitations"
        : "verified";
  return report;
}
