import { serialize, deserialize } from "node:v8";
import type { NativeConversation } from "../src/native/types.js";

const frameBudget = 256 * 1024 * 1024;
export const claudeTransportBudget = 2 * 1024 * 1024 * 1024;

/** Private helper IPC, never a parser for source transcript files. */
async function send(frame: unknown): Promise<void> {
  const body = serialize(frame);
  if (body.length > frameBudget)
    throw new Error("Claude native history exceeds the per-thread transport budget.");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(header);
    process.stdout.write(body, (error) => (error ? reject(error) : resolve()));
  });
}

export async function sendClaudeValue(value: unknown, family: boolean): Promise<void> {
  let count = 0;
  if (family) {
    const pending = [{ conversation: value as NativeConversation, parent: null as number | null }];
    while (pending.length) {
      const { conversation, parent } = pending.pop()!;
      const { children, ...own } = conversation;
      const index = count++;
      await send({ type: "conversation", index, parent, value: own });
      for (let i = (children?.length ?? 0) - 1; i >= 0; i--)
        pending.push({ conversation: children![i]!, parent: index });
    }
  } else {
    await send({ type: "value", value });
    count++;
  }
  await send({ type: "complete", count });
}
export async function sendClaudeError(error: unknown): Promise<void> {
  await send({ type: "error", error: error instanceof Error ? error.message : String(error) });
}

export function createClaudeReplyReceiver() {
  const header = Buffer.alloc(4);
  let headerBytes = 0,
    bodyBytes = 0,
    expected = 0;
  let parts: Buffer[] = [];
  let count = 0,
    complete = false,
    standalone = false;
  let value: unknown;
  const conversations: NativeConversation[] = [];
  const frame = (body: Buffer) => {
    const entry = deserialize(body);
    if (!entry || typeof entry !== "object" || complete)
      throw new Error("Invalid Claude history transport frame.");
    if (entry.type === "error") throw new Error(String(entry.error));
    if (entry.type === "complete") {
      if (entry.count !== count || !count) throw new Error("Incomplete Claude history transport.");
      complete = true;
    } else if (entry.type === "value") {
      if (count) throw new Error("Repeated Claude history value.");
      standalone = true;
      value = entry.value;
      count++;
    } else if (entry.type === "conversation") {
      if (
        standalone ||
        entry.index !== count ||
        entry.value?.source !== "claude" ||
        typeof entry.value.id !== "string"
      )
        throw new Error("Invalid Claude history conversation frame.");
      if (count === 0) {
        if (entry.parent !== null) throw new Error("Invalid Claude history root.");
        value = entry.value;
      } else {
        if (!Number.isInteger(entry.parent) || entry.parent < 0 || entry.parent >= count)
          throw new Error("Invalid Claude history parent frame.");
        (conversations[entry.parent]!.children ??= []).push(entry.value);
      }
      conversations.push(entry.value);
      count++;
    } else throw new Error("Unknown Claude history transport frame.");
  };
  return {
    push(chunk: Buffer) {
      let offset = 0;
      while (offset < chunk.length) {
        if (headerBytes < 4) {
          const size = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + size);
          headerBytes += size;
          offset += size;
          if (headerBytes < 4) continue;
          expected = header.readUInt32BE();
          if (!expected || expected > frameBudget)
            throw new Error("Invalid Claude history frame size.");
        }
        const size = Math.min(expected - bodyBytes, chunk.length - offset);
        if (size) parts.push(chunk.subarray(offset, offset + size));
        offset += size;
        bodyBytes += size;
        if (bodyBytes === expected) {
          frame(parts.length === 1 ? parts[0]! : Buffer.concat(parts, expected));
          headerBytes = bodyBytes = expected = 0;
          parts = [];
        }
      }
    },
    finish(): unknown {
      if (!complete || headerBytes || bodyBytes)
        throw new Error(
          "Incomplete Claude native history response; no partial import was performed.",
        );
      return value;
    },
  };
}
