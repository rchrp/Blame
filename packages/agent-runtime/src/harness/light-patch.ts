import { computePatchChanges, PatchActionType } from "@cline/sdk";
import type { PatchFileChange } from "@cline/sdk";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffLines } from "diff";

export type LightPatchReplacement = {
  end: number;
  replacement: string;
  start: number;
};

export type LightPatchPlan =
  | { mode: "add"; content: string }
  | { mode: "delete" }
  | { mode: "update"; replacements: LightPatchReplacement[] };

export type LightPatchOperation = { patch: string; path: string };

/** Use the same exact hunk resolver on a bounded source, without filesystem IO. */
export function planScopedLightPatch(source: string, patch: string, path: string) {
  const parsed = parseClinePatchShape(patch);
  if (parsed.mode !== "update") throw new Error("A scoped patch requires one Update File.");
  const normalized = source.replaceAll("\r\n", "\n");
  const exact = exactContextPatch(normalized, parsed, path);
  const hunks = patchHunks(exact.lines.slice(exact.headerIndex + 1, -1));
  let cursor = 0;
  let output = "";
  for (const hunk of hunks) {
    const before = selectedLines(hunk.lines, new Set([" ", "-"]));
    const after = selectedLines(hunk.lines, new Set([" ", "+"]));
    const start = normalized.indexOf(before, cursor);
    if (start !== cursor) throw new Error("Scoped patch context does not match.");
    output += after;
    cursor = start + before.length;
    if (normalized[cursor] === "\n") { output += "\n"; cursor += 1; }
  }
  output += normalized.slice(cursor);
  const originalBytes = Buffer.from(source);
  const offsets: number[] = [];
  for (let index = 0; index < originalBytes.length; index++) {
    offsets.push(index);
    if (originalBytes[index] === 13 && originalBytes[index + 1] === 10) index++;
  }
  offsets.push(originalBytes.length);
  return changedRanges(normalized, output).map((replacement) => {
    const start = offsets[replacement.start]!;
    const end = offsets[replacement.end]!;
    const lineEnd = originalBytes.indexOf(10, start);
    const crlf = lineEnd > 0 && originalBytes[lineEnd - 1] === 13;
    return { start, end, replacement: crlf ? replacement.replacement.replaceAll("\n", "\r\n") : replacement.replacement };
  });
}

type PatchHunk = { anchor?: string; lines: string[]; eof?: boolean };

type ParsedPatch = {
  headerIndex: number;
  hunks: PatchHunk[];
  mode: "add" | "delete" | "update";
  lines: string[];
};

export function splitLightPatch(
  patch: string,
  requestedPath?: string,
): LightPatchOperation[] {
  const lines = normalizedPatchLines(patch, requestedPath);
  assertPatchEnvelope(lines);
  const headers = patchHeaders(lines);
  if (!headers.length) throw new Error("Patch contains no file operation.");
  if (headers.length > 50) throw new Error("Patch contains too many files.");
  assertEmptyPatchPrefix(lines, headers[0]!.index);
  return headers.map((header, index) => {
    const end = headers[index + 1]?.index ?? lines.length - 1;
    const path = header.path;
    const section = [
      "*** Begin Patch",
      ...lines.slice(header.index, end),
      "*** End Patch",
    ];
    return { path, patch: section.join("\n") };
  });
}

function normalizedPatchLines(patch: string, requestedPath?: string) {
  let lines = patch.trimEnd().split(/\r?\n/u);
  if (hasBareFileEnvelope(lines)) lines = ["*** Begin Patch", ...lines];
  if (requestedPath && hasLeadingUpdateHunk(lines)) {
    assertSingleLinePath(requestedPath);
    lines.splice(1, 0, `*** Update File: ${requestedPath}`);
  } else if (requestedPath && hasLeadingAddBody(lines)) {
    assertSingleLinePath(requestedPath);
    lines.splice(1, 0, `*** Add File: ${requestedPath}`);
  }
  return lines;
}

function hasBareFileEnvelope(lines: string[]) {
  return (
    /^\*\*\* (?:Add|Delete|Update) File:\s*.+$/u.test(lines[0] ?? "") &&
    lines.at(-1) === "*** End Patch"
  );
}

function hasLeadingUpdateHunk(lines: string[]) {
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch")
    return false;
  const firstContent = lines.findIndex(
    (line, index) => index > 0 && line.trim().length > 0,
  );
  const firstHeader = patchHeaders(lines)[0]?.index ?? lines.length - 1;
  return (
    firstContent > 0 &&
    firstContent < firstHeader &&
    lines[firstContent]?.startsWith("@@")
  );
}

