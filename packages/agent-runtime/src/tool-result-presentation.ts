import type { ContentBlock, Message } from "@cline/sdk";
import { projectImageContext } from "./image-context.js";
import { compactRepairAdvice } from "./repair-advice-projection.js";

const harnessNames = new Set(["read_code", "search_code", "edit_code", "run_task"]);
const textKeys = new Set(["content", "body", "imports", "signature", "snippet", "output", "message"]);

export function presentToolResults(messages: Message[]): Message[] {
  const names = new Map<string, string>();
  const source = process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION === "true" ? compactRepairAdvice(messages) : messages;
  const presented = source.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map((block: ContentBlock) => {
      if (block.type === "tool_use") names.set(block.id, block.name);
      return presentBlock(block, names);
    });
    return { ...message, content };
  });
  return projectImageContext(presented);
}

function presentBlock(block: ContentBlock, names: Map<string, string>): ContentBlock {
  if (block.type !== "tool_result" || typeof block.content !== "string") return block;
  if (!harnessNames.has(names.get(block.tool_use_id) ?? block.name ?? "")) return block;
  let result: unknown;
  try { result = JSON.parse(block.content); } catch { return block; }
  if (!result || typeof result !== "object" || !('status' in result)) return block;
  const sections: string[] = [];
  const metadata = extractText(result, "", sections);
  if (!sections.length) return block;
  return { ...block, content: [JSON.stringify(metadata), ...sections].join("\n\n") };
}

function extractText(value: unknown, path: string, sections: string[]): unknown {
  if (Array.isArray(value))
    return value.map((item, index) => extractText(item, `${path}[${index}]`, sections));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const field = path ? `${path}.${key}` : key;
    if (textKeys.has(key) && typeof item === "string" && /[\\\n\r\t"]/u.test(item)) {
      sections.push(textSection(field, item));
      return [];
    }
    return [[key, extractText(item, field, sections)]];
  }));
}

function textSection(field: string, source: string) {
  const runs = source.match(/`+/gu) ?? [];
  const length = runs.reduce((maximum, run) => Math.max(maximum, run.length + 1), 3);
  const fence = "`".repeat(length);
  return `${field}:\n${fence}\n${source}\n${fence}`;
}
