import { Command, Option } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createCodexReader } from "./codex.js";
import { createOmpReader } from "./omp.js";
import { auditNativeImport } from "./audit.js";
import { createClaudeReader } from "./claude.js";
import { writeNativeJson } from "./json-output.js";
import { HistorySpool } from "./history-spool.js";
import {
  readRetryFile,
  saveRetryFile,
  type RetryManifest,
  type RetrySource,
} from "./retry-file.js";
import {
  countNativePlacement,
  importNativeConversations,
  inspectNativeTarget,
  withNativeImportMetadata,
  listNativeProjects,
  NativeImportPlanError,
  withNativeImportRun,
} from "./target.js";
import type {
  NativeConversationView,
  NativeImportResult,
  NativeReadOptions,
  NativeSource,
  NativeSourceReader,
  NativeSourceSummary,
  NativeWriteOptions,
  NativeWriteResult,
} from "../src/native/types.js";

function collect(value: string, values: string[]): string[] {
  return [...values, value];
}
class CliUsageError extends Error {
  readonly exitCode = 2;
}
function absolutePath(value: string): string {
  return resolve(
    value === "~" ? homedir() : /^~[/\\]/u.test(value) ? `${homedir()}/${value.slice(2)}` : value,
  );
}

function readOptions(values: Record<string, unknown>): NativeReadOptions {
  return {
    ...(typeof values.workspace === "string" ? { workspace: absolutePath(values.workspace) } : {}),
    ...(typeof values.since === "string" ? { since: new Date(values.since).toISOString() } : {}),
    ...(values.archived === true ? { archived: true } : {}),
    ...(typeof values.sourceHome === "string"
      ? { sourceHome: absolutePath(values.sourceHome) }
      : {}),
    ...(typeof values.binary === "string" ? { binary: values.binary } : {}),
    ...(typeof values.ompPackage === "string"
      ? { ompPackage: absolutePath(values.ompPackage) }
      : {}),
    ...(typeof values.bunBinary === "string" ? { bunBinary: values.bunBinary } : {}),
    ...(values.snapshot === true ? { snapshot: true } : {}),
  };
}

function sourceReader(source: NativeSource): NativeSourceReader {
  if (source === "codex") return createCodexReader();
  if (source === "omp") return createOmpReader();
  if (source === "claude") return createClaudeReader();
  throw new Error(`Native source '${source}' is not available in this build.`);
}

function targetHome(values: Record<string, unknown>): string {
  return absolutePath(
    typeof values.t3Home === "string"
      ? values.t3Home
      : (process.env.T3CODE_HOME ?? `${homedir()}/.t3`),
  );
}

function print(value: unknown, json: boolean): void {
  console.log(JSON.stringify(value, null, json ? undefined : 2));
}

function sourceOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--source <source>", "native history owner")
        .choices(["codex", "omp", "claude"])
        .default("codex"),
    )
    .option("--workspace <path>", "only sessions belonging to this workspace")
    .option("--since <date>", "only sessions updated since an ISO timestamp", (value: string) => {
      if (Number.isNaN(Date.parse(value)))
        throw new CliUsageError(`Invalid --since timestamp: ${value}`);
      return value;
    })
    .option("--archived", "select archived Codex or cold-archive OMP sessions")
    .option("--source-home <path>", "Codex home, OMP agent directory or Claude config directory")
    .option("--binary <command>", "Codex executable or OMP package locator (Claude uses its SDK)")
    .option("--omp-package <path>", "installed OMP source package directory")
    .option("--bun-binary <command>", "Bun executable for OMP's native libraries (default: bun)")
    .option("--json", "one JSON result on stdout");
}

function placementOptions(command: Command): Command {
  return command
    .option("--settled", "put non-archived import roots on T3's Settled shelf")
    .option(
      "--old-family-days <days>",
      "days without family activity before placement (default: 30)",
      (value: string) => {
        const days = Number(value);
        if (!/^\d+$/u.test(value) || !Number.isSafeInteger(days) || days < 1)
          throw new CliUsageError("--old-family-days must be a positive integer.");
        return days;
      },
    )
    .addOption(
      new Option(
        "--old-family-action <action>",
        "placement for inactive families (default: settle)",
      ).choices(["keep", "settle", "archive"]),
    )
    .option("--no-archive-empty-children", "keep confirmed empty subagents on the Settled shelf");
}

