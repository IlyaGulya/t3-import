import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import {
  dynamicToolTitle,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import type { JsonValue, NativeHistoryItem } from "../src/native/types.js";

// Historical counterpart of the private classification/projection functions in
// ClaudeAdapterV2.ts at the pinned T3 commit. No live query frames are replayed.
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((block) => (record(block).type === "text" ? record(block).text : ""))
          .filter((value) => typeof value === "string")
          .join("\n\n")
      : "";
const field = (input: Record<string, unknown>, keys: string[]): string | undefined =>
  keys
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);

export function claudeToolCard(
  toolName: string,
  input: Record<string, unknown>,
): Pick<NativeHistoryItem, "kind" | "data" | "title"> {
  const name = toolName.toLowerCase().replaceAll(/[\s_-]/g, "");
  const nativeInput = input as { [key: string]: JsonValue };
  if (name === "bash")
    return {
      kind: "command_execution",
      title: field(input, ["command", "cmd", "script"]) ?? toolName,
      data: { input: field(input, ["command", "cmd", "script"]) ?? toolName },
    };
  if (["edit", "write", "multiedit", "notebookedit"].includes(name)) {
    const fileName =
      field(input, ["file_path", "notebook_path", "path", "filename", "fileName"]) ??
      `${toolName} result`;
    return {
      kind: "file_change",
      title: fileName,
      data: {
        fileName,
        ...(typeof input.old_string === "string" ? { oldStr: input.old_string } : {}),
        ...(typeof input.new_string === "string" ? { newStr: input.new_string } : {}),
      },
    };
  }
  if (name === "todowrite") {
    const steps = Array.isArray(input.todos)
      ? input.todos.flatMap((value, index) => {
          const todo = record(value);
          if (typeof todo.content !== "string" || !todo.content.trim()) return [];
          return [
            {
              id: `todo-${index}`,
              text: todo.content.trim(),
              status:
                todo.status === "completed"
                  ? "completed"
                  : todo.status === "in_progress"
                    ? "running"
                    : "pending",
            },
          ];
        })
      : [];
    return { kind: "todo_list", title: "Updated todos", data: { steps } };
  }
  if (name === "websearch" || name === "webfetch") {
    const pattern = field(input, ["query", "url", "pattern"]);
    return {
      kind: "web_search",
      title: pattern ?? toolName,
      data: pattern ? { patterns: [pattern] } : {},
    };
  }
  const presentation = mcpToolPresentation({
    toolName: toolName.replace(/^mcp__claude_ai_/u, "mcp__"),
  });
  const readPath = name === "read" ? field(input, ["file_path", "path"]) : undefined;
  const searchTitle = ["grep", "glob", "ls"].includes(name)
    ? formatSearchToolLabel({ input })
    : undefined;
  return {
    kind: "dynamic_tool",
    title: readPath
      ? formatReadToolLabel(readPath)
      : (searchTitle ?? dynamicToolTitle(toolName, input) ?? presentation.title ?? toolName),
    data: {
      toolName,
      input: nativeInput,
      ...(presentation.toolIcon ? { toolIcon: { ...presentation.toolIcon } as JsonValue } : {}),
      ...(presentation.toolSource
        ? { toolSource: { ...presentation.toolSource } as JsonValue }
        : {}),
    },
  };
}

export function completeClaudeToolCard(
  item: NativeHistoryItem,
  input: Record<string, unknown>,
  output: JsonValue,
  structured: unknown,
): void {
  if (item.kind === "command_execution") {
    const streams = record(structured);
    item.data.output =
      typeof streams.stdout === "string" || typeof streams.stderr === "string"
        ? [streams.stdout, streams.stderr]
            .filter((value) => typeof value === "string" && value.length > 0)
            .join("\n")
        : text(output);
  } else if (item.kind === "file_change") {
    const result = record(structured);
    const path = typeof result.filePath === "string" ? result.filePath : String(item.data.fileName);
    const hunks = Array.isArray(result.structuredPatch)
      ? result.structuredPatch.flatMap((value) => {
          const hunk = record(value);
          return [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(
            (value) => typeof value === "number" && Number.isInteger(value) && value >= 0,
          ) &&
            Array.isArray(hunk.lines) &&
            hunk.lines.every((line) => typeof line === "string")
            ? [
                {
                  oldStart: hunk.oldStart as number,
                  oldLines: hunk.oldLines as number,
                  newStart: hunk.newStart as number,
                  newLines: hunk.newLines as number,
                  lines: hunk.lines as string[],
                },
              ]
            : [];
        })
      : [];
    const patch = hunks.length
      ? { oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks }
      : result.type === "create" && typeof result.content === "string"
        ? structuredPatch("/dev/null", path, "", result.content)
        : undefined;
    if (patch) item.data.diffStr = formatPatch(patch, FILE_HEADERS_ONLY);
  } else if (item.kind === "web_search") {
    const result = record(structured);
    const results = Array.isArray(result.results)
      ? result.results.flatMap((value) => {
          const content = record(value).content;
          return Array.isArray(content)
            ? content.flatMap((value) => {
                const link = record(value);
                return typeof link.title === "string" && typeof link.url === "string"
                  ? [{ title: link.title, url: link.url }]
                  : [];
              })
            : [];
        })
      : [];
    if (results.length) item.data.results = results;
    else if (typeof input.url === "string" && text(output).trim())
      item.data.results = [{ url: input.url, snippet: text(output).slice(0, 8000) }];
  } else if (item.kind === "dynamic_tool") item.data.output = output;
}
