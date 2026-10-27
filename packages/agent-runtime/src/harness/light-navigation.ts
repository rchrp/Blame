import { materializeSymbol, type ParsedSymbol } from "./code-intelligence.js";
import { capabilityForPath } from "./light-capabilities.js";
import type {
  LightReadCodeInput,
  LightSearchCodeInput,
  LightToolResult,
} from "./light-contracts.js";
import type { LexicalSearchMatch } from "./lexical-search.js";
import type { ByteInterval } from "./read-coverage.js";
import type { WorkspaceFiles } from "./workspace-files.js";

export type SearchMode = "references" | "symbol" | "text";
export type EditTarget = { alias: string; qualifiedName: string };
export type TextSearchResults = { results: unknown[]; engine: "node" | "ripgrep"; limited: boolean };

const smallFileCharacters = 8_000;

export function searchMode(input: LightSearchCodeInput): SearchMode {
  if (input.mode === "references") return "references";
  if (input.mode && input.mode !== "auto") return input.mode;
  return /^[\p{L}_$][\p{L}\p{N}_$.-]*$/u.test(input.query) ? "symbol" : "text";
}

export function symbolSearchResult(results: unknown[], candidates: string[]) {
  return searchResult("symbol", "syntax", results, candidates, results.length >= 8);
}

export function textSearchResult(
  mode: Exclude<SearchMode, "symbol">,
  search: TextSearchResults,
  candidates: string[],
) {
  const engine = mode === "references" ? "lexical_fallback" : search.engine;
  return searchResult(mode, engine, search.results, candidates, search.limited);
}

export function autoSearchResult(
  symbols: unknown[],
  text: TextSearchResults,
  candidates: string[],
) {
  const results = uniqueSearchResults([...symbols.slice(0, 4), ...text.results]);
  return searchResult(
    "auto",
    `syntax_and_${text.engine}`,
    results.slice(0, 8),
    candidates,
    text.limited || symbols.length >= 8 || results.length > 8,
  );
}

function searchResult(
  mode: string,
  engine: string,
  results: unknown[],
  candidates: string[],
  limited: boolean,
): LightToolResult<unknown> {
  return {
    status: "ok",
    data: {
      mode,
      engine,
      results,
      candidateCount: candidates.length,
      ...(limited ? { limited, guidance: "Result limit reached; narrow the query or scope, or use run_task for an exhaustive scan." }
        : results.length ? {} : { guidance: "No match in the selected scope." }),
    },
  };
}

