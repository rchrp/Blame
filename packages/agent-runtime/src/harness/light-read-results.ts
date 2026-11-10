import { type ParsedSymbol, symbolEditRange } from "./code-intelligence.js";
import type { LightToolResult } from "./light-contracts.js";
import { type EditTarget, symbolicPath } from "./light-navigation.js";
import { type ResolvedLightSymbol, SymbolResolutionError } from "./light-aliases.js";
import type { FoldPlan, RenderedFold } from "./light-fold-view.js";
import type { ByteInterval } from "./read-coverage.js";
import { lightCapabilityDescription, runtimeCapabilityRegistry } from "./light-capabilities.js";
import { isUtf8 } from "node:buffer";
import type { AgentToolContext } from "@cline/sdk";

export type ReadContext = Partial<AgentToolContext>;

export function directoryEntries(path: string, files: string[]) {
  const prefix = path === "." ? "" : `${path}/`;
  const entries = new Map<string, "directory" | "file">();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const [name, ...descendants] = file.slice(prefix.length).split("/");
    if (!name) continue;
    const child = `${prefix}${name}`;
    entries.set(child, descendants.length ? "directory" : "file");
  }
  return [...entries]
    .map(([target, kind]) => ({ kind, target }))
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.target.localeCompare(right.target),
    );
}

export function coveredDirectoryResult(
  path: string,
  receipt: string,
): LightToolResult<unknown> {
  return {
    status: "ok",
    data: {
      status: "already_in_context",
      target: path,
      path,
      view: "directory",
    },
    receipt,
  };
}

export function symbolContentResult(
  resolved: ResolvedLightSymbol,
  signature: ByteInterval,
  body: ByteInterval,
  imports: ReturnType<typeof shortImportBlock>,
  uncovered: ByteInterval[],
  receipt: string,
): LightToolResult<unknown> {
  return {
    status: "ok",
    receipt,
    data: {
      path: resolved.path,
      view: "symbol",
      alias: resolved.alias,
      editTarget: resolved.alias,
      kind: resolved.materialized.kind,
      qualifiedName: resolved.materialized.qualified_name,
      lines: resolved.symbol.line_range,
      ...symbolProjectedContent(resolved, signature, body, imports, uncovered),
    },
  };
}

function symbolProjectedContent(
  resolved: ResolvedLightSymbol,
  signature: ByteInterval,
  body: ByteInterval,
  imports: ReturnType<typeof shortImportBlock>,
  uncovered: ByteInterval[],
) {
  return {
    ...(rangeHasDelta(signature, uncovered)
      ? { signature: resolved.content.subarray(resolved.symbol.range_utf8_bytes[0], body[0]).toString("utf8") }
      : {}),
    ...(rangeHasDelta(body, uncovered)
      ? { body: resolved.content.subarray(body[0], resolved.symbol.range_utf8_bytes[1]).toString("utf8") }
      : {}),
    ...(imports && rangeHasDelta(imports.range, uncovered)
      ? { imports: imports.content }
      : {}),
  };
}

const foldGuidance =
  "Folded view: every line is the file's own except the ⋯ lines, each standing for hidden lines (line range, size in characters, sN alias, imported names the hidden code uses). " +
  "To see hidden code, read its sN alias or line range; range accepts up to 8 ranges in one call. Hidden lines are not observed edit coverage.";

export function foldedContentResult(
  path: string,
  content: Buffer,
  window: ByteInterval,
  view: RenderedFold,
  plan: FoldPlan,
  receipt: string,
  editTargets: EditTarget[],
): LightToolResult<unknown> {
  const whole = window[0] === 0 && window[1] === content.byteLength;
  return {
    status: "ok",
    receipt,
    data: {
      path,
      view: "folded",
      complete: false,
      ...(whole ? {} : { lines: intervalLines(content, window) }),
      folded: {
        shownCharacters: view.text.length,
        ofCharacters: content.subarray(...window).toString("utf8").length,
        hiddenParts: view.markers.length,
      },
      ...(plan.kept.length
        ? { keptWhole: plan.kept.slice(0, 4).map(({ lines, reason }) =>
            `L${lines[0] + 1}–${lines[1] + 1}: ${reason === "edited" ? "edited this session" : "search or check hit"}`) }
        : {}),
      content: view.text,
      ...(editTargets.length ? { editTargets } : {}),
      guidance: foldGuidance,
    },
  };
}

export function contentResult(
  path: string,
  content: Buffer,
  intervals: ByteInterval[],
  view: "range" | "raw",
  receipt: string,
  fallbackReason?: string,
  truncated = false,
  editTargets: EditTarget[] = [],
): LightToolResult<unknown> {
  const segments = intervals.map(([start, end]) => ({
    range: [start, end],
    lines: intervalLines(content, [start, end]),
    content: content.subarray(start, end).toString("utf8"),
  }));
  const projected =
    segments.length === 1 ? { lines: segments[0]!.lines, content: segments[0]!.content } : { segments };
  return {
    status: "ok",
    receipt,
    data: {
      path,
      view,
      complete:
        intervals.length === 1 &&
        intervals[0]![0] === 0 &&
        intervals[0]![1] === content.byteLength,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(editTargets.length ? { editTargets } : {}),
      ...projected,
      truncated,
      ...(truncated ? truncatedReadGuidance(path, content, intervals) : {}),
    },
  };
}

