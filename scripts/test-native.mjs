import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCli, buildNative, packageRoot } from "./build-native.mjs";

const filters = process.argv.slice(2);
await buildCli();
const files = readdirSync(join(packageRoot, "native")).filter((name) => name.endsWith(".test.ts") && (filters.length === 0 || filters.some((filter) => name.includes(filter))));
if (files.length === 0) throw new Error("No native tests selected.");
const bundles = [];
for (const file of files) bundles.push(await buildNative(`native/${file}`, `artifacts/native-tests/${file.replace(/\.ts$/, ".mjs")}`));
const result = spawnSync(process.execPath, ["--test", ...bundles], { cwd: packageRoot, stdio: "inherit" });
process.exitCode = result.status ?? 1;