function hasLeadingAddBody(lines: string[]) {
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch")
    return false;
  const firstHeader = patchHeaders(lines)[0]?.index ?? lines.length - 1;
  const leadingBody = lines.slice(1, firstHeader);
  return (
    leadingBody.length > 0 && leadingBody.every((line) => line.startsWith("+"))
  );
}

function assertSingleLinePath(path: string) {
  if (/[\r\n]/u.test(path)) throw new Error("Patch path must be one line.");
}

export async function planLightPatch(
  workspaceRoot: string,
  path: string,
  source: string | undefined,
  patch: string,
) {
  const parsed = normalizedMissingTargetAddition(
    parseClinePatchShape(patch),
    source,
  );
  // Cline refuses to add over a file that exists on disk. applyPatchPlan
  // decides from the planned state instead, so a file deleted earlier in the
  // same batch can be re-added.
  const exact = exactContextPatch(source, parsed, path);
  const normalized = normalizedPatch(exact, path);
  const root = parsed.mode === "add" ? await emptyPatchRoot() : workspaceRoot;
  const change = await computeSingleChange(normalized, root);
  return patchPlanFromChange(change, source);
}

let emptyRoot: Promise<string> | undefined;

/** An additions-only root: Add File content never depends on existing files. */
function emptyPatchRoot() {
  emptyRoot ??= mkdtemp(join(tmpdir(), "blame-patch-add-"));
  return emptyRoot;
}

function normalizedMissingTargetAddition(
  parsed: ParsedPatch,
  source: string | undefined,
): ParsedPatch {
  if (
    source !== undefined ||
    parsed.mode !== "update" ||
    parsed.hunks.length === 0 ||
    parsed.hunks.some(
      (hunk) =>
        hunk.lines.length === 0 ||
        hunk.lines.some((line) => !line.startsWith("+")),
    )
  )
    return parsed;
  return {
    ...parsed,
    lines: parsed.lines.filter((line) => !line.startsWith("@@")),
    mode: "add",
  };
}

async function computeSingleChange(patch: string, workspaceRoot: string) {
  const computed = await computePatchChanges(patch, workspaceRoot, {
    restrictToCwd: true,
  });
  if (computed.fuzz !== 0) throw new Error("Patch context is not exact.");
  const entries = Object.entries(computed.changes) as Array<
    [string, PatchFileChange]
  >;
  if (entries.length !== 1)
    throw new Error("Each patch operation must contain exactly one file.");
  const change = entries[0]![1];
  if (change.movePath)
    throw new Error("Represent moves as add and delete operations.");
  return change;
}

function patchPlanFromChange(
  change: PatchFileChange,
  source: string | undefined,
): LightPatchPlan {
  if (change.type === PatchActionType.ADD)
    return { mode: "add", content: change.newContent ?? "" };
  if (change.type === PatchActionType.DELETE) return { mode: "delete" };
  if (source === undefined)
    throw new Error("Patch update target does not exist.");
  return {
    mode: "update",
    replacements: changedRanges(
      source,
      preservePatchLineEndings(source, change.newContent ?? ""),
    ),
  };
}

function preservePatchLineEndings(source: string, content: string) {
  const uniformCrlf =
    source.includes("\r\n") && !/(?<!\r)\n/u.test(source);
  return uniformCrlf ? content.replace(/\r?\n/gu, "\r\n") : content;
}

function parseClinePatchShape(patch: string): ParsedPatch {
  const lines = patch.trimEnd().split(/\r?\n/u);
  assertPatchEnvelope(lines);
  const headerIndexes = patchHeaders(lines).map(({ index }) => index);
  if (headerIndexes.length !== 1)
    throw new Error("Each patch operation must contain exactly one file.");
  const headerIndex = headerIndexes[0]!;
  const action = lines[headerIndex]!.match(
    /^\*\*\* (Add|Delete|Update) File:/u,
  )?.[1];
  if (!action) throw new Error("Patch file operation is invalid.");
  return {
    headerIndex,
    hunks: patchHunks(lines.slice(headerIndex + 1, -1)),
    lines,
    mode: action.toLowerCase() as ParsedPatch["mode"],
  };
}

function assertPatchEnvelope(lines: string[]) {
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch")
    throw new Error("Patch must use the Cline Apply Patch format.");
}

function patchHeaders(lines: string[]) {
  return lines.flatMap((line, index) => {
    const match = line.match(/^\*\*\* (?:Add|Delete|Update) File:\s*(.+)$/u);
    const path = match?.[1]?.trim();
    return path ? [{ index, path }] : [];
  });
}

