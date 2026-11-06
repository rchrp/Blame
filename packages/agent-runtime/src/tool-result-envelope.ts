type TextPart = { type: "text"; text: string };
type FieldPath = Array<string | number>;
const v1 = "blame_tool_result_v1";
const v2 = "blame_tool_result_v2";

// Text fields the model reads in a fence, as the source or output it holds,
// instead of as an escaped JSON string.
const textKeys = new Set(["content", "body", "context", "diagnostic", "imports", "signature", "snippet", "output", "message"]);
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

// Revision and check identities, and digests: journal bookkeeping the model
// never sends back, at 30 to 70 characters each.
const hashValue = /^(?:src_[0-9a-f]{32}|validation:\/\/[0-9a-f]{64}|(?:sha256:)?[0-9a-f]{64})$/u;

/**
 * A harness result as the model reads it, on every provider path: without
 * hash-only fields, and with each text field that JSON would escape in its own
 * fenced part after one JSON metadata line. Attachments (images) follow the
 * text parts. A result without such fields or attachments stays one object.
 */
export function encodeToolResult(result: Record<string, unknown>, attachments: unknown[] = []): unknown {
  const sections: Array<{ path: FieldPath; text: string }> = [];
  const metadata = detach(withoutHashes(result), [], sections);
  if (!sections.length && !attachments.length) return metadata;
  const header = { format: v2, result: metadata, sections: sections.map(({ path }) => path) };
  return [
    { type: "text", text: JSON.stringify(header) },
    ...sections.map(({ path, text }) => ({ type: "text", text: textSection(fieldLabel(path), text) })),
    ...attachments,
  ];
}

const v1Detachable = new Set(["output", "diagnostic", "content", "snippet", "message"]);

/**
 * The v1 envelope run_task used to return: harness tools now return
 * encodeToolResult's form. Kept for the feedback-delivery study controls
 * (tools/terminal_bench), which compare delivery shapes.
 */
export function feedbackEnvelope(result: unknown): unknown {
  if ((JSON.stringify(result)?.length ?? 0) <= 6_000) return result;
  const textFields: string[][] = [], parts: TextPart[] = [];
  const detachV1 = (value: unknown, path: string[]): unknown => {
    if (typeof value === "string" && v1Detachable.has(path.at(-1) ?? "")) {
      textFields.push(path);
      parts.push({ type: "text", text: value });
      return null;
    }
    if (Array.isArray(value)) return value.map((item, index) => detachV1(item, [...path, String(index)]));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, detachV1(item, [...path, key])]));
  };
  const metadata = detachV1(result, []);
  if (!parts.length) return result;
  return [{ type: "text", text: JSON.stringify({ format: v1, result: metadata, textFields }) }, ...parts];
}

function withoutHashes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutHashes);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([name, item]) =>
    /sha256$/iu.test(name) || (typeof item === "string" && hashValue.test(item)) ? [] : [[name, withoutHashes(item)]]));
}

function detach(value: unknown, path: FieldPath, sections: Array<{ path: FieldPath; text: string }>): unknown {
  if (Array.isArray(value)) return value.map((item, index) => detach(item, [...path, index], sections));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const field = [...path, key];
    if (textKeys.has(key) && typeof item === "string" && /[\\\n\r\t"]/u.test(item)) {
      sections.push({ path: field, text: item });
      return [key, reference(field)];
    }
    return [key, detach(item, field, sections)];
  }));
}

/** `data.segments[0].content`, as the model reads it. */
function fieldLabel(path: FieldPath) {
  return path.map((key, index) => typeof key === "number" ? `[${key}]` : index ? `.${key}` : key).join("");
}

function reference(path: FieldPath) {
  return `[see ${fieldLabel(path)}]`;
}

