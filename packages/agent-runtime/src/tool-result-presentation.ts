import type { ContentBlock, Message } from "@cline/sdk";
import { projectImageContext } from "./image-context.js";
import { compactRepairAdvice } from "./repair-advice-projection.js";
import { encodeToolResult, unwrapFeedbackEnvelope } from "./tool-result-envelope.js";

const harnessNames = new Set(["read_code", "search_code", "edit_code", "run_task"]);

/**
 * Harness results arrive in their model-facing form (encodeToolResult). Here,
 * in-process sessions also drop long advice the model already read earlier in
 * this transcript, and earlier transcripts are brought to the same form.
 */
export function presentToolResults(messages: Message[]): Message[] {
  const names = new Map<string, string>();
  // Long advice already shown earlier in this transcript.
  const shown = new Set<string>();
  const source = process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION === "false" ? messages : compactRepairAdvice(messages);
  const presented = source.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map((block: ContentBlock) => {
      if (block.type === "tool_use") names.set(block.id, block.name);
      return presentBlock(block, names, shown);
    });
    return { ...message, content };
  });
  return projectImageContext(presented);
}

function presentBlock(block: ContentBlock, names: Map<string, string>, shown: Set<string>): ContentBlock {
  if (block.type !== "tool_result") return block;
  if (!harnessNames.has(names.get(block.tool_use_id) ?? block.name ?? "")) return block;
  const result = harnessResult(block.content);
  if (!result) return block;
  const attachments = Array.isArray(block.content)
    ? (block.content as Array<{ type: string }>).filter((part) => part.type !== "text")
    : [];
  const encoded = encodeToolResult(condensed(result, shown) as Record<string, unknown>, attachments);
  const content = Array.isArray(encoded) ? encoded : JSON.stringify(encoded);
  return JSON.stringify(content) === JSON.stringify(block.content) ? block : { ...block, content } as ContentBlock;
}

/** A harness result, from its JSON text or from its multipart envelope. */
function harnessResult(content: unknown) {
  let value: unknown;
  if (typeof content === "string") {
    try { value = JSON.parse(content); } catch { return undefined; }
  } else value = unwrapFeedbackEnvelope(content);
  return value && typeof value === "object" && !Array.isArray(value) && "status" in value
    ? (value as Record<string, unknown>)
    : undefined;
}

const adviceKeys = new Set(["guidance", "instruction", "recovery", "note"]);

/** Without long advice the model already read in an earlier result. */
function condensed(value: unknown, shown: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => condensed(item, shown));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([name, item]) => {
    if (adviceKeys.has(name) && typeof item === "string" && item.length >= 80) {
      if (shown.has(item)) return [];
      shown.add(item);
    }
    return [[name, condensed(item, shown)]];
  }));
}