function readPlacementOptions(
  values: Record<string, unknown>,
): Pick<
  NativeWriteOptions,
  "settled" | "oldFamilyDays" | "oldFamilyAction" | "archiveEmptyChildren"
> {
  return {
    settled: values.settled === true,
    ...(typeof values.oldFamilyDays === "number" ? { oldFamilyDays: values.oldFamilyDays } : {}),
    ...(values.oldFamilyAction === "keep" ||
    values.oldFamilyAction === "settle" ||
    values.oldFamilyAction === "archive"
      ? { oldFamilyAction: values.oldFamilyAction }
      : {}),
    archiveEmptyChildren: values.archiveEmptyChildren !== false,
  };
}

function summaryDetails(summary: NativeSourceSummary) {
  return { ...summary };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readHistory(
  reader: NativeSourceReader,
  id: string,
  options: NativeReadOptions,
): Promise<NativeHistorySnapshot> {
  if (!reader.readSnapshot) return { conversation: await reader.read(id, options), close() {} };
  const spool = new HistorySpool();
  try {
    const conversation = await reader.readSnapshot(id, options, (value) => spool.json(value));
    return { conversation, close: () => spool.close() };
  } catch (error) {
    spool.close();
    throw error;
  }
}

interface NativeHistorySnapshot {
  conversation: NativeConversationView;
  close(): void;
}

interface BulkImportReport {
  results: NativeWriteResult[];
  failures: Array<{ source: NativeSource; sourceId?: string; error: string }>;
}

function familyRoot(id: string, parents: ReadonlyMap<string, string>): string {
  const seen = new Set<string>();
  let current = id;
  let parent = parents.get(current);
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(current);
    current = parent;
    parent = parents.get(current);
  }
  return current;
}

async function importSourceFamilies(
  source: NativeSource,
  options: NativeReadOptions,
  importBatch: (conversations: NativeConversationView[]) => Promise<NativeImportResult>,
  report: BulkImportReport,
  sessionIds?: readonly string[],
) {
  const history = sourceReader(source);
  try {
    let sessions: NativeSourceSummary[];
    try {
      sessions = await history.list(options);
      if (source !== "claude")
        sessions = sessions.concat(await history.list({ ...options, archived: true }));
      if (new Set(sessions.map((session) => session.id)).size !== sessions.length)
        throw new Error(
          "Native listing contains duplicate session IDs across live history and archives; retry when the source is stable.",
        );
    } catch (error) {
      report.failures.push({ source, error: errorMessage(error) });
      return;
    }

    const covered = new Set<string>();
    const children = new Map<string, string>();
    const inventory = new Map(sessions.map((session) => [session.id, session]));
    for (const session of sessions) {
      if (session.parentSessionId) children.set(session.id, session.parentSessionId);
    }
    const selectedRoots =
      sessionIds === undefined
        ? undefined
        : new Set(sessionIds.map((id) => familyRoot(id, children)));
    const queue = selectedRoots
      ? sessions.filter((session) => selectedRoots.has(session.id))
      : sessions;
    const failed = new Set<string>();
    const reportFailure = (sourceId: string, error: unknown) => {
      if (failed.has(sourceId)) return;
      failed.add(sourceId);
      report.failures.push({ source, sourceId, error: errorMessage(error) });
    };
    for (const session of queue) {
      if (children.has(session.id) || covered.has(session.id)) continue;
      let snapshot: NativeHistorySnapshot | undefined;
      try {
        snapshot = await readHistory(
          history,
          source === "omp" ? (session.path ?? session.id) : session.id,
          {
            ...options,
            ...(session.archived ? { archived: true } : {}),
          },
        );
        if (
          snapshot.conversation.id !== session.id ||
          Boolean(snapshot.conversation.archived) !== Boolean(session.archived)
        )
          throw new Error(
            "Session identity or archive state changed after listing; retry when the source is stable.",
          );
      } catch (error) {
        snapshot?.close();
        reportFailure(session.id, error);
        continue;
      }
      const { conversation } = snapshot;
      try {
        const parent = conversation.parent?.sourceId;
        if (parent) {
          children.set(session.id, parent);
          if (selectedRoots) {
            const root = familyRoot(parent, children);
            const next = inventory.get(root);
            if (next && !selectedRoots.has(root)) queue.push(next);
            selectedRoots.add(root);
          }
          continue;
        }
        const batch = await importBatch([conversation]);
        report.results.push(...batch.results);
        for (const entry of batch.results) {
          covered.add(entry.sourceId);
          for (const childId of entry.retainedChildMetadata ?? []) covered.add(childId);
        }
      } catch (error) {
        if (!(error instanceof NativeImportPlanError)) throw error;
        reportFailure(session.id, error);
      } finally {
        snapshot.close();
      }
    }
    for (const [sourceId, parent] of children) {
      if (
        !covered.has(sourceId) &&
        (!selectedRoots || selectedRoots.has(familyRoot(sourceId, children)))
      )
        reportFailure(
          sourceId,
          `Native parent '${parent}' did not supply this child in an importable family.`,
        );
    }
    for (const sourceId of sessionIds ?? [])
      if (!covered.has(sourceId))
        reportFailure(sourceId, "The selected session was not found in native history.");
  } finally {
    await history.close();
  }
}

