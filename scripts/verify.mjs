import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex >= 0 ? args.splice(rootIndex, 2)[1] : packageRoot;
if (!root) throw new Error("--root requires a directory");
const cwd = resolve(root);
if (args.some((arg) => !["--changed", "--plan", "--json"].includes(arg)))
  throw new Error("Usage: verify.mjs [--changed] [--plan] [--json] [--root <directory>]");
if (cwd !== packageRoot && !args.includes("--plan"))
  throw new Error("--root is available for planning only; execute checks from this checkout");
const fullSteps = ["format", "lint", "quality-tests", "quality-types", "typecheck", "native-tests"];
let mode = args.includes("--changed") ? "changed" : "full";
let reason =
  mode === "full"
    ? "Full validation requested."
    : "Working tree changes against HEAD, including staged and untracked files.";
let changedFiles = [];
let steps = fullSteps;
if (mode === "changed") {
  const tracked = spawnSync("git", ["diff", "--name-only", "--relative", "-z", "HEAD", "--", "."], {
    cwd,
    encoding: "utf8",
  });
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
    { cwd, encoding: "utf8" },
  );
  if (tracked.status !== 0 || untracked.status !== 0) {
    mode = "full";
    reason = "Git comparison is unavailable; conservatively running the full checks.";
  } else {
    changedFiles = [
      ...new Set(
        [...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")]
          .filter(Boolean)
          .map((file) => file.replaceAll("\\", "/")),
      ),
    ].sort();
    if (!changedFiles.length) steps = [];
    else if (
      changedFiles.every((file) => /\.(?:md|txt)$/iu.test(file) || /^LICENSE(?:[.-]|$)/u.test(file))
    ) {
      steps = ["format", "lint"];
      reason = "Only documentation changed; no code tests are needed.";
    } else
      reason =
        "Code/configuration changes can affect shared readers, CLI or writer: full test fallback.";
  }
}
const plan = { mode, reason, changedFiles, steps };
if (args.includes("--plan")) {
  console.log(
    args.includes("--json")
      ? JSON.stringify(plan)
      : `${reason}\n${steps.join(" → ") || "No changes."}`,
  );
} else {
  console.log(reason);
  const commands = {
    format: ["node_modules/oxfmt/bin/oxfmt", "--check", "."],
    lint: ["scripts/lint.mjs"],
    "quality-tests": ["--test", "scripts/quality.test.mjs"],
    "quality-types": [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--strict",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--allowImportingTsExtensions",
      "--skipLibCheck",
      "quality/index.ts",
    ],
    typecheck: ["scripts/typecheck-native.mjs"],
    "native-tests": ["scripts/test-native.mjs"],
  };
  for (const step of steps) {
    console.log(`Checking ${step}…`);
    const result = spawnSync(process.execPath, commands[step], {
      cwd: packageRoot,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
