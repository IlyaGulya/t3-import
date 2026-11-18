import { defineRule, type ESTree } from "@oxlint/plugins";

// Adapted in spirit from T3's no-wall-clock-in-tests policy for node:test:
// fixed source timestamps are required, but real subprocess clocks may have a
// narrowly documented integration exception. No Vitest/Effect test API is needed.
function memberPath(node: ESTree.Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return undefined;
  const parent = memberPath(node.object);
  const name =
    !node.computed && node.property.type === "Identifier"
      ? node.property.name
      : node.property.type === "Literal" && typeof node.property.value === "string"
        ? node.property.value
        : undefined;
  return parent && name ? `${parent}.${name}` : undefined;
}
const clocks = new Set(["Date.now", "performance.now", "process.hrtime", "process.hrtime.bigint"]);
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep node:test histories deterministic and never leave focused tests." },
  },
  create(context) {
    if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(context.filename)) return {};
    const testNames = new Set(["test", "it", "describe"]);
    const waits = new Set(["setTimeout"]);
    const integrationClock = (node: ESTree.Node) =>
      context.sourceCode
        .getAllComments()
        .some(
          (comment) =>
            comment.loc.end.line === node.loc.start.line - 1 &&
            /\bintegration clock:\s*\S/iu.test(comment.value),
        );
    const reportClock = (node: ESTree.Node) => {
      if (!integrationClock(node))
        context.report({
          node,
          message:
            "Use a fixed timestamp or an injected clock for historical fixtures; real subprocess timing requires an adjacent 'Integration clock: reason' comment.",
        });
    };
    return {
      ImportDeclaration(node) {
        if (node.source.value === "node:test")
          for (const specifier of node.specifiers) testNames.add(specifier.local.name);
        if (
          ["node:timers", "node:timers/promises", "timers", "timers/promises"].includes(
            String(node.source.value),
          )
        )
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              (specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value) === "setTimeout"
            )
              waits.add(specifier.local.name);
            if (
              specifier.type === "ImportNamespaceSpecifier" ||
              specifier.type === "ImportDefaultSpecifier"
            )
              waits.add(`${specifier.local.name}.setTimeout`);
          }
      },
      CallExpression(node) {
        const path = memberPath(node.callee);
        if (path && clocks.has(path)) reportClock(node);
        if (path && waits.has(path))
          context.report({
            node,
            message:
              "Await an observable process/protocol milestone instead of a real-time sleep in tests.",
          });
        if (path && [...testNames].some((name) => path === `${name}.only`))
          context.report({
            node,
            message: "Focused tests can hide regressions; remove .only before verification.",
          });
        if (path && [...testNames].some((name) => path === `${name}.skip`))
          context.report({
            node,
            message:
              "Unconditional test skips hide regressions; use a visible capability/platform skip gate.",
          });
        if (path && testNames.has(path))
          for (const arg of node.arguments) {
            if (arg.type !== "ObjectExpression") continue;
            for (const property of arg.properties)
              if (
                property.type === "Property" &&
                !property.computed &&
                (property.key.type === "Identifier"
                  ? property.key.name
                  : property.key.type === "Literal"
                    ? property.key.value
                    : undefined) === "skip" &&
                property.value.type === "Literal" &&
                property.value.value === true
              )
                context.report({
                  node: property,
                  message:
                    "Unconditional test skips hide regressions; use a visible capability/platform skip gate.",
                });
          }
      },
      NewExpression(node) {
        if (node.arguments.length === 0 && memberPath(node.callee) === "Date") reportClock(node);
      },
    };
  },
});
