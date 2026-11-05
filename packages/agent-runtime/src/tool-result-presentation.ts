import type { ContentBlock, Message } from "@cline/sdk";
import { projectImageContext } from "./image-context.js";
import { compactRepairAdvice } from "./repair-advice-projection.js";
import { unwrapFeedbackEnvelope } from "./tool-result-envelope.js";

const harnessNames = new Set(["read_code", "search_code", "edit_code", "run_task"]);
const textKeys = new Set(["content", "body", "context", "imports", "signature", "snippet", "output", "message"]);

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

// Cline's message builder cuts the middle out of any tool-result text block
// over 8,000 characters. Harness results bound their own size (a raw read
// holds up to 64,000), so they reach the model whole, in blocks under that cut.
const clineBlockCharacters = 8_000;

function presentBlock(block: ContentBlock, names: Map<string, string>, shown: Set<string>): ContentBlock {
  if (block.type !== "tool_result") return block;
  if (!harnessNames.has(names.get(block.tool_use_id) ?? block.name ?? "")) return block;
  const result = harnessResult(block.content);
  if (result) return withText(block, presentedText(condensed(result, shown) as Record<string, unknown>));
  return typeof block.content === "string" ? withText(block, block.content) : block;
}

/** A harness result, from its JSON text or from run_task's multipart envelope. */
function harnessResult(content: unknown) {
  let value: unknown;
  if (typeof content === "string") {
    try { value = JSON.parse(content); } catch { return undefined; }
  } else value = unwrapFeedbackEnvelope(content);
  return value && typeof value === "object" && !Array.isArray(value) && "status" in value
    ? (value as Record<string, unknown>)
    : undefined;
}

function withText(block: Extract<ContentBlock, { type: "tool_result" }>, text: string): ContentBlock {
  const chunks = textChunks(text, clineBlockCharacters);
  if (chunks.length > 1)
    return { ...block, content: chunks.map((chunk) => ({ type: "text" as const, text: chunk })) };
  return text === block.content ? block : { ...block, content: text };
}

/** Metadata as one JSON line, then each source text field in its own fence. */
function presentedText(result: Record<string, unknown>) {
  const sections: string[] = [];
  const metadata = extractText(result, "", sections);
  return [JSON.stringify(metadata), ...sections].join("\n\n");
}

// Revision and check identities, and digests: journal bookkeeping the model
// never sends back, at 30 to 70 characters each.
const hashValue = /^(?:src_[0-9a-f]{32}|validation:\/\/[0-9a-f]{64}|(?:sha256:)?[0-9a-f]{64})$/u;
const adviceKeys = new Set(["guidance", "instruction", "recovery", "note"]);

/**
 * What the model reads of a harness result: without hash-only fields, and
 * without long advice it already read in an earlier result.
 */
function condensed(value: unknown, shown: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => condensed(item, shown));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([name, item]) => {
    if (/sha256$/iu.test(name) || (typeof item === "string" && hashValue.test(item))) return [];
    if (adviceKeys.has(name) && typeof item === "string" && item.length >= 80) {
      if (shown.has(item)) return [];
      shown.add(item);
    }
    return [[name, condensed(item, shown)]];
  }));
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