function assertEmptyPatchPrefix(lines: string[], firstHeader: number) {
  const prefix = lines.slice(1, firstHeader);
  if (prefix.some((line) => line.trim()))
    throw new Error("Patch contains content before its first file operation.");
}

function patchHunks(lines: string[]) {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { lines: [], anchor: line.slice(2).trim() || undefined };
      hunks.push(current);
    } else if (line === "*** End of File" && current) current.eof = true;
    else {
      if (!current) hunks.push((current = { lines: [] }));
      current.lines.push(patchBodyLine(line));
    }
  }
  return hunks;
}

function patchBodyLine(line: string) {
  if (line === "") return " ";
  if (!/^[ +-]/u.test(line))
    throw new Error("Patch hunk lines must start with a space, +, or -.");
  return line;
}

function exactContextPatch(
  source: string | undefined,
  parsed: ParsedPatch,
  path: string,
) {
  if (parsed.mode !== "update") return parsed;
  if (source === undefined)
    throw new Error("Patch update target does not exist.");
  source = source.replaceAll("\r\n", "\n");
  const lines = parsed.lines.slice(0, parsed.headerIndex + 1);
  const ordered = orderedHunkRanges(source, parsed.hunks, path);
  const repeated = singleRepeatedLineRange(source, parsed.hunks);
  let cursor = 0;
  for (const [index, hunk] of parsed.hunks.entries()) {
    const range =
      ordered?.[index] ?? repeated ?? exactHunkRange(source, hunk, cursor, path);
    const prefix = source
      .slice(cursor, range.start)
      .split("\n")
      .slice(0, -1);
    lines.push("@@", ...prefix.map((line) => ` ${line}`), ...hunk.lines);
    cursor = range.end + 1;
  }
  lines.push("*** End Patch");
  return { ...parsed, lines };
}

function orderedHunkRanges(
  source: string,
  hunks: PatchHunk[],
  path: string,
) {
  if (hunks.length < 2 || hunks.some((hunk) => hunk.anchor || hunk.eof))
    return undefined;
  const contexts = hunks.map((hunk) =>
    selectedLines(hunk.lines, new Set([" ", "-"])),
  );
  if (contexts.some((context) => !context))
    throw new Error("Update hunks require exact context.");
  const earliest = directionalHunkRanges(source, contexts, path, false);
  const latest = directionalHunkRanges(source, contexts, path, true);
  const ambiguous = earliest.findIndex(
    (range, index) => range.start !== latest[index]!.start &&
      contexts[index] !== selectedLines(hunks[index]!.lines, new Set([" ", "+"])),
  );
  if (ambiguous >= 0)
    throw new Error(
      patchContextFailure(path, source, contexts[ambiguous]!,
        lineBoundedMatches(source, contexts[ambiguous]!, earliest[ambiguous]!.start)),
    );
  return earliest;
}

function singleRepeatedLineRange(source: string, hunks: PatchHunk[]) {
  if (hunks.length !== 1) return undefined;
  const hunk = hunks[0]!;
  const value = hunk.lines[0]?.slice(1);
  if (hunk.anchor || hunk.eof || !value ||
    hunk.lines.some((line) => line.slice(1) !== value)) return undefined;
  const context = selectedLines(hunk.lines, new Set([" ", "-"]));
  if (!context) return undefined;
  const matches = lineBoundedMatches(source, context);
  const first = matches[0];
  if (first === undefined) return undefined;
  const range = { start: first, end: first + context.length };
  if (matches.length === 1) return range;
  const last = lastLineBoundedMatch(source, context, source.length)!;
  const span = source.slice(first, last + context.length);
  return span.split("\n").every((line) => line === value) ? range : undefined;
}

function directionalHunkRanges(
  source: string,
  contexts: string[],
  path: string,
  reverse: boolean,
) {
  let cursor = reverse ? source.length : 0;
  const ordered = reverse ? [...contexts].reverse() : contexts;
  const ranges = ordered.map((context) => {
    const start = reverse
      ? lastLineBoundedMatch(source, context, cursor)
      : lineBoundedMatches(source, context, cursor)[0];
    if (start === undefined)
      throw new Error(patchContextFailure(path, source, context, []));
    const end = start + context.length;
    cursor = reverse ? start - 1 : end + 1;
    return { start, end };
  });
  return reverse ? ranges.reverse() : ranges;
}

function lastLineBoundedMatch(source: string, value: string, end: number) {
  let cursor = end - value.length;
  while (cursor >= 0) {
    const index = source.lastIndexOf(value, cursor);
    if (index < 0) return undefined;
    if (lineBoundary(source, index, index + value.length)) return index;
    cursor = index - 1;
  }
  return undefined;
}

