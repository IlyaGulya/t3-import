import type {
  JsonValue,
  NativeConversation,
  NativeConversationView,
  NativeHistoryItem,
  NativeHistoryStage,
  NativeHistoryTurnView,
} from "../src/native/types.js";
import { HistoryList } from "./history-list.js";

type ConversationHead = Omit<NativeConversation, "children" | "turns" | "nativeMetadata">;
type TurnHead = Omit<NativeHistoryTurnView, "items">;
export type OmpHistoryFrame =
  | { type: "turn"; id: string; turn: TurnHead; items: number }
  | { type: "item"; item: NativeHistoryItem }
  | { type: "metadata"; id: string; record: JsonValue }
  | { type: "conversation"; head: ConversationHead; children?: string[] }
  | { type: "complete"; root: string; count: number }
  | { type: "error"; error: string };

const maxFrameBytes = 256 * 1024 * 1024;

/** Newline-delimited JSON on private Bun/Node IPC, independent of OMP's storage format. */
export async function sendOmpFrame(frame: OmpHistoryFrame): Promise<void> {
  const body = Buffer.from(JSON.stringify(frame) + "\n");
  if (body.length > maxFrameBytes)
    throw new Error("An OMP history record exceeds the 256 MiB helper frame budget.");
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(body, (error) => (error ? reject(error) : resolve()));
  });
}

function createHistoryReceiver(stage: NativeHistoryStage) {
  const bodies = new Map<
    string,
    { turns: HistoryList<NativeHistoryTurnView>; nativeMetadata: HistoryList<JsonValue> }
  >();
  const descriptors = new Map<string, { head: ConversationHead; children?: string[] }>();
  const forConversation = (id: string) => {
    let body = bodies.get(id);
    if (!body) {
      body = { turns: new HistoryList(), nativeMetadata: new HistoryList() };
      bodies.set(id, body);
    }
    return body;
  };
  let pending: { remaining: number; items: HistoryList<NativeHistoryItem> } | undefined;
  let root: string | undefined;
  return {
    accept(frame: OmpHistoryFrame) {
      if (root) throw new Error("OMP helper sent data after completing its history.");
      if (frame.type === "error") throw new Error(frame.error);
      if (pending?.remaining && frame.type !== "item")
        throw new Error("OMP helper did not send all items for a turn.");
      switch (frame.type) {
        case "turn": {
          if (
            typeof frame.id !== "string" ||
            typeof frame.turn?.id !== "string" ||
            !Number.isSafeInteger(frame.items) ||
            frame.items < 0 ||
            descriptors.has(frame.id)
          )
            throw new Error("Invalid OMP history turn frame.");
          const { turn } = frame;
          const items = new HistoryList<NativeHistoryItem>();
          pending = { remaining: frame.items, items };
          forConversation(frame.id).turns.append(() => ({ ...turn, items }));
          break;
        }
        case "item":
          if (!pending?.remaining || typeof frame.item?.id !== "string")
            throw new Error("Invalid OMP history item frame.");
          pending.items.append(stage(frame.item));
          pending.remaining--;
          break;
        case "metadata":
          if (
            typeof frame.id !== "string" ||
            frame.record === undefined ||
            descriptors.has(frame.id)
          )
            throw new Error("Invalid OMP history metadata frame.");
          forConversation(frame.id).nativeMetadata.append(stage(frame.record));
          break;
        case "conversation":
          if (
            frame.head?.source !== "omp" ||
            typeof frame.head.id !== "string" ||
            descriptors.has(frame.head.id) ||
            (frame.children !== undefined && !Array.isArray(frame.children))
          )
            throw new Error("Invalid OMP history conversation frame.");
          descriptors.set(frame.head.id, frame);
          break;
        case "complete":
          if (!frame.root || frame.count !== descriptors.size)
            throw new Error("Incomplete OMP history family.");
          root = frame.root;
          break;
        default:
          throw new Error("Unknown OMP history frame.");
      }
    },
    finish(): NativeConversationView {
      if (!root || pending?.remaining) throw new Error("Incomplete OMP history response.");
      const attach = (id: string): NativeConversationView => {
        const descriptor = descriptors.get(id);
        if (!descriptor) throw new Error("OMP history family has a missing or repeated member.");
        descriptors.delete(id);
        const body = forConversation(id);
        bodies.delete(id);
        return {
          ...descriptor.head,
          ...body,
          ...(descriptor.children ? { children: descriptor.children.map(attach) } : {}),
        };
      };
      const result = attach(root);
      if (bodies.size || descriptors.size)
        throw new Error("OMP helper returned detached history records.");
      return result;
    },
  };
}

export function createOmpReplyReceiver(stage: NativeHistoryStage) {
  const history = createHistoryReceiver(stage);
  let bytes = 0;
  let parts: Buffer[] = [];
  return {
    push(chunk: Buffer) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const stop = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(start, stop);
        bytes += part.length;
        if (bytes >= maxFrameBytes) throw new Error("OMP helper returned an oversized frame.");
        if (part.length) parts.push(part);
        if (newline < 0) return;
        const data = parts.length === 1 ? parts[0]! : Buffer.concat(parts, bytes);
        let frame: OmpHistoryFrame;
        try {
          frame = JSON.parse(data.toString("utf8")) as OmpHistoryFrame;
        } catch (error) {
          throw new Error("OMP helper returned invalid frame JSON.", { cause: error });
        }
        history.accept(frame);
        parts = [];
        bytes = 0;
        start = newline + 1;
      }
    },
    finish() {
      if (bytes) throw new Error("OMP helper returned a truncated frame.");
      return history.finish();
    },
  };
}
