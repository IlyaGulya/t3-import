import { spawn, execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  NativeConversation,
  NativeReadOptions,
  NativeSourceReader,
  NativeSourceSummary,
} from "../src/native/types.js";

const PACKAGE = "@oh-my-pi/pi-coding-agent";
const PACKAGE_VERSION = "18.22.0";
const exec = promisify(execFile);
const MAX_HELPER_BYTES = 512 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

interface OmpReaderDependencies {
  /** Bundled CLI keeps the helper beside its entry point; tests can pass its TS source to Bun. */
  helperPath?: string;
}

function expand(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/") || path.startsWith("~\\")
      ? join(homedir(), path.slice(2))
      : path;
}

async function packageAt(path: string): Promise<string | undefined> {
  let candidate = resolve(expand(path));
  if (basename(candidate) === "package.json") candidate = dirname(candidate);
  try {
    const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (manifest.name !== PACKAGE) return undefined;
    if (manifest.version !== PACKAGE_VERSION)
      throw new Error(
        `OMP package ${String(manifest.version)} is not validated. This importer supports ${PACKAGE}@${PACKAGE_VERSION}; provide that package with --omp-package.`,
      );
    await access(join(candidate, "src/session/session-loader.ts"));
    return await realpath(candidate);
  } catch (error) {
    if (error instanceof Error && /not validated/.test(error.message)) throw error;
    return undefined;
  }
}

async function packageAbove(path: string): Promise<string | undefined> {
  let current = dirname(await realpath(path));
  for (;;) {
    const found = await packageAt(current);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function executablePath(binary: string): Promise<string | undefined> {
  if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    try {
      await access(resolve(expand(binary)), constants.X_OK);
      return resolve(expand(binary));
    } catch {
      return undefined;
    }
  }
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(
    process.platform === "win32" ? ";" : ":",
  )) {
    for (const extension of extensions) {
      const candidate = join(directory, `${binary}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

/** Resolve the installed source package; the OMP CLI itself is never started. */
export async function resolveOmpPackage(options: NativeReadOptions): Promise<string> {
  if (options.ompPackage) {
    const found = await packageAt(options.ompPackage);
    if (!found)
      throw new Error(
        `--omp-package must name a ${PACKAGE}@${PACKAGE_VERSION} package directory containing its published source.`,
      );
    return found;
  }
  if (options.binary) {
    const binary = await executablePath(options.binary);
    const found = binary ? await packageAbove(binary) : undefined;
    if (!found)
      throw new Error(
        `Cannot locate OMP's source package behind '${options.binary}'. Provide --omp-package; a standalone executable alone cannot expose the native history library.`,
      );
    return found;
  }
  const binary = await executablePath("omp");
  if (binary) {
    const found = await packageAbove(binary);
    if (found) return found;
  }
  try {
    const found = await packageAbove(createRequire(import.meta.url).resolve(PACKAGE));
    if (found) return found;
  } catch {}
  const roots = [
    join(
      process.env.BUN_INSTALL || join(homedir(), ".bun"),
      "install/global/node_modules",
      PACKAGE,
    ),
    join(dirname(process.execPath), "../lib/node_modules", PACKAGE),
  ];
  try {
    const { stdout } = await exec("npm", ["root", "-g"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    roots.push(join(stdout.trim(), PACKAGE));
  } catch {}
  for (const root of roots) {
    const found = await packageAt(root);
    if (found) return found;
  }
  throw new Error(
    `OMP native history reading needs the published ${PACKAGE}@${PACKAGE_VERSION} source package. Install OMP normally or pass --omp-package.`,
  );
}

export function createOmpReader(dependencies: OmpReaderDependencies = {}): NativeSourceReader {
  let closed = false;
  const children = new Set<ReturnType<typeof spawn>>();
  const killTimers = new Map<ReturnType<typeof spawn>, ReturnType<typeof setTimeout>>();
  const stopChild = (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null || killTimers.has(child)) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
    force.unref();
    killTimers.set(child, force);
  };
  const pending = new Set<Promise<unknown>>();
  const paths = new Map<string, string>();
  let listedOptions: string | undefined;
  const helper =
    dependencies.helperPath ?? fileURLToPath(new URL("./omp-helper.js", import.meta.url));
  const key = (options: NativeReadOptions) =>
    JSON.stringify([
      options.sourceHome,
      options.ompPackage,
      options.binary,
      options.workspace,
      options.archived === true,
    ]);
  const call = async (
    operation: "list" | "read",
    options: NativeReadOptions,
    id?: string,
  ): Promise<unknown> => {
    if (closed) throw new Error("OMP history reader is closed.");
    const packageRoot = await resolveOmpPackage(options);
    if (closed) throw new Error("OMP history reader is closed.");
    const request = {
      operation,
      packageRoot,
      options,
      ...(id
        ? {
            id,
            ...(listedOptions === key(options) && paths.has(id) ? { path: paths.get(id) } : {}),
          }
        : {}),
    };
    const child = spawn(options.bunBinary ?? "bun", [helper], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: {
        ...process.env,
        ...(options.sourceHome
          ? {
              PI_CODING_AGENT_DIR: resolve(expand(options.sourceHome)),
              OMP_PROFILE: "",
              PI_PROFILE: "",
            }
          : {}),
      },
    });
    children.add(child);
    const result = new Promise<unknown>((accept, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      let failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error("OMP native history helper timed out.");
        stopChild(child);
      }, 120_000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_HELPER_BYTES) {
          failure = new Error(
            "OMP history exceeds the 512 MiB helper transport budget; no partial history was imported.",
          );
          stopChild(child);
        } else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
      });
      child.once("error", (error) => {
        failure = new Error(
          `Cannot start OMP's native history helper with '${options.bunBinary ?? "bun"}': ${error.message}`,
        );
      });
      child.stdin.on("error", () => {});
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimers.get(child));
        killTimers.delete(child);
        children.delete(child);
        if (closed) return reject(new Error("OMP history reader was closed."));
        if (failure) return reject(failure);
        if (code !== 0)
          return reject(
            new Error(
              `OMP native helper exited ${signal ? `with ${signal}` : `with code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
            ),
          );
        try {
          const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            ok?: unknown;
            value?: unknown;
            error?: unknown;
          };
          if (reply.ok !== true)
            return reject(
              new Error(
                typeof reply.error === "string"
                  ? reply.error
                  : "OMP helper returned an invalid response.",
              ),
            );
          accept(reply.value);
        } catch {
          reject(
            new Error("OMP native helper returned invalid JSON; no partial history was imported."),
          );
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
    pending.add(result);
    try {
      return await result;
    } finally {
      pending.delete(result);
    }
  };
  return {
    async list(options) {
      const result = await call("list", options);
      if (!Array.isArray(result))
        throw new Error("OMP native helper returned an invalid session list.");
      const summaries = result as NativeSourceSummary[];
      paths.clear();
      listedOptions = key(options);
      for (const summary of summaries)
        if (summary.path) {
          if (paths.has(summary.id) && paths.get(summary.id) !== summary.path)
            throw new Error(
              `Multiple OMP files claim session '${summary.id}'; select a session file explicitly.`,
            );
          paths.set(summary.id, summary.path);
        }
      return summaries;
    },
    async read(id, options) {
      const result = await call("read", options, id);
      if (
        !result ||
        typeof result !== "object" ||
        Reflect.get(result, "source") !== "omp" ||
        !Array.isArray(Reflect.get(result, "turns"))
      )
        throw new Error("OMP native helper returned an invalid conversation.");
      return result as NativeConversation;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const child of children) stopChild(child);
      await Promise.allSettled(pending);
    },
  };
}
