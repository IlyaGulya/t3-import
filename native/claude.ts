import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createClaudeReplyReceiver, claudeTransportBudget } from "./claude-transport.js";
import type {
  NativeConversation,
  NativeReadOptions,
  NativeSourceReader,
  NativeSourceSummary,
} from "../src/native/types.js";

export function createClaudeReader(): NativeSourceReader {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const children = new Set<ReturnType<typeof spawn>>();
  const call = async (
    operation: "list" | "read",
    options: NativeReadOptions,
    id?: string,
  ): Promise<unknown> => {
    if (closed) throw new Error("Claude history reader is closed.");
    const sourceHome = resolve(
      options.sourceHome || process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`,
    );
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./claude-helper.js", import.meta.url))],
      {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: { ...process.env, CLAUDE_CONFIG_DIR: sourceHome },
      },
    );
    children.add(child);
    const result = new Promise<unknown>((accept, reject) => {
      const receiver = createClaudeReplyReceiver();
      let bytes = 0;
      let stderr = "";
      let failure: Error | undefined;
      let forced: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        child.kill("SIGTERM");
        forced ??= setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      };
      // Native family discovery and system-inclusive reads can exceed two minutes
      // for archives with thousands of children; retain a bounded total deadline.
      const timeout = setTimeout(() => {
        failure = new Error("Claude native history helper timed out.");
        terminate();
      }, 600_000);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > claudeTransportBudget) {
          failure = new Error(
            "Claude native history exceeds the helper transport budget; no partial import was performed.",
          );
          terminate();
        } else if (!failure) {
          try {
            receiver.push(chunk);
          } catch (error) {
            failure =
              error instanceof Error ? error : new Error("Invalid Claude history response.");
            terminate();
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-16 * 1024);
      });
      child.stdin.on("error", () => {});
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (forced) clearTimeout(forced);
        children.delete(child);
        if (closed) return reject(new Error("Claude history reader was closed."));
        if (failure) return reject(failure);
        if (code !== 0)
          return reject(new Error(`Claude native history helper exited ${code}: ${stderr}`));
        try {
          accept(receiver.finish());
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(JSON.stringify({ operation, options, sourceHome, id }));
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
      return (await call("list", options)) as NativeSourceSummary[];
    },
    async read(id, options) {
      return (await call("read", options, id)) as NativeConversation;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const child of children) {
        child.kill("SIGTERM");
        const forced = setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        child.once("close", () => clearTimeout(forced));
      }
      await Promise.allSettled(pending);
    },
  };
}
