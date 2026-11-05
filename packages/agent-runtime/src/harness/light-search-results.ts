import type { materializeSymbol } from "./code-intelligence.js";
import type { LightSearchCodeInput, LightToolResult } from "./light-contracts.js";
import { escapeRegex, literalBraces, type LexicalSearchMatch, type TextQuery } from "./lexical-search.js";
import { recordValue, stringValue } from "./light-navigation.js";
import type { WorkspaceFiles } from "./workspace-files.js";

export type SearchMode = "references" | "regex" | "symbol" | "text";
export type SearchPage = { limit: number; offset: number };
export type FileHits = { path: string; matches: LexicalSearchMatch[]; score: number };
export type SearchMore = { cappedFiles?: string[]; hasMore: boolean; sized?: boolean; truncated?: boolean };

export const defaultMatchLimit = 8;
export const defaultFileLimit = 50;
const maximumContextLineCharacters = 240;
// One page of matches stays readable in a single result; large context or
// limit values continue on the next page instead.
const maximumPageCharacters = 40_000;

export function searchMode(input: LightSearchCodeInput): SearchMode {
  if (input.mode === "references" || input.mode === "regex") return input.mode;
  if (input.mode && input.mode !== "auto") return input.mode;
  return /^[\p{L}_$][\p{L}\p{N}_$.-]*$/u.test(input.query) ? "symbol" : "text";
}

export function searchPage(input: LightSearchCodeInput): SearchPage {
  const output = input.output ?? "matches";
  return {
    limit: input.limit ?? (output === "matches" ? defaultMatchLimit : defaultFileLimit),
    offset: input.offset ?? 0,
  };
}

/** Whitespace separates OR terms; punctuation inside a term stays literal. */
export function searchTerms(query: string) {
  return [...new Set(query.normalize("NFKC").toLocaleLowerCase().split(/\s+/u).filter(Boolean))].slice(0, 12);
}

export function lexicalQuery(query: string, mode: SearchMode, caseSensitive = false): TextQuery {
  if (mode === "regex") return { pattern: literalBraces(query), regex: true, case_sensitive: caseSensitive };
  const terms = caseSensitive ? [...new Set(query.split(/\s+/u).filter(Boolean))].slice(0, 12) : searchTerms(query);
  if (terms.length < 2) return { pattern: query, case_sensitive: caseSensitive };
  return { pattern: terms.map(escapeRegex).join("|"), regex: true, case_sensitive: caseSensitive };
}

/**
 * Groups matching lines by file. Text searches rank files by how many distinct
 * terms they contain, then by terms in the path and hit count; regex searches
 * keep grep's path order.
 */
