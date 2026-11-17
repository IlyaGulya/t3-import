/** Synthetic-only fixture creation using OMP's own title, blob and ownership APIs. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [operation, root, home, sessionId] = process.argv.slice(2);
if (!root || !home) throw new Error("Fixture requires package and synthetic home.");
if (operation === "payloads") {
  const { BlobStore } = await import(pathToFileURL(join(root, "src/session/blob-store.ts")).href);
  const { serializeTitleSlot } = await import(pathToFileURL(join(root, "src/session/session-title-slot.ts")).href);
  const blob = new BlobStore(join(home, "blobs")).putSync(Buffer.from("native-omp-image-fixture"));
  process.stdout.write(JSON.stringify({ blobRef: blob.ref, titleSlot: serializeTitleSlot({ title: "Native title slot", source: "user", updatedAt: "2026-01-01T00:00:00.000Z" }) }));
} else if (operation === "lease") {
  process.env.PI_TEST_SESSION_OWNERS_DIR = join(home, "test-owners");
  const { tryAcquireSessionLease } = await import(pathToFileURL(join(root, "src/session/session-storage.ts")).href);
  const lease = tryAcquireSessionLease(sessionId);
  if (!lease) throw new Error("Synthetic lease was already held.");
  process.stdout.write("ready\n");
  await new Promise<void>(() => {});
} else throw new Error("Unknown synthetic fixture operation.");
