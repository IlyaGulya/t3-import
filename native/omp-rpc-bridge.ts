#!/usr/bin/env node
/** OMP 18.22 emits session_settled; the pinned T3 Pi adapter calls it agent_settled. */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const binary = process.env.T3_IMPORT_OMP_BINARY || "omp";
const args = process.argv.slice(2);
try {
  if (binary === "t3-import-omp" || (existsSync(binary) && realpathSync(binary) === realpathSync(fileURLToPath(import.meta.url)))) throw new Error("OMP bridge must launch the native omp binary, not itself.");
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  if (version.status !== 0 || !/^(?:omp(?: v|\/))?18\.22\.0\s*$/.test(version.stdout.trim())) throw new Error("OMP RPC bridge requires the validated native omp version 18.22.0.");
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"], shell: false });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin);
  const rpc = args.some((arg, i) => arg === "--mode=rpc" || arg === "--mode=rpc-ui" || arg === "--mode" && ["rpc", "rpc-ui"].includes(args[i + 1] || ""));
  if (rpc) {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      let output = line;
      try {
        const frame: unknown = JSON.parse(line);
        if (frame && typeof frame === "object" && "type" in frame && frame.type === "session_settled") output = JSON.stringify({ ...frame, type: "agent_settled" });
      } catch { /* Keep native diagnostics and all unrelated frames unchanged. */ }
      if (!process.stdout.write(output + "\n")) await once(process.stdout, "drain");
    }
  } else child.stdout.pipe(process.stdout);
  const result = await closed;
  process.stdin.unpipe(child.stdin);
  process.stdin.destroy();
  process.exitCode = result.code ?? (result.signal === "SIGINT" ? 130 : 143);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
