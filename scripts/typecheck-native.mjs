import ts from "typescript";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { packageRoot, referenceRoot } from "./build-native.mjs";

const root = referenceRoot();
const paths = {
  "effect": [join(packageRoot, "node_modules/effect/dist/index.d.ts")],
  "effect/*": [join(packageRoot, "node_modules/effect/dist/*.d.ts")],
  "@effect/platform-node": [join(packageRoot, "node_modules/@effect/platform-node/dist/index.d.ts")],
  "@effect/platform-node/*": [join(packageRoot, "node_modules/@effect/platform-node/dist/*.d.ts")],
  "@effect/platform-node-shared/*": [join(packageRoot, "node_modules/@effect/platform-node-shared/dist/*.d.ts")],
  "@t3-native/server/*": [join(root, "apps/server/src/*")],
  "@t3-native/codex/*": [join(root, "packages/effect-codex-app-server/src/*")],
  "*": [join(packageRoot, "node_modules/*")],
};
for (const name of readdirSync(join(root, "packages"))) {
  const directory = join(root, "packages", name);
  const file = join(directory, "package.json");
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (!manifest.name?.startsWith("@t3tools/")) continue;
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const target = typeof value === "string" ? value : value.types ?? value.import ?? value.default;
    if (target) paths[manifest.name + (key === "." ? "" : key.slice(1))] = [resolve(directory, target)];
  }
}
// OMP remains a runtime-selected native package, while development checks its published native types.
const ompCandidates = [process.env.OMP_NATIVE_REFERENCE_PACKAGE,
  join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "install/global/node_modules/@oh-my-pi/pi-coding-agent"),
  join(dirname(process.execPath), "../lib/node_modules/@oh-my-pi/pi-coding-agent")].filter(Boolean);
try { ompCandidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@oh-my-pi/pi-coding-agent")); } catch {}
const ompRoot = ompCandidates.map((path) => resolve(path)).find((path) => existsSync(join(path, "src/session/session-loader.ts")));
if (!ompRoot) throw new Error("Native OMP typechecking requires @oh-my-pi/pi-coding-agent@18.22.0; set OMP_NATIVE_REFERENCE_PACKAGE to its installed package directory.");
const ompManifest = JSON.parse(readFileSync(join(ompRoot, "package.json"), "utf8"));
if (ompManifest.name !== "@oh-my-pi/pi-coding-agent" || ompManifest.version !== "18.22.0") throw new Error("OMP native reference type package must be @oh-my-pi/pi-coding-agent@18.22.0.");
paths["@oh-my-pi/pi-coding-agent/*"] = [join(ompRoot, "dist/types/*.d.ts")];
const ompTypeModules = JSON.parse(execFileSync(process.env.OMP_NATIVE_BUN || "bun", ["-e",
  'console.log(JSON.stringify(Object.fromEntries(["@oh-my-pi/pi-utils/dirs", "@oh-my-pi/pi-utils/logger", "@oh-my-pi/pi-tui/chat/transcript-entry"].map(name => [name, Bun.resolveSync(name, process.argv[1])]))))', ompRoot], { encoding: "utf8" }));
for (const [name, file] of Object.entries(ompTypeModules)) paths[name] = [file];

const files = ts.sys.readDirectory(join(packageRoot, "native"), [".ts"]);
files.push(...ts.sys.readDirectory(join(packageRoot, "src"), [".ts"]));
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true,
  strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
  skipLibCheck: true, noEmit: true, esModuleInterop: true,
  resolveJsonModule: true, types: ["node", "bun"], typeRoots: [join(packageRoot, "node_modules/@types")],
  paths,
});
// Check importer sources against real upstream types, without taking ownership of diagnostics in T3's checkout.
const diagnostics = files.flatMap((file) => {
  const source = program.getSourceFile(file);
  return source ? [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)] : [];
});
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => packageRoot,
    getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else console.log(`Checked ${files.length} importer files against the pinned T3 source types.`);
