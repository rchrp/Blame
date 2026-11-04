import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { rgPath } from "@vscode/ripgrep";
import { packagedResourcePath } from "./packaged-resource-path.js";

export type TextQuery = {
  case_sensitive?: boolean;
  pattern: string;
  regex?: boolean;
};

/** One matching line. `hits` holds every matched text on that line. */
export type LexicalSearchMatch = {
  path: string;
  line_range: [number, number];
  range_utf8_bytes: [number, number];
  excerpt: string;
  hits: string[];
  match_reason: "lexical_exact" | "lexical_regex";
};

export type LexicalSearchResult = {
  available: boolean;
  /** Files whose matching lines after the per-file bound were not examined. */
  cappedFiles: string[];
  engine: "node" | "ripgrep";
  items: LexicalSearchMatch[];
  /** Collection stopped at the total bound. */
  truncated: boolean;
};

export type LexicalSearchInput = {
  candidates: string[];
  /** Bound on matching lines in total. */
  maximum: number;
  /** Bound on matching lines in one file. */
  maximumPerFile: number;
  query: TextQuery;
  fileSize(path: string): Promise<number>;
  /** Reads a workspace file for the Node fallback when ripgrep is unavailable. */
  read(path: string): Promise<Buffer>;
  root: string;
  signal?: AbortSignal;
};

const maximumFileBytes = 2 * 1024 * 1024;
// Listing files on ripgrep's command line must fit Windows' 32,767-character limit.
const maximumListedPathCharacters = 24_000;

type RipgrepEvent = {
  type?: string;
  data?: {
    absolute_offset?: number;
    line_number?: number;
    lines?: EncodedText;
    path?: EncodedText;
    submatches?: RipgrepSubmatch[];
  };
};

type EncodedText = { bytes?: string; text?: string };
type RipgrepSubmatch = { end?: number; match?: EncodedText; start?: number };

/** Searches candidate files line by line with ripgrep, or with Node when ripgrep is missing. */
export async function searchLexically(input: LexicalSearchInput): Promise<LexicalSearchResult> {
  const searched = await searchWithRipgrep(input);
  return searched.available ? searched : searchWithNode(input);
}

async function searchWithRipgrep(input: LexicalSearchInput): Promise<LexicalSearchResult> {
  input.signal?.throwIfAborted();
  const candidateSet = new Set(input.candidates);
  if (!candidateSet.size) return emptySearchResult("ripgrep");
  const listed = listedPathCharacters(input.candidates) <= maximumListedPathCharacters
    ? await searchableFiles(input) : undefined;
  if (listed && !listed.length) return emptySearchResult("ripgrep");
  const child = spawn(ripgrepCommand(), ripgrepArguments(input, listed), {
    cwd: input.root,
    env: process.env,
    signal: input.signal,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const processState = observeProcess(child);
  const search = await collectMatches(child, input, candidateSet);
  const completion = await processState.completion;
  if (processState.unavailable) return { available: false, cappedFiles: [], engine: "node", items: [], truncated: false };
  if (!search.limited && completion.code !== 0 && completion.code !== 1 && !input.signal?.aborted)
    throw new Error(ripgrepFailure(Buffer.concat(processState.errors).toString("utf8").trim(), completion.code));
  input.signal?.throwIfAborted();
  return { available: true, cappedFiles: cappedFiles(search.items, input.maximumPerFile), engine: "ripgrep",
    items: search.items, truncated: search.limited };
}

function listedPathCharacters(paths: string[]) {
  return paths.reduce((total, path) => total + path.length + 1, 0);
}

/** ripgrep's size bound does not apply to files named on its command line. */
async function searchableFiles(input: LexicalSearchInput) {
  const sizes = await Promise.all(input.candidates.map((path) => input.fileSize(path).catch(() => Infinity)));
  return input.candidates.filter((_, index) => sizes[index]! <= maximumFileBytes);
}

function ripgrepArguments(input: LexicalSearchInput, listed?: string[]) {
  return [
    "--json",
    "--no-config",
    "--no-messages",
    "--hidden",
    "--sort",
    "path",
    "--max-filesize",
    "2M",
    "--max-count",
    String(input.maximumPerFile),
    "--glob",
    "!.blame/**",
    "--glob",
    "!.code-review-graph/**",
    ...(input.query.case_sensitive ? [] : ["--ignore-case"]),
    ...(input.query.regex ? [] : ["--fixed-strings"]),
    "--",
    input.query.pattern,
    // A scoped search names its files instead of walking the whole workspace.
    ...(listed ?? ["."]),
  ];
}

function ripgrepFailure(stderr: string, code: number | null) {
  if (/regex parse error|error parsing regex/iu.test(stderr))
    return `Invalid regex for search_code (ripgrep syntax): ${stderr.replace(/^.*?error:\s*/su, "").slice(0, 600)}`;
  return `ripgrep failed: ${stderr || `exit ${code}`}`;
}

function observeProcess(child: ReturnType<typeof spawn>) {
  const state = {
    errors: [] as Buffer[],
    unavailable: false,
    completion: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  };
  child.stderr?.on("data", (chunk) => state.errors.push(Buffer.from(chunk)));
  child.on("error", (error) => {
    if (errorCode(error) === "ENOENT") state.unavailable = true;
  });
  return state;
}

async function collectMatches(
  child: ReturnType<typeof spawn>,
  input: LexicalSearchInput,
  candidates: Set<string>,
) {
  const items: LexicalSearchMatch[] = [];
  let limited = false;
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const match = eventMatch(parseEvent(line), input, candidates);
      if (!match) continue;
      items.push(match);
      if (items.length < input.maximum) continue;
      limited = true;
      child.kill();
      break;
    }
  } finally {
    lines.close();
  }
  return { items, limited };
}