/** The label, then the text in a fence longer than any backtick run inside it. */
function textSection(label: string, text: string) {
  const runs = text.match(/`+/gu) ?? [];
  const fence = "`".repeat(runs.reduce((longest, run) => Math.max(longest, run.length + 1), 3));
  return `${label}:\n${fence}\n${text}\n${fence}`;
}

function sectionText(label: string, part: string) {
  const head = `${label}:\n`;
  if (!part.startsWith(head)) return undefined;
  const fence = /^`{3,}(?=\n)/u.exec(part.slice(head.length))?.[0];
  if (!fence) return undefined;
  const start = head.length + fence.length + 1, end = part.length - fence.length - 1;
  if (end < start || !part.endsWith(`\n${fence}`)) return undefined;
  return part.slice(start, end);
}

/**
 * Decodes only our typed multipart shapes (v2, and v1 from earlier
 * transcripts), never JSON found inside source or output. Anything else is
 * returned unchanged; attachments are not part of the decoded result.
 */
export function unwrapFeedbackEnvelope(value: unknown): unknown {
  if (!Array.isArray(value) || !isTextPart(value[0])) return value;
  let header: { format?: unknown; result?: unknown; textFields?: unknown; sections?: unknown };
  try { header = JSON.parse(value[0].text); } catch { return value; }
  if (!header || typeof header !== "object" || !header.result || typeof header.result !== "object") return value;
  if (header.format === v2) return decodeV2(value, header.result, header.sections) ?? value;
  if (header.format === v1) return decodeV1(value, header.result, header.textFields) ?? value;
  return value;
}

function decodeV2(value: unknown[], metadata: object, sections: unknown) {
  if (!Array.isArray(sections) || value.length < sections.length + 1 ||
      value.slice(sections.length + 1).some(isTextPart)) return undefined;
  const result = structuredClone(metadata);
  for (const [index, path] of sections.entries()) {
    const part = value[index + 1];
    if (!validPath(path) || !isTextPart(part)) return undefined;
    const label = fieldLabel(path);
    const text = sectionText(label, part.text);
    if (text === undefined || !assign(result, path, reference(path), text)) return undefined;
  }
  return result;
}

function decodeV1(value: unknown[], metadata: object, textFields: unknown) {
  if (!Array.isArray(textFields) || textFields.length !== value.length - 1) return undefined;
  const result = structuredClone(metadata);
  for (const [index, path] of textFields.entries()) {
    const part = value[index + 1];
    if (!validPath(path) || path.some((key) => typeof key !== "string") || !isTextPart(part) ||
        !assign(result, path, null, part.text)) return undefined;
  }
  return result;
}

function validPath(path: unknown): path is FieldPath {
  return Array.isArray(path) && path.length > 0 && path.length <= 20 && path.every((key) =>
    (typeof key === "string" && !unsafeKeys.has(key)) || (Number.isSafeInteger(key) && (key as number) >= 0));
}

/** Replaces the placeholder at `path` with `text`; false when the shape differs. */
function assign(result: object, path: FieldPath, placeholder: unknown, text: string) {
  let target: unknown = result;
  for (const key of path.slice(0, -1)) {
    target = child(target, key);
    if (!target || typeof target !== "object") return false;
  }
  const key = path.at(-1)!;
  if (child(target, key) !== placeholder) return false;
  (target as Record<string | number, unknown>)[key] = text;
  return true;
}

function child(target: unknown, key: string | number) {
  // v2 paths index arrays with numbers, v1 paths with digit strings.
  if (Array.isArray(target)) {
    const index = typeof key === "number" ? key : /^\d+$/u.test(key) ? Number(key) : -1;
    return index >= 0 && index < target.length ? target[index] : undefined;
  }
  if (typeof key === "number") return undefined;
  return target && typeof target === "object" && !Array.isArray(target) && Object.hasOwn(target, key)
    ? (target as Record<string, unknown>)[key]
    : undefined;
}

function isTextPart(part: unknown): part is TextPart {
  return !!part && typeof part === "object" && (part as TextPart).type === "text" && typeof (part as TextPart).text === "string";
}
