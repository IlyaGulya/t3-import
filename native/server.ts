import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import {
  WsRpcGroup,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

/** Integration harness for the real installed server, never the user's running instance. */
export interface IsolatedServerOptions {
  t3Home: string;
  binary?: string;
  timeoutMs?: number;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("Cannot allocate an isolated server port.");
  return port;
}

function cli(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(binary, args, { env, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // Credentials and server output must never appear in exception text.
      if (error)
        reject(new Error(`Isolated T3 CLI failed (${args[0]}, exit ${error.code ?? "unknown"}).`));
      else resolve(stdout.trim());
    }),
  );
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 10_000);
  timer.unref();
  try {
    await exit;
  } finally {
    clearTimeout(timer);
  }
}

export async function startIsolatedT3Server(options: IsolatedServerOptions) {
  const home = realpathSync(resolve(options.t3Home));
  const productionHome = join(homedir(), ".t3");
  if (
    home === resolve(productionHome) ||
    (existsSync(productionHome) && home === realpathSync(productionHome))
  )
    throw new Error("The server harness refuses the production T3 home.");
  if (!existsSync(join(home, "userdata", "statev2.sqlite")))
    throw new Error("Initialize and import the isolated target before launching its server.");
  const binary =
    options.binary ?? process.env.T3_TEST_SERVER_BINARY ?? join(homedir(), ".t3", "bin", "t3");
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("T3CODE_") && key !== "VITE_DEV_SERVER_URL",
    ),
  );
  Object.assign(env, { T3CODE_HOME: home, T3CODE_TELEMETRY_ENABLED: "false" });
  const child = spawn(
    binary,
    ["serve", "--base-dir", home, "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
    { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-65_536);
    });
  const runtime = join(home, "userdata", "server-runtime.json");
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 45_000);
    while (true) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Isolated T3 server failed to start (${spawnError?.message ?? child.exitCode ?? child.signalCode}).`,
        );
      if (existsSync(runtime)) {
        const state = JSON.parse(readFileSync(runtime, "utf8")) as {
          pid?: number;
          origin?: string;
        };
        if (state.pid === child.pid && state.origin === origin) {
          try {
            const response = await fetch(`${origin}/api/environment`, {
              signal: AbortSignal.timeout(1000),
            });
            if (response.status < 500) break;
          } catch {
            /* listener not ready */
          }
        }
      }
      if (Date.now() >= deadline)
        throw new Error("Isolated T3 server did not become ready before the timeout.");
      await delay(50);
    }
    const token = await cli(
      binary,
      [
        "auth",
        "session",
        "issue",
        "--base-dir",
        home,
        "--scope",
        "orchestration:read",
        "--scope",
        "filesystem:read",
        "--ttl",
        "1h",
        "--token-only",
      ],
      env,
    );
    if (!token || /\s/.test(token))
      throw new Error("Isolated T3 did not issue a valid access token.");
    return {
      home,
      origin,
      pid: child.pid!,
      /** Only the isolated test harness exposes its own read-only audit credential. */
      accessTokenForAudit: () => token,
      async request<T = unknown>(path: string): Promise<T> {
        const url = new URL(path, origin);
        if (url.origin !== origin)
          throw new Error("The isolated API client refuses another origin.");
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok)
          throw new Error(`T3 API ${path.split("?")[0]} returned ${response.status}.`);
        return (await response.json()) as T;
      },
      async pairingUrl(): Promise<string> {
        const result = await cli(
          binary,
          ["auth", "pairing", "create", "--base-dir", home, "--base-url", origin, "--json"],
          env,
        );
        const value = JSON.parse(result) as { pairUrl?: string };
        if (!value.pairUrl || new URL(value.pairUrl).origin !== origin)
          throw new Error("Unexpected isolated pairing URL.");
        return value.pairUrl;
      },
      async getTurnItem(threadId: string, itemId: string) {
        const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`T3 websocket ticket failed (${response.status}).`);
        const ticket = (await response.json()) as { ticket: string };
        const url = new URL("/ws", origin.replace(/^http/, "ws"));
        url.searchParams.set("orchestrationProtocol", "2");
        url.searchParams.set("wsTicket", ticket.ticket);
        return Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* RpcClient.make(WsRpcGroup);
            return yield* client[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
              threadId: ThreadId.make(threadId),
              itemId: TurnItemId.make(itemId),
            });
          }).pipe(
            Effect.timeout("30 seconds"),
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
      },
      async readProjectFile(cwd: string, relativePath: string) {
        const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`T3 websocket ticket failed (${response.status}).`);
        const ticket = (await response.json()) as { ticket: string };
        const url = new URL("/ws", origin.replace(/^http/, "ws"));
        url.searchParams.set("orchestrationProtocol", "2");
        url.searchParams.set("wsTicket", ticket.ticket);
        return Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* RpcClient.make(WsRpcGroup);
            return yield* client[WS_METHODS.projectsReadFile]({ cwd, relativePath });
          }).pipe(
            Effect.timeout("30 seconds"),
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
      },
      /** Captured diagnostics may include bootstrap credentials. Save privately if troubleshooting. */
      diagnostics: () => output,
      stop: () => stopChild(child),
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}
