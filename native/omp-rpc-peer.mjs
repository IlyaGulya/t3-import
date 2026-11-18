#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log(process.env.OMP_PEER_VERSION || "omp/18.22.0");
  process.exit(0);
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  console.log(
    JSON.stringify({
      type: "response",
      id: request.id,
      command: request.type,
      success: true,
      data: { echoed: request.message },
    }),
  );
  console.log(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "session_settled must stay literal inside message text" }],
      },
    }),
  );
  console.log(JSON.stringify({ type: "agent_end", messages: [], isTerminal: false }));
  console.log(JSON.stringify({ type: "session_settled" }));
}
