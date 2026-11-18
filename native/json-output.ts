/** JSON pieces for normalized history and native T3 JSON values. */
export function* nativeJsonPieces(
  value: unknown,
  pretty = false,
  canonical = false,
): Generator<string> {
  const prepare = (entry: unknown, key: string): unknown =>
    entry && typeof entry === "object" && "toJSON" in entry && typeof entry.toJSON === "function"
      ? entry.toJSON(key)
      : entry;
  function* pieces(entry: unknown, depth: number): Generator<string> {
    if (!entry || typeof entry !== "object") {
      yield JSON.stringify(entry) ?? "null";
      return;
    }
    const array = Array.isArray(entry);
    // Object.fromEntries retains JSON's numeric-key ordering after canonical sorting.
    const object =
      canonical && !array
        ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
        : entry;
    const rows: [string | undefined, unknown][] = array
      ? Array.from(entry, (child, index) => [undefined, prepare(child, String(index))])
      : Object.entries(object)
          .map(([key, child]): [string, unknown] => [key, prepare(child, key)])
          .filter(
            ([, child]) =>
              child !== undefined && typeof child !== "function" && typeof child !== "symbol",
          );
    yield array ? "[" : "{";
    for (let index = 0; index < rows.length; index++) {
      if (index) yield ",";
      if (pretty) yield "\n" + "  ".repeat(depth + 1);
      const [key, child] = rows[index]!;
      if (!array) yield JSON.stringify(key) + (pretty ? ": " : ":");
      yield* pieces(child, depth + 1);
    }
    if (pretty && rows.length) yield "\n" + "  ".repeat(depth);
    yield array ? "]" : "}";
  }
  yield* pieces(prepare(value, ""), 0);
}

/** Stream normalized JSON without constructing a family-sized V8 string. */
export async function writeNativeJson(value: unknown, pretty: boolean): Promise<void> {
  let pending = "";
  const flush = async () => {
    const chunk = pending;
    pending = "";
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  };
  for (const part of nativeJsonPieces(value, pretty)) {
    pending += part;
    if (pending.length >= 64 * 1024) await flush();
  }
  pending += "\n";
  await flush();
}
