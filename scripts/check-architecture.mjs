import ts from "typescript";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const ignored = new Set([
  "node_modules",
  "repos",
  "dist",
  "artifacts",
  "coverage",
  "backups",
  ".git",
]);
const normalize = (value) => value.replaceAll("\\", "/");
const canonical = (value) => (existsSync(value) ? realpathSync(value) : resolve(value));
function sourceFiles(root, inputs) {
  const files = [];
  const visit = (file) => {
    if (!existsSync(file)) return;
    const entries = readdirSync(dirname(file), { withFileTypes: true });
    const entry = entries.find((entry) => entry.name === file.split(/[\\/]/u).at(-1));
    if (entry?.isDirectory()) {
      for (const child of readdirSync(file, { withFileTypes: true }))
        if (!ignored.has(child.name)) visit(join(file, child.name));
    } else if (SOURCE_EXTENSIONS.has(extname(file))) files.push(canonical(file));
  };
  for (const input of inputs) visit(resolve(root, input));
  return [...new Set(files)];
}
function role(file, root) {
  const path = normalize(relative(root, file));
  if (/\.(?:test|spec)\.[cm]?[jt]s$/u.test(path) || /(?:fixture|peer)\.[cm]?[jt]s$/u.test(path))
    return "test";
  if (path.startsWith("src/native/")) return "normalized";
  if (path === "native/cli.ts" || path === "native/main.ts") return "cli";
  if (path === "native/target.ts") return "writer";
  if (path === "native/server.ts") return "test";
  if (/^native\/(?:codex|claude|omp)(?:-helper|-tools)?\.ts$/u.test(path)) return "reader";
  return "shared";
}
const fsMutations = new Set([
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createWriteStream",
  "link",
  "linkSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "write",
  "writeSync",
  "writeFile",
  "writeFileSync",
]);
const historyMethods = new Set([
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
]);
const writerServerImports = new Set([
  "orchestration-v2/EventSink.ts",
  "orchestration-v2/EventStore.ts",
  "orchestration-v2/ProjectionStore.ts",
  "orchestration-v2/ProjectStore.ts",
  "orchestration-v2/WireProjection.ts",
  "persistence/ProviderSessionRuntime.ts",
  "persistence/OrchestrationEventStore.ts",
  "persistence/Migrations.ts",
  "serverOwnership.ts",
  "provider/Drivers/CodexHomeLayout.ts",
  "provider/CodexManagedHome.ts",
  "provider/Drivers/ClaudeHome.ts",
  "imageMime.ts",
]);