export function rankedFiles(matches: LexicalSearchMatch[], terms: string[], relevance: boolean): FileHits[] {
  const byPath = new Map<string, LexicalSearchMatch[]>();
  for (const match of matches) byPath.set(match.path, [...(byPath.get(match.path) ?? []), match]);
  const files = [...byPath].map(([path, fileMatches]) => ({
    path,
    matches: fileMatches.sort((left, right) => left.line_range[0] - right.line_range[0]),
    score: relevance ? fileScore(path, fileMatches, terms) : 0,
  }));
  return files.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function fileScore(path: string, matches: LexicalSearchMatch[], terms: string[]) {
  const found = new Set(matches.flatMap((match) => matchedTerms(match, terms)));
  const normalized = path.toLocaleLowerCase();
  const pathTerms = terms.filter((term) => normalized.includes(term)).length;
  return found.size * 1_000 + pathTerms * 100 + Math.min(matches.length, 99);
}

function matchedTerms(match: LexicalSearchMatch, terms: string[]) {
  const hits = match.hits.map((hit) => hit.toLocaleLowerCase());
  return terms.filter((term) => hits.some((hit) => hit.includes(term)));
}

/**
 * Orders matching lines for presentation. Relevance order shows the best two
 * lines of every ranked file before the remaining lines, so one busy file
 * cannot hide the others; path order lists every line file by file.
 */
export function orderedMatches(files: FileHits[], terms: string[], relevance: boolean) {
  if (!relevance) return files.flatMap((file) => file.matches);
  const leading = files.flatMap((file) =>
    [...file.matches]
      .sort((left, right) =>
        matchedTerms(right, terms).length - matchedTerms(left, terms).length ||
        left.line_range[0] - right.line_range[0])
      .slice(0, 2));
  const shown = new Set(leading);
  return [...leading, ...files.flatMap((file) => file.matches.filter((match) => !shown.has(match)))];
}

/** grep-like context: `12:` marks the matching line, `11-` a surrounding one. */
export function contextExcerpt(source: string, line: number, before: number, after: number) {
  const lines = source.split(/\r?\n/u);
  const first = Math.max(1, line - before);
  const last = Math.min(lines.length, line + after);
  const excerpt: string[] = [];
  for (let current = first; current <= last; current += 1) {
    const text = lines[current - 1] ?? "";
    const bounded = text.length > maximumContextLineCharacters ? `${text.slice(0, maximumContextLineCharacters - 1)}…` : text;
    excerpt.push(`${current}${current === line ? ":" : "-"}${bounded}`);
  }
  return excerpt.join("\n");
}

export function searchEnvelope(
  input: LightSearchCodeInput,
  mode: string,
  engine: string,
  results: unknown[],
  candidates: string[],
  more: SearchMore,
): LightToolResult<unknown> {
  const page = searchPage(input);
  const shown = withinCharacters(results, maximumPageCharacters);
  const sized = shown.length < results.length;
  return {
    status: "ok",
    data: {
      mode,
      engine,
      results: shown,
      candidateCount: candidates.length,
      ...limitData(input, page, sized ? { ...more, hasMore: true, sized } : more, shown.length),
    },
  };
}

/** The leading results whose JSON fits the budget, and always the first. */
function withinCharacters(results: unknown[], budget: number) {
  let used = 0;
  const kept: unknown[] = [];
  for (const result of results) {
    used += JSON.stringify(result).length;
    if (kept.length && used > budget) break;
    kept.push(result);
  }
  return kept;
}

export function limitData(input: LightSearchCodeInput, page: SearchPage, more: SearchMore, shown: number) {
  const capped = more.cappedFiles ?? [];
  if (!more.hasMore && !more.truncated && !capped.length)
    return shown || page.offset ? {} : { guidance: "No match in the selected scope." };
  const notes = [
    ...(more.sized ? ["This page reached its size limit: call nextSearch for the following matches, or lower context."] : more.hasMore ? ["Result limit reached: call nextSearch for the next page, raise limit, or use output \"files\" to list every matching file."] : []),
    ...(more.truncated ? ["Collection stopped at the scan bound, so later matching lines were not ranked; narrow the query or scope."] : []),
    ...(capped.length ? [`Matching lines past the per-file bound were not examined in ${capped.slice(0, 3).join(", ")}${capped.length > 3 ? ` and ${capped.length - 3} more files` : ""}.`] : []),
  ];
  return {
    limited: true,
    ...(more.hasMore ? { nextSearch: { ...input, offset: page.offset + shown } } : {}),
    guidance: notes.join(" "),
  };
}

export function uniqueSearchResults(results: unknown[]) {
  const seen = new Set<string>();
  return results.filter((value) => {
    const key = searchResultKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function searchResultKey(value: unknown) {
  const result = recordValue(value);
  return `${result.path}:${result.qualifiedName ?? result.lines}`;
}

export function searchSymbolResult(
  alias: string,
  path: string,
  symbol: ReturnType<typeof materializeSymbol>,
  reason = "symbol_name",
) {
  return {
    alias,
    path,
    lines: symbol.line_range,
    kind: symbol.kind,
    qualifiedName: symbol.qualified_name,
    signature: symbol.signature,
    reason,
  };
}

export function autoSymbolCandidates(textResults: unknown[], candidates: string[], query: string) {
  const matchingPaths = new Set(textResults.flatMap((value) => {
    const path = stringValue(recordValue(value).path);
    return path ? [path] : [];
  }));
  if (matchingPaths.size) return candidates.filter((path) => matchingPaths.has(path));
  return query.includes(".") ? candidates : [];
}

/**
 * Paths named by the query. A multi-term query only names a path that contains
 * every term: a single shared word such as a folder name is no evidence of
 * relevance and must not crowd out content matches.
 */
export function pathMatches(query: string, candidates: string[], limit = defaultMatchLimit) {
  if (process.env.BLAME_AGENT_LITERAL_FILE_SEARCH !== "false" && literalFileQuery(query)) {
    const literal = query.replace(/^\.\//u, "").toLocaleLowerCase();
    return candidates.filter(path => {
      const normalized = path.toLocaleLowerCase();
      return normalized === literal || normalized.endsWith(`/${literal}`) ||
        (!literal.includes("/") && normalized.split("/").at(-1)!.endsWith(literal.startsWith(".") ? literal : `.${literal}`));
    }).sort((a, b) => Number(b.toLocaleLowerCase() === literal) - Number(a.toLocaleLowerCase() === literal) || a.localeCompare(b)).slice(0, limit);
  }
  const terms = searchTerms(query);
  if (!terms.length) return [];
  return candidates
    .map((path) => ({ path, score: pathMatchScore(path, query, terms) }))
    .filter(({ score }) => score >= 100 || score >= terms.length)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map(({ path }) => path);
}

function literalFileQuery(query: string) {
  return !/[\s*?{}[\]#]/u.test(query) && !query.split("/").includes("..") &&
    /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|py|rs|go|java|c|cpp|h|hpp|vue|svelte)$/iu.test(query);
}

function pathMatchScore(path: string, query: string, terms: string[]) {
  const normalized = path.toLocaleLowerCase();
  const exact = normalized.includes(query.toLocaleLowerCase()) ? 100 : 0;
  return exact + terms.filter((term) => normalized.includes(term)).length;
}

export function scopedCandidates(files: WorkspaceFiles, paths: string[], scope?: string | string[]) {
  const values = typeof scope === "string" ? [scope] : scope;
  if (!values?.length) return paths;
  const matchers = values.map((value) => scopeMatcher(files, value));
  return paths.filter((path) => matchers.some((matches) => matches(path)));
}

export function emptySearchScope(files: WorkspaceFiles, paths: string[], input: LightSearchCodeInput): LightToolResult<unknown> {
  // A valid path containing spaces stays literal; an array is only a hint.
  const parts = typeof input.scope === "string" ? input.scope.trim().split(/\s+/u) : [];
  let suggestArray = false;
  if (parts.length > 1 && parts.length <= 100) {
    try { suggestArray = parts.every((part) => scopedCandidates(files, paths, part).length > 0); }
    catch { /* An invalid split is no reason to reject the original literal scope. */ }
  }
  return { status: "ok", data: {
    mode: searchMode(input), engine: "none", results: [], candidateCount: 0, scopeStatus: "empty",
    ...(suggestArray ? { nextSearch: { ...input, scope: parts } } : {}),
    guidance: "No eligible files were selected; the query was not searched. Check paths, globs and ignore rules. " +
      (suggestArray ? "For multiple scopes, pass an array as shown in nextSearch. " : "Multiple scopes use an array, for example [\"src\",\"spec\"]. ") +
      "Spaces in one scope string are literal path characters.",
  } };
}

function scopeMatcher(files: WorkspaceFiles, value: string) {
  const portable = safeScopePattern(files.normalizePath(value.trim()));
  const matchers = expandBracePatterns(portable).map((pattern) => singleScopeMatcher(files, pattern));
  return (path: string) => matchers.some((matches) => matches(path));
}

function singleScopeMatcher(files: WorkspaceFiles, pattern: string) {
  if (/[?*]/u.test(pattern)) {
    const expression = globExpression(pattern);
    return (path: string) => expression.test(path);
  }
  const root = files.normalizePath(pattern);
  if (root === ".") return () => true;
  return (path: string) => path === root || path.startsWith(`${root}/`);
}

function safeScopePattern(value: string) {
  const portable = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!portable || portable.startsWith("/") || /^[A-Za-z]:\//u.test(portable))
    throw new Error("Search scopes must be workspace-relative paths or globs.");
  if (portable.split("/").includes(".."))
    throw new Error("Search scope escapes the workspace root.");
  if (portable.toLocaleLowerCase().split("/").includes("node_modules"))
    throw new Error("Dependency internals are excluded from code navigation. Use project manifests and run_task diagnostics.");
  return portable;
}

function expandBracePatterns(pattern: string): string[] {
  const match = /\{([^{}]+)\}/u.exec(pattern);
  if (!match) return [pattern];
  const alternatives = (match[1] ?? "").split(",").filter(Boolean);
  if (!alternatives.length || alternatives.length > 16) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + match[0].length);
  return alternatives.flatMap((value) => expandBracePatterns(`${prefix}${value}${suffix}`));
}

function globExpression(pattern: string) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      source += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += escapeRegex(character);
  }
  return new RegExp(`${source}$`, "u");
}