function bulkSourceOptions(
  source: NativeSource,
  values: Record<string, unknown>,
): RetrySource["options"] {
  const options = readOptions({ ...values, snapshot: source !== "codex" && values.snapshot });
  // Paths to custom reader executables must keep working from another directory.
  for (const key of ["binary", "bunBinary"] as const) {
    const command = options[key];
    if (command && /[/\\]/u.test(command)) options[key] = absolutePath(command);
  }
  if (source === "codex" && values.codexIndexOnly) options.codexIndexOnly = true;
  return options;
}

export async function runNativeCli(args: string[]): Promise<void> {
  const program = new Command("t3-import")
    .description(
      "Import rich native history using the source tool and pinned T3 code. Writes require a stopped T3.",
    )
    .version(__IMPORTER_VERSION__)
    .exitOverride();
  let reader: NativeSourceReader | undefined;
  const snapshots: NativeHistorySnapshot[] = [];
  let json = args.includes("--json");

  sourceOptions(
    program.command("list").description("List sessions through the source tool's native reader"),
  ).action(async (values: Record<string, unknown>) => {
    json = Boolean(values.json);
    reader = sourceReader(values.source as NativeSource);
    const sessions = await reader.list(readOptions(values));
    print(
      { schemaVersion: 1, source: values.source, sessions: sessions.map(summaryDetails) },
      json,
    );
  });

  sourceOptions(
    program.command("show").description("Read a native session and inspect its importable history"),
  )
    .requiredOption("--thread <id>", "native source session ID")
    .option("--full", "include the normalized conversation content")
    .action(async (values: Record<string, unknown>) => {
      json = Boolean(values.json);
      reader = sourceReader(values.source as NativeSource);
      const snapshot = await readHistory(reader, values.thread as string, readOptions(values));
      snapshots.push(snapshot);
      const { conversation } = snapshot;
      if (values.full) await writeNativeJson(conversation, !json);
      else {
        const itemKinds: Record<string, number> = {};
        let items = 0;
        for (const turn of conversation.turns)
          for (const item of turn.items) {
            items++;
            itemKinds[item.kind] = (itemKinds[item.kind] ?? 0) + 1;
          }
        print(
          {
            schemaVersion: 1,
            source: conversation.source,
            id: conversation.id,
            title: conversation.title,
            workspace: conversation.workspace,
            active: conversation.active,
            ...(conversation.archived === undefined ? {} : { archived: conversation.archived }),
            turns: conversation.turns.length,
            ...(conversation.historyMetadataOnly
              ? { historyMetadataOnly: conversation.historyMetadataOnly }
              : {}),
            ...(conversation.retainedChildMetadata
              ? { retainedChildMetadata: conversation.retainedChildMetadata }
              : {}),
            items,
            itemKinds,
            ...(conversation.sourceCoverage ? { sourceCoverage: conversation.sourceCoverage } : {}),
            warnings: conversation.warnings,
          },
          json,
        );
      }
    });

  program
    .command("doctor")
    .description("Inspect current T3 storage without changing it")
    .option("--t3-home <path>", "T3 home (default: T3CODE_HOME or ~/.t3)")
    .option("--json", "one JSON result on stdout")
    .action(async (values: Record<string, unknown>) => {
      json = Boolean(values.json);
      print({ schemaVersion: 1, ...(await inspectNativeTarget(targetHome(values))) }, json);
    });

  program
    .command("audit")
    .description("Verify retained import evidence against a running real T3 server")
    .requiredOption("--thread <id>", "destination T3 thread ID")
    .requiredOption("--server <origin>", "loopback T3 server origin")
    .option("--t3-home <path>", "matching T3 home")
    .option(
      "--token-env <name>",
      "environment variable containing a read-only T3 access token",
      "T3_IMPORT_AUDIT_TOKEN",
    )
    .option("--structure-only", "skip on-demand bodies and report partial verification")
    .option("--no-family", "check only this thread, excluding child histories")
    .option("--json", "one JSON report on stdout")
    .action(async (values: Record<string, unknown>) => {
      json = Boolean(values.json);
      const report = await auditNativeImport({
        t3Home: targetHome(values),
        threadId: values.thread as string,
        server: values.server as string,
        token: process.env[values.tokenEnv as string] ?? "",
        structureOnly: Boolean(values.structureOnly),
        family: values.family !== false,
      });
      print(report, json);
      if (report.status === "failed" || report.status === "partial") process.exitCode = 4;
    });

  program
    .command("metadata")
    .description("Inspect retained native metadata for an imported T3 thread")
    .requiredOption("--thread <id>", "destination T3 thread ID")
    .option("--t3-home <path>", "T3 home (default: T3CODE_HOME or ~/.t3)")
    .option("--json", "one JSON result on stdout")
    .action(async (values: Record<string, unknown>) => {
      json = Boolean(values.json);
      await withNativeImportMetadata(targetHome(values), values.thread as string, (metadata) =>
        writeNativeJson({ schemaVersion: 1, ...metadata }, !json),
      );
    });

  program
    .command("projects")
    .description("List existing destination projects without changing them")
    .option("--t3-home <path>", "T3 home (default: T3CODE_HOME or ~/.t3)")
    .option("--json", "one JSON result on stdout")
    .action(async (values: Record<string, unknown>) => {
      json = Boolean(values.json);
      const projects = await listNativeProjects(targetHome(values));
      print(
        {
          schemaVersion: 1,
          projects: projects.map((project) => ({
            projectId: project.projectId,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            archivedAt: project.archivedAt,
          })),
        },
        json,
      );
    });

  placementOptions(
    sourceOptions(
      program.command("import").description("Import rich native history into current T3"),
    ),
  )
    .option("--thread <id>", "native source session ID (repeatable)", collect, [])
    .option("--all", "import all source sessions matching --workspace")
    .option("--t3-home <path>", "T3 home (default: T3CODE_HOME or ~/.t3)")
    .option("--provider-instance <id>", "enabled matching T3 provider instance")
    .addOption(
      new Option(
        "--project-root <path>",
        "reuse/create a destination project at this root; keep each session's cwd",
      ).conflicts("projectId"),
    )
    .addOption(
      new Option(
        "--project-id <id>",
        "use an existing destination project; see projects command",
      ).conflicts("projectRoot"),
    )
    .option("--no-resume", "import history without binding a native session for continuation")
    .option(
      "--restore-workspace",
      "restore recorded text files into an isolated workspace; requires --no-resume",
    )
    .option(
      "--snapshot",
      "preserve unfinished Claude or OMP history as interrupted; requires --no-resume",
    )
    .option("--dry-run", "validate and plan without writing target data")
    .option("--yes", "write the reviewed import plan")
    .action(async (values: Record<string, unknown>) => {
      json = Boolean(values.json);
      const ids = values.thread as string[];
      if (values.restoreWorkspace && values.resume !== false)
        throw new CliUsageError("--restore-workspace requires --no-resume.");
      if (values.snapshot && values.source !== "claude" && values.source !== "omp")
        throw new CliUsageError("--snapshot is supported only for Claude and OMP history.");
      if (values.snapshot && values.resume !== false)
        throw new CliUsageError(
          "--snapshot requires --no-resume; an incomplete snapshot cannot bind a continuation.",
        );
      if (!values.workspace) throw new CliUsageError("Import requires --workspace.");
      if (Boolean(values.all) === ids.length > 0)
        throw new CliUsageError("Choose either --thread (repeatable) or --all.");
      if (!values.dryRun && !values.yes)
        throw new CliUsageError("Use --dry-run to review the import, or --yes to write it.");
      const options = readOptions(values);
      reader = sourceReader(values.source as NativeSource);
      const selected = values.all
        ? (await reader.list(options)).map((session) => session.id)
        : [...new Set(ids)];
      if (selected.length === 0) throw new Error("No matching source sessions found.");
      const conversations: NativeConversationView[] = [];
      for (const id of selected) {
        const snapshot = await readHistory(reader, id, options);
        snapshots.push(snapshot);
        conversations.push(snapshot.conversation);
      }
      // A selected family root already supplies its descendants. Remove only
      // redundant top-level selections; nested duplicate/ambiguous lineage stays
      // intact for the writer's validation.
      const nested = new Set<string>();
      const visited = new Set<NativeConversationView>();
      const pending = conversations.flatMap((conversation) => conversation.children ?? []);
      while (pending.length) {
        const child = pending.pop()!;
        if (visited.has(child)) continue;
        visited.add(child);
        nested.add(`${child.source}:${child.id}`);
        pending.push(...(child.children ?? []));
      }
      const roots = conversations.filter(
        (conversation) => !nested.has(`${conversation.source}:${conversation.id}`),
      );
      const result = await importNativeConversations(roots.length ? roots : conversations, {
        t3Home: targetHome(values),
        dryRun: Boolean(values.dryRun),
        resume: values.resume !== false,
        ...readPlacementOptions(values),
        ...(values.restoreWorkspace === true ? { restoreWorkspace: true } : {}),
        ...(typeof values.providerInstance === "string"
          ? { providerInstance: values.providerInstance }
          : {}),
        ...(typeof values.projectRoot === "string"
          ? { projectRoot: absolutePath(values.projectRoot) }
          : {}),
        ...(typeof values.projectId === "string" ? { projectId: values.projectId } : {}),
      });
      print(result, json);
    });

  placementOptions(
    program
      .command("import-all")
      .description("Import local history across all workspaces with one offline backup"),
  )
    .addOption(
      new Option("--source <source...>", "limit the import to these native history owners").choices(
        ["codex", "claude", "omp"],
      ),
    )
    .option("--source-home <path>", "source directory when importing from a single source")
    .option("--binary <command>", "executable or package locator for a single source")
    .option("--omp-package <path>", "installed OMP source package directory")
    .option("--bun-binary <command>", "Bun executable for OMP's native libraries (default: bun)")
    .option("--t3-home <path>", "T3 home (default: T3CODE_HOME or ~/.t3)")
    .option("--snapshot", "preserve unfinished Claude or OMP history as interrupted")
    .option("--codex-index-only", "read Codex inventory from its existing native state index")
    .option("--retry-file <path>", "save the remaining work in a new JSON file")
    .addOption(
      new Option("--retry-from <path>", "retry only the remaining work in a saved file").conflicts([
        "source",
        "sourceHome",
        "binary",
        "ompPackage",
        "bunBinary",
        "t3Home",
        "snapshot",
        "codexIndexOnly",
        "settled",
        "oldFamilyDays",
        "oldFamilyAction",
        "archiveEmptyChildren",
      ]),
    )
    .option("--dry-run", "validate and plan without writing target data")
    .addOption(new Option("--yes", "write history to the stopped T3 target").conflicts("dryRun"))
    .option("--json", "one JSON result on stdout")
    .action(async (values: Record<string, unknown>) => {
      json = Boolean(values.json);
      const sources = [
        ...new Set<NativeSource>(
          (values.source as NativeSource[] | undefined) ?? ["codex", "claude", "omp"],
        ),
      ];
      if (sources.length !== 1 && (values.sourceHome || values.binary))
        throw new CliUsageError("Use --source-home or --binary with exactly one source.");
      if (values.codexIndexOnly && !sources.includes("codex"))
        throw new CliUsageError("--codex-index-only requires Codex in the source selection.");
      if (!values.dryRun && !values.yes)
        throw new CliUsageError("Use --dry-run to review the import, or --yes to write it.");
      const dryRun = Boolean(values.dryRun);
      const retryPath =
        typeof values.retryFile === "string" ? absolutePath(values.retryFile) : undefined;
      if (retryPath && existsSync(retryPath))
        throw new CliUsageError(`Retry file '${retryPath}' already exists. Choose a new path.`);
      const retry =
        typeof values.retryFrom === "string"
          ? await readRetryFile(absolutePath(values.retryFrom)).catch((error) => {
              throw new CliUsageError(`Cannot read retry file: ${errorMessage(error)}`);
            })
          : undefined;
      const t3Home = retry?.t3Home ?? targetHome(values);
      const placement = retry?.placement ?? readPlacementOptions(values);
      const jobs =
        retry?.sources ??
        sources.map((source): RetrySource => ({
          source,
          options: bulkSourceOptions(source, values),
        }));
      const result = await withNativeImportRun(
        { t3Home, dryRun, resume: false, ...placement },
        async (target) => {
          const report: BulkImportReport = { results: [], failures: [] };
          const remaining = new Map(jobs.map((job) => [job.source, job]));
          let fatal: { error: string } | undefined;
          try {
            for (const job of jobs) {
              const { source, options, sessionIds } = job;
              if (!json) console.error(`Checking ${source} history…`);
              const failureStart = report.failures.length;
              await importSourceFamilies(source, options, target.importBatch, report, sessionIds);
              const failures = report.failures.slice(failureStart);
              if (!failures.length) remaining.delete(source);
              else if (failures.every((entry) => entry.sourceId !== undefined))
                remaining.set(source, {
                  ...job,
                  sessionIds: failures.map((entry) => entry.sourceId!),
                });
            }
          } catch (error) {
            fatal = { error: errorMessage(error) };
          }
          let retryFile: string | null = null;
          let unsavedRetry: { retryFileError: string; retryManifest: RetryManifest } | undefined;
          if (retryPath || (!dryRun && remaining.size > 0)) {
            const retryManifest: RetryManifest = {
              schemaVersion: 1,
              kind: "t3-import-retry",
              t3Home,
              placement,
              sources: [...remaining.values()],
            };
            try {
              retryFile = await saveRetryFile(retryManifest, target.path, retryPath);
            } catch (error) {
              unsavedRetry = { retryFileError: errorMessage(error), retryManifest };
            }
          }
          return {
            schemaVersion: 1,
            status:
              fatal || unsavedRetry
                ? "error"
                : report.failures.length
                  ? "partial"
                  : dryRun
                    ? "dry-run"
                    : "complete",
            dryRun,
            target: target.path,
            migration: target.migration,
            backup: target.backup,
            retryFile,
            placementCounts: countNativePlacement(report.results),
            ...(jobs.some(({ options }) => options.codexIndexOnly)
              ? { codexInventory: "native-state-index" }
              : {}),
            ...report,
            ...fatal,
            ...unsavedRetry,
          };
        },
      );
      print(result, json);
      if (result.status === "partial" || result.status === "error") process.exitCode = 6;
    });

  try {
    if (args.length === 0) {
      program.outputHelp();
      return;
    }
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "commander.helpDisplayed" || code === "commander.version") return;
    const message = errorMessage(error);
    if (json) print({ schemaVersion: 1, status: "error", error: message }, true);
    else console.error(message);
    const explicit =
      error && typeof error === "object" && "exitCode" in error
        ? Number(error.exitCode)
        : undefined;
    process.exitCode = code.startsWith("commander.")
      ? 2
      : explicit && Number.isInteger(explicit)
        ? explicit
        : 6;
  } finally {
    for (const snapshot of snapshots) snapshot.close();
    await reader?.close();
  }
}
