import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Private scratch storage. The file is unnamed on POSIX, even during an interrupted run. */
export class HistorySpool {
  private readonly directory = mkdtempSync(join(tmpdir(), "t3-import-history-"));
  private readonly file: number;
  private size = 0;
  private closed = false;

  constructor() {
    let file: number | undefined;
    try {
      file = openSync(join(this.directory, "history"), "wx+", 0o600);
      if (process.platform !== "win32") rmSync(this.directory, { recursive: true });
      this.file = file;
    } catch (error) {
      if (file !== undefined) closeSync(file);
      rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
  }

  bytes(bytes: Buffer): () => Buffer {
    const start = this.size;
    const length = bytes.length;
    while (this.size < start + length) {
      const offset = this.size - start;
      const written = writeSync(this.file, bytes, offset, length - offset, this.size);
      if (!written) throw new Error("Could not write the native history scratch file.");
      this.size += written;
    }
    return () => {
      const result = Buffer.allocUnsafe(length);
      for (let offset = 0; offset < length;) {
        const size = readSync(this.file, result, offset, length - offset, start + offset);
        if (!size) throw new Error("Native history scratch file was truncated.");
        offset += size;
      }
      return result;
    };
  }

  json<T>(value: T): () => T {
    const read = this.bytes(Buffer.from(JSON.stringify(value)));
    return () => JSON.parse(read().toString("utf8")) as T;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.file);
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
