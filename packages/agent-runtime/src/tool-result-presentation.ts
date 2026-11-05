import type { ContentBlock, Message } from "@cline/sdk";
import { projectImageContext } from "./image-context.js";
import { compactRepairAdvice } from "./repair-advice-projection.js";

const harnessNames = new Set(["read_code", "search_code", "edit_code", "run_task"]);
const textKeys = new Set(["content", "body", "context", "imports", "signature", "snippet", "output", "message"]);

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

// Cline's message builder cuts the middle out of any tool-result text block
// over 8,000 characters. Harness results bound their own size (a raw read
// holds up to 64,000), so they reach the model whole, in blocks under that cut.
const clineBlockCharacters = 8_000;

function presentBlock(block: ContentBlock, names: Map<string, string>): ContentBlock {
  if (block.type !== "tool_result" || typeof block.content !== "string") return block;
  if (!harnessNames.has(names.get(block.tool_use_id) ?? block.name ?? "")) return block;
  const text = presentedText(block.content) ?? block.content;
  const chunks = textChunks(text, clineBlockCharacters);
  if (chunks.length > 1)
    return { ...block, content: chunks.map((chunk) => ({ type: "text" as const, text: chunk })) };
  return text === block.content ? block : { ...block, content: text };
}

/** Metadata as one JSON line, then each source text field in its own fence. */
function presentedText(source: string) {
  let result: unknown;
  try { result = JSON.parse(source); } catch { return undefined; }
  if (!result || typeof result !== "object" || !('status' in result)) return undefined;
  const sections: string[] = [];
  const metadata = extractText(result, "", sections);
  if (!sections.length) return undefined;
  return [JSON.stringify(metadata), ...sections].join("\n\n");
}

/** Splits after a newline where it can, so only a line longer than a block is cut. */
export function textChunks(text: string, size: number) {
  const chunks: string[] = [];
  let start = 0;
  while (text.length - start > size) {
    const newline = text.lastIndexOf("\n", start + size - 1);
    const end = newline >= start ? newline + 1 : start + size;
    chunks.push(text.slice(start, end));
    start = end;
  }
  chunks.push(text.slice(start));
  return chunks;
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