function eventMatch(event: RipgrepEvent | undefined, input: LexicalSearchInput, candidates: Set<string>) {
  if (event?.type !== "match" || !event.data) return undefined;
  const data = event.data;
  const path = text(data.path)?.replaceAll("\\", "/").replace(/^\.\//u, "");
  const lineContent = text(data.lines);
  if (
    !path ||
    !candidates.has(path) ||
    !Number.isSafeInteger(data.absolute_offset) ||
    !Number.isSafeInteger(data.line_number) ||
    lineContent === undefined
  )
    return undefined;
  const lineBytes = Buffer.from(lineContent);
  const submatches = (data.submatches ?? []).filter((submatch) => validSubmatch(submatch, lineBytes.byteLength));
  const first = submatches[0];
  if (!first) return undefined;
  const hits = submatches.map((submatch) =>
    text(submatch.match) ?? lineBytes.subarray(submatch.start, submatch.end).toString("utf8"));
  const startLine = data.line_number! + countNewlines(lineBytes.subarray(0, first.start));
  return lineMatch(path, startLine, data.absolute_offset! + first.start!, hits, lineContent, input.query.regex);
}

function lineMatch(
  path: string,
  line: number,
  start: number,
  hits: string[],
  lineContent: string,
  regex?: boolean,
): LexicalSearchMatch {
  const first = hits[0] ?? "";
  return {
    path,
    line_range: [line, line + countNewlines(Buffer.from(first))],
    range_utf8_bytes: [start, start + Buffer.byteLength(first)],
    excerpt: compactLine(lineContent),
    hits,
    match_reason: regex ? "lexical_regex" : "lexical_exact",
  };
}

function validSubmatch(submatch: RipgrepSubmatch, lineLength: number) {
  return (
    Number.isSafeInteger(submatch.start) &&
    Number.isSafeInteger(submatch.end) &&
    submatch.start! >= 0 &&
    submatch.end! > submatch.start! &&
    submatch.end! <= lineLength
  );
}

/** Same line-based contract as ripgrep, for hosts without its binary. */
async function searchWithNode(input: LexicalSearchInput): Promise<LexicalSearchResult> {
  const expression = nodeExpression(input.query);
  const items: LexicalSearchMatch[] = [];
  for (const path of input.candidates) {
    input.signal?.throwIfAborted();
    const content = await input.read(path).catch(() => undefined);
    if (!content || content.byteLength > maximumFileBytes || content.includes(0)) continue;
    const fileMatches = nodeFileMatches(path, content.toString("utf8"), expression, input);
    items.push(...fileMatches.slice(0, input.maximum - items.length));
    if (items.length >= input.maximum)
      return { available: true, cappedFiles: cappedFiles(items, input.maximumPerFile), engine: "node", items, truncated: true };
  }
  return { available: true, cappedFiles: cappedFiles(items, input.maximumPerFile), engine: "node", items, truncated: false };
}

function nodeExpression(query: TextQuery) {
  const source = query.regex ? query.pattern : escapeRegex(query.pattern);
  const flags = `g${query.case_sensitive ? "" : "i"}`;
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    try {
      return new RegExp(source, flags);
    } catch (error) {
      throw new Error(`Invalid regex for search_code: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

function nodeFileMatches(path: string, source: string, expression: RegExp, input: LexicalSearchInput) {
  const matches: LexicalSearchMatch[] = [];
  let offset = 0;
  const lines = source.split(/(?<=\n)/u);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r?\n$/u, "");
    expression.lastIndex = 0;
    const hits: Array<{ index: number; text: string }> = [];
    for (let found = expression.exec(line); found; found = expression.exec(line)) {
      if (!found[0]) {
        expression.lastIndex += 1;
        continue;
      }
      hits.push({ index: found.index, text: found[0] });
    }
    const first = hits[0];
    if (first) {
      const start = offset + Buffer.byteLength(line.slice(0, first.index));
      matches.push(lineMatch(path, index + 1, start, hits.map((hit) => hit.text), line, input.query.regex));
      if (matches.length >= input.maximumPerFile) break;
    }
    offset += Buffer.byteLength(rawLine);
  }
  return matches;
}

function cappedFiles(items: LexicalSearchMatch[], maximumPerFile: number) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.path, (counts.get(item.path) ?? 0) + 1);
  return [...counts].flatMap(([path, count]) => (count >= maximumPerFile ? [path] : []));
}

function emptySearchResult(engine: LexicalSearchResult["engine"]): LexicalSearchResult {
  return { available: true, cappedFiles: [], engine, items: [], truncated: false };
}

function ripgrepCommand() {
  const configured = process.env.BLAME_RIPGREP_COMMAND?.trim();
  if (configured) return configured;
  return bundledRipgrepPath() || "rg";
}

/** The ripgrep binary shipped with Blame, also exposed to workspace commands. */
export function bundledRipgrepPath() {
  return packagedResourcePath(rgPath);
}

export function bundledRipgrepDirectory() {
  const path = bundledRipgrepPath();
  return path ? dirname(path) : undefined;
}

function parseEvent(line: string): RipgrepEvent | undefined {
  try {
    return JSON.parse(line) as RipgrepEvent;
  } catch {
    return undefined;
  }
}

function text(value?: EncodedText) {
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8");
  return undefined;
}

function compactLine(value: string) {
  const compact = value.replace(/\r?\n$/u, "").trimEnd();
  return compact.length > 500 ? `${compact.slice(0, 499)}…` : compact;
}

function countNewlines(value: Buffer) {
  let count = 0;
  for (const byte of value) if (byte === 10) count += 1;
  return count;
}

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}