function exactHunkRange(
  source: string,
  hunk: PatchHunk,
  cursor: number,
  path: string,
) {
  if (hunk.anchor) {
    const anchors = anchorMatches(source, hunk.anchor, cursor);
    if (anchors.length !== 1)
      throw new Error(patchContextFailure(path, source, hunk.anchor, anchors));
    cursor = source.indexOf("\n", anchors[0]!);
    cursor = cursor < 0 ? source.length : cursor + 1;
  }
  const context = selectedLines(hunk.lines, new Set([" ", "-"]));
  if (!context) throw new Error("Update hunks require exact context.");
  const start = hunk.eof
    ? source.replace(/\n$/u, "").length - context.length
    : cursor;
  const matches = lineBoundedMatches(source, context, Math.max(cursor, start));
  if (!matches.length || (!hunk.anchor && !hunk.eof && matches.length !== 1))
    throw new Error(patchContextFailure(path, source, context, matches));
  return { start: matches[0]!, end: matches[0]! + context.length };
}

function anchorMatches(source: string, anchor: string, start: number) {
  const matches: number[] = [];
  let cursor = 0;
  for (const line of source.split("\n")) {
    if (cursor >= start && line.trim() === anchor) matches.push(cursor);
    if (matches.length > 1) break;
    cursor += line.length + 1;
  }
  return matches;
}

function patchContextFailure(
  path: string,
  source: string,
  expected: string,
  matches: number[],
) {
  if (matches.length) {
    const lines = matches.map((offset) => lineNumberAt(source, offset));
    return [
      `Patch context is ambiguous in ${path} at lines ${lines.join(", ")}.`,
      ...matches.slice(0, 4).map((offset, index) =>
        patchCandidateContext(source, offset, matches[index - 1])),
      "Include the distinguishing context in the hunk or use a unique @@ anchor.",
    ].join("\n");
  }
  const closest = closestCurrentContext(source, expected);
  return [
    `Patch context does not match in ${path}.`,
    `Closest current lines ${closest.startLine}-${closest.endLine}:`,
    closest.content,
  ].join("\n");
}

function patchCandidateContext(source: string, offset: number, previousOffset?: number) {
  const lines = source.split("\n");
  const index = lineNumberAt(source, offset) - 1;
  const start = Math.max(0, index - 3);
  const end = Math.min(lines.length, index + 4);
  const content = lines.slice(start, end).join("\n");
  const previous = previousOffset === undefined ? -1 : lineNumberAt(source, previousOffset) - 1;
  const anchor = precedingUniqueAnchor(lines, index, previous);
  return [
    `Candidate at line ${index + 1}, context ${start + 1}-${end}:\n${content.slice(0, 1_200)}`,
    ...(anchor ? [`Unique preceding anchor at line ${anchor.line}:\n@@ ${anchor.text}`] : []),
  ].join("\n");
}

function precedingUniqueAnchor(lines: string[], index: number, previous: number) {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line.trim(), (counts.get(line.trim()) ?? 0) + 1);
  for (let candidate = index - 1; candidate > previous; candidate -= 1) {
    const text = lines[candidate]!.trim();
    if (text && text.length <= 300 && counts.get(text) === 1)
      return { line: candidate + 1, text };
  }
  return undefined;
}

function closestCurrentContext(source: string, expected: string) {
  const sourceLines = source.split(/\r?\n/u);
  const expectedLines = expected
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .sort((left, right) => right.trim().length - left.trim().length)
    .slice(0, 8);
  const index = closestLineIndex(sourceLines, expectedLines);
  const start = Math.max(0, index - 2);
  const end = Math.min(sourceLines.length, index + 3);
  return {
    content: sourceLines.slice(start, end).join("\n").slice(0, 2_000),
    startLine: start + 1,
    endLine: end,
  };
}

function closestLineIndex(source: string[], expected: string[]) {
  let bestIndex = 0;
  let bestScore = -1;
  source.forEach((candidate, index) => {
    const score = Math.max(
      0,
      ...expected.map((line) => lineSimilarity(candidate, line)),
    );
    if (score <= bestScore) return;
    bestIndex = index;
    bestScore = score;
  });
  return bestIndex;
}

