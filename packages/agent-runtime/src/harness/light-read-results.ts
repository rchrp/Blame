import { outlineSymbol, type ParsedSymbol, symbolEditRange } from "./code-intelligence.js";
import type { LightReadCodeInput, LightToolResult } from "./light-contracts.js";
import { type EditTarget, outlineCandidates, symbolicPath } from "./light-navigation.js";
import { type ResolvedLightSymbol, SymbolResolutionError } from "./light-aliases.js";
import type { ByteInterval } from "./read-coverage.js";
import type { LightAliasRegistry } from "./light-aliases.js";
import type { WorkspaceFiles } from "./workspace-files.js";
import { firstTermIndex, lineRange, matchedTerm, pathMatches, searchTerms, sourceLine } from "./light-navigation.js";
import { lightCapabilityDescription, runtimeCapabilityRegistry } from "./light-capabilities.js";
import { isUtf8 } from "node:buffer";
import type { AgentToolContext } from "@cline/sdk";

export type ReadContext = Partial<AgentToolContext>;

export function outlineRangeCandidates(
  symbols: ParsedSymbol[],
  range?: LightReadCodeInput["range"],
) {
  const candidates = outlineCandidates(symbols);
  if (!range) return candidates;
  return candidates.filter(
    ({ line_range: [start, end] }) =>
      start <= range.endLine && end >= range.startLine,
  );
}

export function enclosingOutlineTarget(
  symbol: ParsedSymbol,
  candidates: Array<{ alias: string; symbol: ParsedSymbol }>,
) {
  return candidates
    .filter(
      ({ symbol: candidate }) =>
        candidate !== symbol &&
        candidate.range_utf8_bytes[0] <= symbol.range_utf8_bytes[0] &&
        candidate.range_utf8_bytes[1] >= symbol.range_utf8_bytes[1],
    )
    .sort(
      (left, right) => byteLength(left.symbol) - byteLength(right.symbol),
    )[0];
}

function byteLength(symbol: ParsedSymbol) {
  return symbol.range_utf8_bytes[1] - symbol.range_utf8_bytes[0];
}

export function emptyOutline(path: string): LightToolResult<unknown> {
  return {
    status: "ok",
    data: { path, view: "outline", items: [], truncated: false },
  };
}

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

export function outlineResult(
  path: string,
  items: unknown[],
  total: number,
  receipt: string,
  editTargets: EditTarget[],
): LightToolResult<unknown> {
  return {
    status: "ok",
    receipt,
    data: {
      path,
      view: "outline",
      items,
      editTargets,
      truncated: total > items.length,
    },
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
    content: content.subarray(start, end).toString("utf8"),
  }));
  const projected =
    segments.length === 1 ? { content: segments[0]!.content } : { segments };
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
    throw new Error("Binary or PDF content is not source text. Use run_task to extract text or render images, then read the output.");
  return content.toString("utf8");
}

export async function nodeTextSearch(
  files: WorkspaceFiles,
  aliases: LightAliasRegistry,
  query: string,
  candidates: string[],
  signal?: AbortSignal,
) {
  const results: unknown[] = [];
  const terms = searchTerms(query);
  for (const path of candidates) {
    signal?.throwIfAborted();
    if (results.length >= 8) break;
    if (await files.fileSize(path) > 2 * 1024 * 1024) continue;
    const content = (await files.read(path)).content;
    const source = content.toString("utf8");
    const index = firstTermIndex(source, terms, query);
    if (index < 0) continue;
    const matched = matchedTerm(source, index, terms, query);
    const start = Buffer.byteLength(source.slice(0, index));
    const range: [number, number] = [
      start,
      start + Buffer.byteLength(matched),
    ];
    results.push({
      alias: aliases.registerRange(path, content, range),
      kind: "text",
      path,
      lines: lineRange(content, range),
      snippet: sourceLine(source, index),
      reason: terms.length > 1 ? "lexical_regex" : "lexical_exact",
    });
  }
  return results;
}

export function pathSearch(aliases: LightAliasRegistry, query: string, candidates: string[]) {
  return pathMatches(query, candidates).map((path) => ({
    alias: aliases.registerPath(path),
    kind: "path",
    path,
    reason: "path_name",
    target: path,
  }));
}

export function outlineItems(
  aliases: LightAliasRegistry,
  path: string,
  content: Buffer,
  symbols: ParsedSymbol[],
  revision: string,
) {
  const registered = symbols.map((symbol) => {
    const { alias, materialized } = aliases.registerSymbol(path, content, symbol, revision);
    return { alias, materialized, symbol };
  });
  return registered.map(({ alias, materialized, symbol }) => {
    const parent = enclosingOutlineTarget(symbol, registered);
    return {
      alias,
      ...outlineSymbol(materialized),
      ...(parent ? { containedBy: parent.alias } : {}),
    };
  });
}
