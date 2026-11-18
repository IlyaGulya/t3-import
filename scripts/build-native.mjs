import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reference = JSON.parse(readFileSync(join(packageRoot, "native/t3-reference.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const bundledPackages = new Map();

export function referenceRoot() {
  const candidates = [
    process.env.T3_NATIVE_REFERENCE_REPO,
    join(packageRoot, "repos/t3code"),
    join(packageRoot, "../t3code"),
  ].filter(Boolean);
  const root = candidates
    .map((path) => resolve(path))
    .find((path) => existsSync(join(path, "apps/server/src/orchestration-v2/EventSink.ts")));
  if (!root)
    throw new Error(
      `Native build needs T3 sources at ${reference.commit}. Clone ${reference.repository} and set T3_NATIVE_REFERENCE_REPO to that checkout.`,
    );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (head !== reference.commit)
    throw new Error(
      `T3 source mismatch: expected ${reference.commit}, found ${head}. Use the pinned commit or validate a new reference first.`,
    );
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", "apps/server/src", "packages"], {
    cwd: root,
  });
  return root;
}

export async function buildNative(entry = "native/main.ts", output = "dist/cli.js") {
  const root = referenceRoot();
  const packages = new Map();
  for (const name of readdirSync(join(root, "packages"))) {
    const directory = join(root, "packages", name);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    packages.set(manifest.name, { directory, manifest });
  }
  const outfile = resolve(packageRoot, output);
  mkdirSync(dirname(outfile), { recursive: true });
  const compiled = await build({
    absWorkingDir: packageRoot,
    entryPoints: [resolve(packageRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
    sourcemap: true,
    metafile: true,
    banner: {
      js: "import { createRequire as __nativeCreateRequire } from 'node:module'; const require = __nativeCreateRequire(import.meta.url);",
    },
    external: [
      "effect",
      "effect/*",
      "@effect/*",
      "better-sqlite3",
      "@anthropic-ai/claude-agent-sdk",
    ],
    nodePaths: [join(packageRoot, "node_modules")],
    define: {
      __T3_NATIVE_REFERENCE__: JSON.stringify(reference),
      __IMPORTER_VERSION__: JSON.stringify(manifest.version),
    },
    plugins: [
      {
        name: "pinned-t3-source",
        setup(api) {
          api.onResolve({ filter: /^@t3-native\// }, ({ path }) => {
            const relative = path.slice("@t3-native/".length);
            let target;
            if (relative.startsWith("server/"))
              target = join(root, "apps/server/src", relative.slice("server/".length));
            else if (relative.startsWith("codex/"))
              target = join(
                root,
                "packages/effect-codex-app-server/src",
                relative.slice("codex/".length),
              );
            else throw new Error(`Unknown native T3 source import: ${path}`);
            if (!existsSync(target)) target += ".ts";
            return { path: target };
          });
          api.onResolve({ filter: /^@t3tools\// }, ({ path }) => {
            const parts = path.split("/");
            const pkg = packages.get(parts.slice(0, 2).join("/"));
            if (!pkg) throw new Error(`Unknown T3 workspace package: ${path}`);
            const key = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
            const entry = pkg.manifest.exports[key];
            const target = typeof entry === "string" ? entry : (entry?.import ?? entry?.default);
            if (!target) throw new Error(`Missing T3 workspace export: ${path}`);
            return { path: resolve(pkg.directory, target) };
          });
        },
      },
    ],
  });
  for (const input of Object.keys(compiled.metafile.inputs)) {
    const parts = resolve(packageRoot, input).split(sep);
    const index = parts.lastIndexOf("node_modules");
    if (index < 0) continue;
    const directory = parts.slice(0, index + (parts[index + 1]?.startsWith("@") ? 3 : 2)).join(sep);
    const packageFile = join(directory, "package.json");
    if (bundledPackages.has(directory) || !existsSync(packageFile)) continue;
    const info = JSON.parse(readFileSync(packageFile, "utf8"));
    const licenses = readdirSync(directory).filter((name) =>
      /^(?:licen[cs]e|copying|copyright)(?:\.|$)/i.test(name),
    );
    bundledPackages.set(
      directory,
      `${info.name}@${info.version}\n${licenses.map((name) => readFileSync(join(directory, name), "utf8")).join("\n") || `Declared license: ${info.license ?? "see package metadata"}`}`,
    );
  }
  return outfile;
}

export async function buildCli() {
  bundledPackages.clear();
  rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
  const outfile = await buildNative();
  chmodSync(outfile, 0o755);
  if (existsSync(join(packageRoot, "native/omp-helper.ts")))
    await buildNative("native/omp-helper.ts", "dist/omp-helper.js");
  const bridge = await buildNative("native/omp-rpc-bridge.ts", "dist/omp.js");
  chmodSync(bridge, 0o755);
  if (existsSync(join(packageRoot, "native/claude-helper.ts")))
    await buildNative("native/claude-helper.ts", "dist/claude-helper.js");
  writeFileSync(
    join(packageRoot, "dist/t3-reference.json"),
    JSON.stringify(reference, null, 2) + "\n",
  );
  writeFileSync(
    join(packageRoot, "dist/THIRD-PARTY-NOTICES.txt"),
    `This artifact contains T3 Code source pinned to ${reference.commit}.\n\n` +
      readFileSync(join(referenceRoot(), "LICENSE"), "utf8") +
      "\n\nBundled third-party packages\n\n" +
      [...bundledPackages.values()].join("\n\n----------------\n\n"),
  );
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entryIndex = process.argv.indexOf("--entry");
  const outputIndex = process.argv.indexOf("--outfile");
  if (entryIndex < 0 && outputIndex < 0) await buildCli();
  else
    await buildNative(
      entryIndex < 0 ? undefined : process.argv[entryIndex + 1],
      outputIndex < 0 ? undefined : process.argv[outputIndex + 1],
    );
}