function lineSimilarity(left: string, right: string) {
  const candidate = left.trim().slice(0, 500);
  const expected = right.trim().slice(0, 500);
  if (!candidate || !expected) return 0;
  const containment =
    Math.min(candidate.length, expected.length) >= 12 &&
    (candidate.includes(expected) || expected.includes(candidate))
      ? 1_000
      : 0;
  const words = new Set(expected.match(/[\p{L}\p{N}_$]+/gu) ?? []);
  const overlap = (candidate.match(/[\p{L}\p{N}_$]+/gu) ?? []).filter((word) =>
    words.has(word),
  ).length;
  return (
    containment + commonPrefixLength(candidate, expected) * 4 + overlap * 20
  );
}

function commonPrefixLength(left: string, right: string) {
  const maximum = Math.min(left.length, right.length);
  let index = 0;
  while (index < maximum && left[index] === right[index]) index += 1;
  return index;
}

function lineNumberAt(source: string, offset: number) {
  return source.slice(0, offset).split("\n").length;
}

function normalizedPatch(parsed: ParsedPatch, path: string) {
  const lines = [...parsed.lines];
  const label = `${parsed.mode[0]!.toUpperCase()}${parsed.mode.slice(1)}`;
  lines[parsed.headerIndex] = `*** ${label} File: ${path}`;
  return lines.join("\n");
}

function changedRanges(before: string, after: string) {
  const replacements: Array<{
    end: number;
    replacement: string;
    start: number;
  }> = [];
  let cursor = 0;
  let pending: { end: number; replacement: string; start: number } | undefined;
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) {
      if (pending) replacements.push(minimalReplacement(before, pending));
      pending = undefined;
      cursor += part.value.length;
      continue;
    }
    pending ??= { start: cursor, end: cursor, replacement: "" };
    if (part.removed) {
      cursor += part.value.length;
      pending.end = cursor;
    } else pending.replacement += part.value;
  }
  if (pending) replacements.push(minimalReplacement(before, pending));
  return mergeWhitespaceSeparated(before, replacements).map((replacement) =>
    byteReplacement(before, replacement),
  );
}

function minimalReplacement(
  source: string,
  replacement: { end: number; replacement: string; start: number },
) {
  let { end, replacement: value, start } = replacement;
  while (start < end && value) {
    const sourceCharacter = characterAt(source, start);
    const replacementCharacter = characterAt(value, 0);
    if (sourceCharacter !== replacementCharacter) break;
    start += sourceCharacter.length;
    value = value.slice(replacementCharacter.length);
  }
  while (start < end && value) {
    const sourceCharacter = characterBefore(source, end);
    const replacementCharacter = characterBefore(value, value.length);
    if (sourceCharacter.value !== replacementCharacter.value) break;
    end = sourceCharacter.start;
    value = value.slice(0, replacementCharacter.start);
  }
  return { end, replacement: value, start };
}

function characterAt(value: string, offset: number) {
  return String.fromCodePoint(value.codePointAt(offset)!);
}

function characterBefore(value: string, end: number) {
  const low = value.charCodeAt(end - 1);
  const high = value.charCodeAt(end - 2);
  const paired =
    low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  const start = paired ? end - 2 : end - 1;
  return { start, value: value.slice(start, end) };
}

function mergeWhitespaceSeparated(
  source: string,
  replacements: Array<{ end: number; replacement: string; start: number }>,
) {
  const merged: typeof replacements = [];
  for (const current of replacements) {
    const previous = merged.at(-1);
    const gap = previous ? source.slice(previous.end, current.start) : "";
    if (previous && /^\s+$/u.test(gap)) {
      previous.end = current.end;
      previous.replacement += gap + current.replacement;
    } else merged.push({ ...current });
  }
  return merged;
}

function byteReplacement(
  source: string,
  replacement: { end: number; replacement: string; start: number },
) {
  return {
    start: Buffer.byteLength(source.slice(0, replacement.start)),
    end: Buffer.byteLength(source.slice(0, replacement.end)),
    replacement: replacement.replacement,
  };
}

function selectedLines(lines: string[], prefixes: Set<string>) {
  return lines
    .filter((line) => prefixes.has(line[0] ?? ""))
    .map((line) => line.slice(1))
    .join("\n");
}

function lineBoundedMatches(source: string, value: string, start = 0) {
  const matches: number[] = [];
  let offset = start;
  while (offset <= source.length) {
    const index = source.indexOf(value, offset);
    if (index < 0) break;
    const end = index + value.length;
    if (lineBoundary(source, index, end)) matches.push(index);
    if (matches.length > 1) break;
    offset = index + 1;
  }
  return matches;
}

function lineBoundary(source: string, start: number, end: number) {
  const before = start === 0 || source[start - 1] === "\n";
  const after = end === source.length || source[end] === "\n";
  return before && after;
}
