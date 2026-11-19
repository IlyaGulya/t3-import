import { Command, Option } from "commander";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createCodexReader } from "./codex.js";
import { createOmpReader } from "./omp.js";
import { auditNativeImport } from "./audit.js";
import { createClaudeReader } from "./claude.js";
import { writeNativeJson } from "./json-output.js";
import {
  importNativeConversations,
  inspectNativeTarget,
  readNativeImportMetadata,
  listNativeProjects,
  NativeImportPlanError,
  withNativeImportRun,
} from "./target.js";
import type {
  NativeConversation,
  NativeImportResult,
  NativeReadOptions,
  NativeSource,
  NativeSourceReader,
  NativeSourceSummary,
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

function summaryDetails(summary: NativeSourceSummary) {
  return { ...summary };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BulkImportReport {
  results: NativeWriteResult[];
  failures: Array<{ source: NativeSource; sourceId?: string; error: string }>;
}

async function importSourceFamilies(
  source: NativeSource,
  options: NativeReadOptions,
  importBatch: (conversations: NativeConversation[]) => Promise<NativeImportResult>,
  report: BulkImportReport,
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
    for (const session of sessions) {
      if (session.parentSessionId) children.set(session.id, session.parentSessionId);
    }
    for (const session of sessions) {
      if (children.has(session.id) || covered.has(session.id)) continue;
      let conversation: NativeConversation;
      try {
        conversation = await history.read(
          source === "omp" ? (session.path ?? session.id) : session.id,
          {
            ...options,
            ...(session.archived ? { archived: true } : {}),
          },
        );
        if (
          conversation.id !== session.id ||
          Boolean(conversation.archived) !== Boolean(session.archived)
        )
          throw new Error(
            "Session identity or archive state changed after listing; retry when the source is stable.",
          );
      } catch (error) {
        report.failures.push({ source, sourceId: session.id, error: errorMessage(error) });
        continue;
      }
      const parent = conversation.parent?.sourceId;
      if (parent) {
        children.set(session.id, parent);
        continue;
      }
      try {
        const batch = await importBatch([conversation]);
        report.results.push(...batch.results);
        for (const entry of batch.results) covered.add(entry.sourceId);
      } catch (error) {
        if (!(error instanceof NativeImportPlanError)) throw error;
        report.failures.push({ source, sourceId: session.id, error: error.message });
      }
    }
    for (const [sourceId, parent] of children) {
      if (!covered.has(sourceId))
        report.failures.push({
          source,
          sourceId,
          error: `Native parent '${parent}' did not supply this child in an importable family.`,
        });
    }
  } finally {
    await history.close();
  }
}

export async function runNativeCli(args: string[]): Promise<void> {
  const program = new Command("t3-import")
    .description(
      "Import rich native history using the source tool and pinned T3 code. Writes require a stopped T3.",
    )
    .version(__IMPORTER_VERSION__)
    .exitOverride();
  let reader: NativeSourceReader | undefined;
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
      const conversation = await reader.read(values.thread as string, readOptions(values));
      if (values.full) await writeNativeJson(conversation, !json);
      else
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
            items: conversation.turns.reduce((count, turn) => count + turn.items.length, 0),
            itemKinds: Object.fromEntries(
              [
                ...new Set(
                  conversation.turns.flatMap((turn) => turn.items.map((item) => item.kind)),
                ),
              ].map((kind) => [
                kind,
                conversation.turns.reduce(
                  (count, turn) => count + turn.items.filter((item) => item.kind === kind).length,
                  0,
                ),
              ]),
            ),
            ...(conversation.sourceCoverage ? { sourceCoverage: conversation.sourceCoverage } : {}),
            warnings: conversation.warnings,
          },
          json,
        );
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
    .action((values: Record<string, unknown>) => {
      json = Boolean(values.json);
      print(
        {
          schemaVersion: 1,
          ...readNativeImportMetadata(targetHome(values), values.thread as string),
        },
        json,
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

  sourceOptions(program.command("import").description("Import rich native history into current T3"))
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
    .option("--settled", "put non-archived imports on T3's Settled shelf")
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
      const conversations: NativeConversation[] = [];
      for (const id of selected) conversations.push(await reader.read(id, options));
      await reader.close();
      reader = undefined;
      // A selected family root already supplies its descendants. Remove only
      // redundant top-level selections; nested duplicate/ambiguous lineage stays
      // intact for the writer's validation.
      const nested = new Set<string>();
      const visited = new Set<NativeConversation>();
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
        settled: values.settled === true,
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

  program
    .command("import-all")
    .description("Import local history across all workspaces with one offline backup")
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
    .option("--settled", "put non-archived imports on T3's Settled shelf")
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
      if (!values.dryRun && !values.yes)
        throw new CliUsageError("Use --dry-run to review the import, or --yes to write it.");
      const t3Home = targetHome(values);
      const dryRun = Boolean(values.dryRun);
      const result = await withNativeImportRun(
        { t3Home, dryRun, resume: false, settled: values.settled === true },
        async (target) => {
          const report: BulkImportReport = { results: [], failures: [] };
          let fatal: { error: string } | undefined;
          try {
            for (const source of sources) {
              if (!json) console.error(`Checking ${source} history…`);
              const options = readOptions({
                ...values,
                snapshot: source !== "codex" && values.snapshot,
              });
              await importSourceFamilies(source, options, target.importBatch, report);
            }
          } catch (error) {
            fatal = { error: errorMessage(error) };
          }
          return {
            schemaVersion: 1,
            status: fatal
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
            ...report,
            ...fatal,
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
    await reader?.close();
  }
}