/** Static guardrails complement integration tests; they do not prove SDK calls are read-only. */
export function checkArchitecture(root, inputs = ["native", "src"]) {
  root = canonical(root);
  const diagnostics = [];
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : { config: {} };
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const program = ts.createProgram(sourceFiles(root, ["native", "src"]), {
    ...options,
    noResolve: true,
    noLib: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const cache = new Map();
  const load = (file) => {
    if (!cache.has(file))
      cache.set(
        file,
        program.getSourceFile(file) ??
          ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
      );
    return cache.get(file);
  };
  const report = (source, node, message) => {
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
    diagnostics.push(
      `${normalize(relative(root, source.fileName))}:${pos.line + 1}:${pos.character + 1}: architecture: ${message}`,
    );
  };
  const resolveImport = (specifier, file) => {
    const resolved = ts.resolveModuleName(
      specifier,
      file,
      {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        ...options,
      },
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    return resolved && !normalize(resolved).includes("/node_modules/")
      ? canonical(resolved)
      : undefined;
  };
  const visitOwner = (file, ownerRole, owner, visited) => {
    const key = `${ownerRole}:${file}`;
    if (visited.has(key)) return;
    visited.add(key);
    const source = load(file);
    const fsNamespaces = new Set();
    const inspectImport = (node, specifier, typeOnly = false) => {
      const builtin = specifier.replace(/^node:/u, "");
      const target = resolveImport(specifier, file);
      const targetRole = target ? role(target, root) : "external";
      if (ownerRole === "normalized") {
        if (!typeOnly) report(source, node, "normalized contracts must have no runtime imports");
        if (targetRole !== "normalized")
          report(
            source,
            node,
            "normalized contracts must not depend on runtime/native SDK modules",
          );
      }
      if (ownerRole === "reader") {
        if (targetRole === "writer" || targetRole === "cli" || targetRole === "test")
          report(
            source,
            node,
            `reader ${normalize(relative(root, owner))} cannot depend on writer/CLI/test module ${specifier}`,
          );
        if (
          builtin === "sqlite" ||
          /sqlite|EventSink|ProjectionStore|EventStore|Migrations|ProviderSessionRuntime/u.test(
            specifier,
          )
        )
          report(source, node, "reader cannot access target persistence; use native history APIs");
        if (specifier === "@anthropic-ai/claude-agent-sdk") {
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
          const allowed = new Set([
            "getSessionInfo",
            "getSessionMessages",
            "getSubagentMessages",
            "listSessions",
            "listSubagents",
            "importSessionToStore",
          ]);
          if (
            !typeOnly &&
            (!clause ||
              clause.name ||
              !clause.namedBindings ||
              !ts.isNamedImports(clause.namedBindings))
          )
            report(source, node, "Claude readers must use named native history API imports");
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
            for (const element of clause.namedBindings.elements)
              if (
                !typeOnly &&
                !element.isTypeOnly &&
                !allowed.has(element.propertyName?.text ?? element.name.text)
              )
                report(
                  source,
                  element,
                  "Claude reader import is outside the native history API allowlist",
                );
        }
        if (builtin === "readline" || builtin === "readline/promises")
          report(
            source,
            node,
            "reader must use native history APIs, not a handwritten line-history parser",
          );
        if (
          specifier.startsWith("@t3-native/") &&
          !["@t3-native/codex/client", "@t3-native/codex/schema"].includes(specifier)
        )
          report(
            source,
            node,
            "reader T3 source imports are limited to the native Codex history client/schema",
          );
      }
      if (ownerRole === "writer") {
        if (targetRole === "reader" || targetRole === "cli" || targetRole === "test")
          report(source, node, "writer cannot depend on source readers, CLI, or test runtime");
        if (
          specifier.startsWith("@t3-native/server/") &&
          !writerServerImports.has(specifier.slice("@t3-native/server/".length))
        )
          report(
            source,
            node,
            "writer server import is outside its explicit EventSink/persistence/support allowlist",
          );
        if (
          specifier.startsWith("@t3-native/codex/") ||
          /claude-agent-sdk|@oh-my-pi\/pi-coding-agent/u.test(specifier)
        )
          report(source, node, "writer cannot execute provider history or model APIs");
      }
      if (ownerRole === "cli") {
        if (
          builtin === "sqlite" ||
          specifier.startsWith("@t3-native/") ||
          /claude-agent-sdk|@oh-my-pi\/pi-coding-agent/u.test(specifier)
        )
          report(
            source,
            node,
            "CLI must call reader/writer boundaries instead of native SDK/persistence APIs",
          );
        if (targetRole === "test")
          report(source, node, "CLI cannot depend on the isolated test server or fixtures");
      }
      if (ownerRole === "reader" && (builtin === "fs" || builtin === "fs/promises")) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
        if (clause?.name) fsNamespaces.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
          fsNamespaces.add(clause.namedBindings.name.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const element of clause.namedBindings.elements)
            if (fsMutations.has(element.propertyName?.text ?? element.name.text))
              report(source, element, "reader cannot import source filesystem mutation APIs");
      }
      // Follow local barrels/helpers under the original owner. A CLI may call the
      // established reader/writer boundary, but a barrel must not conceal a bypass.
      if (target && SOURCE_EXTENSIONS.has(extname(target)) && targetRole === "shared")
        visitOwner(target, ownerRole, owner, visited);
    };
    const walk = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier))
        inspectImport(node, node.moduleSpecifier.text, node.importClause?.isTypeOnly === true);
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        inspectImport(node, node.moduleSpecifier.text, node.isTypeOnly);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      )
        inspectImport(node, node.argument.literal.text, true);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const specifier = node.arguments[0];
        if (specifier && ts.isStringLiteralLike(specifier)) inspectImport(node, specifier.text);
        else if (
          ["reader", "writer", "cli", "normalized"].includes(ownerRole) &&
          normalize(relative(root, file)) !== "native/omp-helper.ts"
        )
          report(source, node, "unresolved dynamic dependency bypasses the architecture boundary");
      }
      if (
        ownerRole === "reader" &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        fsNamespaces.has(node.expression.text) &&
        fsMutations.has(node.name.text)
      )
        report(source, node, "reader cannot use source filesystem mutation APIs");
      if (ownerRole === "writer") {
        let sqlText;
        if (ts.isTaggedTemplateExpression(node))
          sqlText = ts.isNoSubstitutionTemplateLiteral(node.template)
            ? node.template.text
            : node.template.head.text;
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["prepare", "exec", "run"].includes(node.expression.name.text)
        ) {
          const first = node.arguments[0];
          if (first && ts.isStringLiteralLike(first)) sqlText = first.text;
        }
        if (
          sqlText &&
          /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/iu.test(sqlText) &&
          /\b(?:orchestration_\w*|provider_session_runtime|effect_sql_migrations)\b/iu.test(sqlText)
        )
          report(
            source,
            node,
            "write T3 state through EventSink; direct SQL mutations are reserved for importer-owned ledger tables",
          );
      }
      if (
        ownerRole === "reader" &&
        normalize(relative(root, owner)) === "native/codex.ts" &&
        ts.isCallExpression(node)
      ) {
        const member = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isElementAccessExpression(node.expression) &&
              node.expression.argumentExpression &&
              ts.isStringLiteralLike(node.expression.argumentExpression)
            ? node.expression.argumentExpression.text
            : undefined;
        if (member === "request" || member === "notify") {
          const method = node.arguments[0];
          const allowed =
            member === "notify"
              ? new Set(["initialized"])
              : new Set([...historyMethods, "initialize"]);
          const type = method ? checker.getTypeAtLocation(method) : undefined;
          const constraint = type ? (checker.getBaseConstraintOfType(type) ?? type) : undefined;
          const variants = constraint?.isUnion()
            ? constraint.types
            : constraint
              ? [constraint]
              : [];
          if (
            !variants.length ||
            !variants.every((type) => type.isStringLiteral() && allowed.has(type.value))
          )
            report(
              source,
              node,
              "Codex history request must use the read-only RPC allowlist (plus initialization handshake)",
            );
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  for (const file of sourceFiles(root, inputs)) {
    const ownerRole = role(file, root);
    if (["reader", "writer", "cli", "normalized"].includes(ownerRole))
      visitOwner(file, ownerRole, file, new Set());
  }
  return [...new Set(diagnostics)];
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root =
    rootIndex >= 0
      ? args.splice(rootIndex, 2)[1]
      : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!root) throw new Error("--root requires a directory");
  const diagnostics = checkArchitecture(root, args.length ? args : undefined);
  for (const diagnostic of diagnostics) console.error(diagnostic);
  if (diagnostics.length) process.exitCode = 1;
}
