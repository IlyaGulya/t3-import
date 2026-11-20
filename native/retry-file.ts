import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isMinLength(1));
const Source = Schema.Struct({
  source: Schema.Literals(["codex", "claude", "omp"]),
  options: Schema.Struct({
    sourceHome: Schema.optionalKey(Text),
    binary: Schema.optionalKey(Text),
    ompPackage: Schema.optionalKey(Text),
    bunBinary: Schema.optionalKey(Text),
    snapshot: Schema.optionalKey(Schema.Boolean),
    codexIndexOnly: Schema.optionalKey(Schema.Boolean),
  }),
  // An omitted selection means source discovery or the run itself failed.
  sessionIds: Schema.optionalKey(Schema.Array(Text)),
});
const RetryFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("t3-import-retry"),
  t3Home: Text,
  placement: Schema.Struct({
    settled: Schema.optionalKey(Schema.Boolean),
    oldFamilyDays: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    oldFamilyAction: Schema.optionalKey(Schema.Literals(["keep", "settle", "archive"])),
    archiveEmptyChildren: Schema.optionalKey(Schema.Boolean),
  }),
  sources: Schema.Array(Source),
});

export type RetrySource = typeof Source.Type;
export type RetryManifest = typeof RetryFile.Type;

export async function readRetryFile(path: string): Promise<RetryManifest> {
  const manifest = Schema.decodeUnknownSync(RetryFile)(JSON.parse(await readFile(path, "utf8")));
  if (!isAbsolute(manifest.t3Home))
    throw new Error("The retry file must specify an absolute T3 home.");
  if (new Set(manifest.sources.map(({ source }) => source)).size !== manifest.sources.length)
    throw new Error("The retry file repeats a source.");
  return manifest;
}

export async function saveRetryFile(
  manifest: RetryManifest,
  targetDatabase: string,
  requestedPath?: string,
): Promise<string> {
  const path =
    requestedPath ?? join(dirname(targetDatabase), "t3-import-retries", `${randomUUID()}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.retry.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    // Publish the complete file without replacing an earlier retry file.
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return path;
}