export function uniqueSearchResults(results: unknown[]) {
  const seen = new Set<string>();
  return results.filter((value) => {
    const result = recordValue(value);
    const key = `${result.path}:${result.qualifiedName ?? result.lines}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pathMatches(query: string, candidates: string[]) {
  if (process.env.BLAME_AGENT_LITERAL_FILE_SEARCH !== "false" && literalFileQuery(query)) {
    const literal = query.replace(/^\.\//u, "").toLocaleLowerCase();
    return candidates.filter(path => {
      const normalized = path.toLocaleLowerCase();
      return normalized === literal || normalized.endsWith(`/${literal}`) ||
        (!literal.includes("/") && normalized.split("/").at(-1)!.endsWith(literal.startsWith(".") ? literal : `.${literal}`));
    }).sort((a, b) => Number(b.toLocaleLowerCase() === literal) - Number(a.toLocaleLowerCase() === literal) || a.localeCompare(b)).slice(0, 8);
  }
  const terms = searchTerms(query);
  if (!terms.length) return [];
  return candidates
    .map((path) => ({ path, score: pathMatchScore(path, query, terms) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.path.localeCompare(right.path),
    )
    .slice(0, 8)
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

export function autoSymbolCandidates(
  textResults: unknown[],
  candidates: string[],
  query: string,
) {
  const matchingPaths = new Set(
    textResults.flatMap((value) => {
      const path = stringValue(recordValue(value).path);
      return path ? [path] : [];
    }),
  );
  if (matchingPaths.size)
    return candidates.filter((path) => matchingPaths.has(path));
  return query.includes(".") ? candidates : [];
}

export function scopedCandidates(
  files: WorkspaceFiles,
  paths: string[],
  scope?: string | string[],
) {
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
  const matchers = expandBracePatterns(portable).map((pattern) =>
    singleScopeMatcher(files, pattern),
  );
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
    throw new Error(
      "Dependency internals are excluded from code navigation. Use project manifests and run_task diagnostics.",
    );
  return portable;
}

function expandBracePatterns(pattern: string): string[] {
  const match = /\{([^{}]+)\}/u.exec(pattern);
  if (!match) return [pattern];
  const alternatives = (match[1] ?? "").split(",").filter(Boolean);
  if (!alternatives.length || alternatives.length > 16) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + match[0].length);
  return alternatives.flatMap((value) =>
    expandBracePatterns(`${prefix}${value}${suffix}`),
  );
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

export function lexicalQuery(query: string) {
  const terms = searchTerms(query);
  if (terms.length < 2) return { pattern: query };
  return { pattern: terms.map(escapeRegex).join("|"), regex: true };
}

export function searchTerms(query: string) {
  return [
    ...new Set(
      query
        .normalize("NFKC")
        .toLocaleLowerCase()
        .split(/\s+/u)
        .filter(Boolean),
    ),
  ].slice(0, 12);
}

export function rankedTextMatches(
  matches: LexicalSearchMatch[],
  query: string,
) {
  const terms = searchTerms(query);
  const unique = new Map<string, LexicalSearchMatch>();
  for (const match of matches) {
    const key = `${match.path}:${match.line_range.join(":")}:${match.excerpt}`;
    if (!unique.has(key)) unique.set(key, match);
  }
  return [...unique.values()].sort((left, right) => {
    const score = textMatchScore(right, terms) - textMatchScore(left, terms);
    return score || left.path.localeCompare(right.path);
  });
}

function textMatchScore(match: LexicalSearchMatch, terms: string[]) {
  const path = match.path.toLocaleLowerCase();
  const content = `${path}\n${match.excerpt.toLocaleLowerCase()}`;
  const coverage = terms.filter((term) => content.includes(term)).length;
  const pathCoverage = terms.filter((term) => path.includes(term)).length;
  return coverage * 100 + pathCoverage * 20;
}

export function firstTermIndex(source: string, terms: string[], query: string) {
  const normalized = source.toLocaleLowerCase();
  const needles = terms.length ? terms : [query.toLocaleLowerCase()];
  return needles.reduce((best, needle) => {
    const index = normalized.indexOf(needle);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
}

export function matchedTerm(
  source: string,
  index: number,
  terms: string[],
  query: string,
) {
  const normalized = source.toLocaleLowerCase();
  const needles = terms.length ? terms : [query.toLocaleLowerCase()];
  const needle = needles.find((candidate) =>
    normalized.startsWith(candidate, index),
  );
  return source.slice(index, index + (needle ?? query).length);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function symbolicPath(path: string) {
  const capability = capabilityForPath(path);
  return Boolean(capability?.loaded && capability.level !== "raw");
}

export function enclosingSymbol(
  symbols: ParsedSymbol[],
  range: ByteInterval,
): ParsedSymbol | undefined {
  return symbols
    .filter(
      (symbol) =>
        symbol.range_utf8_bytes[0] <= range[0] &&
        symbol.range_utf8_bytes[1] >= range[1],
    )
    .sort((left, right) => symbolSize(left) - symbolSize(right))[0];
}

export function outlineCandidates(symbols: ParsedSymbol[]) {
  const structural = symbols.filter(
    ({ kind }) => kind !== "css_custom_property",
  );
  return structural.length ? structural : symbols;
}

export function editTargetSymbols(
  symbols: ParsedSymbol[],
  intervals?: ByteInterval[],
) {
  const candidates = outlineCandidates(symbols);
  if (intervals?.length) return intervalEditTargets(candidates, intervals);
  const roots = candidates.filter(
    ({ name, qualified_name }) => qualified_name === name,
  );
  return uniqueSymbols([...roots.slice(0, 2), appendSymbol(roots)]).slice(0, 3);
}

function intervalEditTargets(
  symbols: ParsedSymbol[],
  intervals: ByteInterval[],
) {
  const overlapping = symbols
    .filter((symbol) =>
      intervals.some((range) => overlaps(symbol.range_utf8_bytes, range)),
    )
    .sort((left, right) => symbolSize(left) - symbolSize(right));
  const fullyRead = overlapping
    .filter((symbol) =>
      intervals.some(
        ([start, end]) =>
          start <= symbol.range_utf8_bytes[0] &&
          end >= symbol.range_utf8_bytes[1],
      ),
    )
    .sort((left, right) => symbolSize(right) - symbolSize(left));
  const ranked = uniqueSymbols([...fullyRead, ...overlapping]);
  return nonOverlappingSymbols(ranked).slice(0, 3);
}

function nonOverlappingSymbols(symbols: ParsedSymbol[]) {
  const selected: ParsedSymbol[] = [];
  for (const symbol of symbols)
    if (
      !selected.some((candidate) =>
        overlaps(candidate.range_utf8_bytes, symbol.range_utf8_bytes),
      )
    )
      selected.push(symbol);
  return selected;
}

function appendSymbol(symbols: ParsedSymbol[]) {
  return [...symbols].sort(
    (left, right) => right.range_utf8_bytes[1] - left.range_utf8_bytes[1],
  )[0];
}

function uniqueSymbols(symbols: Array<ParsedSymbol | undefined>) {
  const seen = new Set<string>();
  return symbols.filter((symbol): symbol is ParsedSymbol => {
    if (!symbol) return false;
    const key = symbol.range_utf8_bytes.join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function overlaps(left: ByteInterval, right: ByteInterval) {
  return left[0] < right[1] && right[0] < left[1];
}

function symbolSize(symbol: ParsedSymbol) {
  return symbol.range_utf8_bytes[1] - symbol.range_utf8_bytes[0];
}

export function symbolMatches(symbol: ParsedSymbol, query: string) {
  return (
    symbol.name.toLocaleLowerCase().includes(query) ||
    symbol.qualified_name.toLocaleLowerCase().includes(query)
  );
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

export function qualifiedTarget(value: string) {
  return value.includes("#") && !value.startsWith("#");
}

export function routedView(
  input: LightReadCodeInput,
  path: string,
  characters: number,
) {
  if (requestedLineRange(input)) return "range" as const;
  if (input.view && input.view !== "auto") return input.view;
  if (characters <= smallFileCharacters) return "raw" as const;
  const capability = capabilityForPath(path);
  return capability?.loaded && capability.level !== "raw"
    ? ("outline" as const)
    : ("raw" as const);
}

export function requestedLineRange(input: LightReadCodeInput) {
  return input.view === "range" || Boolean(
    input.range && (!input.view || ["auto", "raw"].includes(input.view)),
  );
}

export function lineRange(
  content: Buffer,
  range: [number, number],
): [number, number] {
  const start = content
    .subarray(0, range[0])
    .toString("utf8")
    .split("\n").length;
  const count = content
    .subarray(...range)
    .toString("utf8")
    .split("\n").length;
  return [start, start + count - 1];
}

export function sourceLine(source: string, index: number) {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  const end = source.indexOf("\n", index);
  return source
    .slice(start, end < 0 ? source.length : end)
    .trim()
    .slice(0, 500);
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
