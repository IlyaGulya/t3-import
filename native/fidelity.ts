import { createHash } from "node:crypto";
import { nativeJsonPieces } from "./json-output.js";

/** Stable, body-preserving digest; DateTime values use their native JSON encoding. */
export function auditFingerprint(value: unknown): string {
  const hash = createHash("sha256");
  for (const part of nativeJsonPieces(value, false, true)) hash.update(part);
  return hash.digest("hex");
}