/** First and last line numbers covered by a byte interval, for range reads and edits. */
export function intervalLines(content: Buffer, [start, end]: ByteInterval): [number, number] {
  const first = newlineCount(content, 0, start) + 1;
  const trailing = end > start && content[end - 1] === 10 ? 1 : 0;
  return [first, Math.max(first, first + newlineCount(content, start, end) - trailing)];
}

function newlineCount(content: Buffer, start: number, end: number) {
  let count = 0;
  for (let index = content.indexOf(10, start); index >= 0 && index < end; index = content.indexOf(10, index + 1)) count += 1;
  return count;
}

function truncatedReadGuidance(path: string, content: Buffer, intervals: ByteInterval[]) {
  const end = Math.max(...intervals.map(([, stop]) => stop));
  // Include the last partial line again: neither byte limits nor UTF-8 may
  // skip source. Hints do not register additional observed coverage.
  const startLine = content.subarray(0, end).toString("utf8").split("\n").length;
  const totalLines = content.toString("utf8").split("\n").length;
  return {
    observedRangesUtf8Bytes: intervals,
    nextRead: { target: path, view: "range", range: { startLine, endLine: Math.min(totalLines, startLine + 79) } },
    alternativeReads: symbolicPath(path) ? [{ target: path, view: "outline" }] : [],
    guidance: "This read is truncated. Continue with nextRead (which repeats a partial boundary line), or inspect the outline and read a relevant symbol. Unseen bytes are not observed edit coverage. An explicit line range can exceed the inline byte limit for a very long line.",
  };
}

export function signatureRange(symbol: ParsedSymbol): ByteInterval {
  return symbolEditRange(symbol, "signature");
}

function rangesOverlap(left: ByteInterval, right: ByteInterval) {
  return left[0] < right[1] && right[0] < left[1];
}

function rangeHasDelta(range: ByteInterval, uncovered: ByteInterval[]) {
  return uncovered.some((candidate) => rangesOverlap(range, candidate));
}

export function capabilitiesResult(): LightToolResult<unknown> {
  return {
    status: "ok",
    data: {
      description: lightCapabilityDescription(),
      languages: runtimeCapabilityRegistry(),
    },
  };
}

export function lineByteRange(
  content: Buffer,
  startLine: number,
  endLine: number,
): [number, number] {
  const lines = content.toString("utf8").split(/(?<=\n)/u);
  if (startLine > lines.length)
    throw new Error("Range starts after the end of the file.");
  const start = Buffer.byteLength(lines.slice(0, startLine - 1).join(""));
  const end = Buffer.byteLength(
    lines.slice(0, Math.min(endLine, lines.length)).join(""),
  );
  return [start, end];
}

export function shortImportBlock(source: string) {
  const expression =
    /^\s*(?:import\b|from\b|use\b|package\b|using\b|#include\b)/u;
  const lines = source.split(/(?<=\n)/u).slice(0, 40);
  const offsets = lines.reduce<number[]>((values, line) => {
    values.push((values.at(-1) ?? 0) + line.length);
    return values;
  }, []);
  const selected = lines.flatMap((line, index) =>
    expression.test(line) ? [index] : [],
  );
  if (!selected.length) return undefined;
  const start = selected[0] === 0 ? 0 : offsets[selected[0]! - 1]!;
  const end = offsets[selected.at(-1)!]!;
  const content = source.slice(start, end);
  if (content.length > 2_000) return undefined;
  return {
    content,
    range: [
      Buffer.byteLength(source.slice(0, start)),
      Buffer.byteLength(source.slice(0, end)),
    ] as ByteInterval,
  };
}

export function contextGeneration(context: ReadContext) {
  const metadata = context.metadata ?? {};
  const generation = metadata.contextGeneration ?? metadata.contextEpoch;
  if (typeof generation === "string" || typeof generation === "number")
    return String(generation);
  const summary = [...(context.snapshot?.messages ?? [])]
    .reverse()
    .find((message) => message.metadata?.kind === "compaction_summary");
  return summary ? `compaction:${summary.id}` : "initial";
}

export function inputBlocked(error: unknown): Extract<LightToolResult<unknown>, { status: "blocked" }> {
  const diagnosticId = `read-${Date.now().toString(36)}`;
  const message = error instanceof Error ? error.message : String(error);
  const recovery =
    error instanceof SymbolResolutionError && error.candidates.length
      ? JSON.stringify(error.candidates)
      : undefined;
  return {
    status: "blocked",
    category: "input",
    message,
    diagnosticId,
    ...(recovery ? { recovery } : {}),
  };
}

export function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function readableSource(content: Buffer) {
  if (content.includes(0) || !isUtf8(content) || content.subarray(0, 5).toString("ascii") === "%PDF-")
    throw new Error("Binary or PDF content is not source text. Read PDF, DOCX and XLSX documents with read_attachment; for other binary files, use run_task to extract text, then read the output.");
  return content.toString("utf8");
}
