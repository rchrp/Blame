// What a desktop service answered, as the model reads it: an MCP result with
// images becomes text and image blocks (the images reach the model as
// images, stored as blobs by the tool set); anything else is its JSON.

import {
  previewToolModelOutput,
  recordSessionScreenshots,
} from "../../preview-screenshots.js";
import { limitToolText, type TextLimit } from "../../tool-output-limit.js";
import type { ToolContentBlock, ToolOutput } from "../tool.js";

export function modelOutput(result: unknown, limit?: TextLimit): ToolOutput {
  const native = previewToolModelOutput(result);
  const limited = limit ? limitToolText(native, limit) : native;
  if (typeof limited === "string") return limited;
  if (!Array.isArray(limited)) return { json: limited ?? null };
  return { content: limited.flatMap(contentBlock) };
}

/**
 * An MCP tool result (`CallToolResult`): its text and images, its structured
 * content when it has no text; `isError` makes it a failure.
 */
export function mcpOutput(result: unknown, limit: TextLimit): ToolOutput {
  const value = record(result);
  const content = Array.isArray(value.content) ? value.content : [];
  const blocks: ToolContentBlock[] = content.flatMap(
    (item): ToolContentBlock[] => {
      const part = record(item);
      if (part.type === "text" && typeof part.text === "string")
        return [{ type: "text", text: part.text }];
      if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      )
        return [{ type: "image", data: part.data, mediaType: part.mimeType }];
      const resource = record(part.resource);
      if (part.type === "resource" && typeof resource.text === "string")
        return [{ type: "text", text: resource.text }];
      if (part.type === "resource_link" && typeof part.uri === "string")
        return [{ type: "text", text: `Resource: ${part.uri}` }];
      return [];
    },
  );
  if (!blocks.some((block) => block.type === "text") && value.structuredContent)
    blocks.unshift({
      type: "text",
      text: JSON.stringify(value.structuredContent),
    });
  if (!blocks.length) blocks.push({ type: "text", text: "(no output)" });
  const limited = limitToolText({ content: blocks }, limit).content;
  return { ...(value.isError === true ? { ok: false } : {}), content: limited };
}

/** The same, and the screenshots it holds count as the session's own. */
export function previewOutput(
  session: string,
  result: unknown,
  limit?: TextLimit,
): ToolOutput {
  recordSessionScreenshots(session, previewToolModelOutput(result));
  return modelOutput(result, limit);
}

function contentBlock(value: unknown): ToolContentBlock[] {
  const block = record(value);
  if (block.type === "text" && typeof block.text === "string")
    return [{ type: "text", text: block.text }];
  if (
    block.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mediaType === "string"
  )
    return [
      {
        type: "image",
        data: block.data,
        mediaType: block.mediaType,
        ...(block.blameScreenshot
          ? { screenshot: record(block.blameScreenshot) }
          : {}),
      },
    ];
  return [];
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
