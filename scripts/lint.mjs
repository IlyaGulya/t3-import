import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkArchitecture } from "./check-architecture.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
let root = packageRoot;
if (rootIndex >= 0) {
  if (!args[rootIndex + 1]) throw new Error("--root requires a directory");
  root = resolve(args[rootIndex + 1]);
  args.splice(rootIndex, 2);
}
const diagnostics = checkArchitecture(root, args.length ? args : undefined);
for (const diagnostic of diagnostics) console.error(diagnostic);
const result = spawnSync(
  process.execPath,
  [
    resolve(packageRoot, "node_modules/oxlint/bin/oxlint"),
    "--config",
    resolve(packageRoot, ".oxlintrc.json"),
    "--deny-warnings",
    ...(args.length
      ? args
      : ["native", "src", "scripts", "quality"].filter((file) => existsSync(resolve(root, file)))),
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = diagnostics.length ? 1 : (result.status ?? 1);
