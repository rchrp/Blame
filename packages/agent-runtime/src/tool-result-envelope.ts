type TextPart = { type: "text"; text: string };
const format = "blame_tool_result_v1";
const detachable = new Set(["output", "diagnostic", "content", "snippet", "message"]);

/** Keep structured feedback in its own SDK text part; other parts may be clipped. */
export function feedbackEnvelope(result: unknown): unknown {
  if ((JSON.stringify(result)?.length ?? 0) <= 6_000) return result;
  const textFields: string[][] = [], parts: TextPart[] = [];
  const detach = (value: unknown, path: string[]): unknown => {
    if (typeof value === "string" && detachable.has(path.at(-1) ?? "")) {
      textFields.push(path);
      parts.push({ type: "text", text: value });
      return null;
    }
    if (Array.isArray(value)) return value.map((item, index) => detach(item, [...path, String(index)]));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, detach(item, [...path, key])]));
  };
  const metadata = detach(result, []);
  if (!parts.length) return result;
  return [{ type: "text", text: JSON.stringify({ format, result: metadata, textFields }) }, ...parts];
}

/** Decode only our typed multipart shape, never JSON found inside source/output. */
export function unwrapFeedbackEnvelope(value: unknown): unknown {
  if (!Array.isArray(value) || value[0]?.type !== "text" || typeof value[0].text !== "string") return value;
  let header: { format?: string; result?: unknown; textFields?: unknown };
  try { header = JSON.parse(value[0].text); } catch { return value; }
  if (!header || header.format !== format || !Array.isArray(header.textFields) ||
      header.textFields.length !== value.length - 1 || !header.result || typeof header.result !== "object") return value;
  const result = structuredClone(header.result);
  for (const [index, path] of header.textFields.entries()) {
    if (!Array.isArray(path) || !path.length || path.length > 20 ||
        path.some(key => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) ||
        value[index + 1]?.type !== "text" || typeof value[index + 1]?.text !== "string") return value;
    let target = result as Record<string, unknown>;
    for (const key of path.slice(0, -1)) {
      if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== "object") return value;
      target = target[key] as Record<string, unknown>;
    }
    const key = path.at(-1)!;
    if (!Object.hasOwn(target, key) || target[key] !== null) return value;
    target[key] = value[index + 1].text;
  }
  return result;
}
