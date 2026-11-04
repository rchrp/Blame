import { codeObservation, presentObservation } from "./code-observation.js";
import { parseCode, type ParsedSymbol } from "./code-intelligence.js";
import type { LightAliasRegistry } from "./light-aliases.js";
import type { LightSearchCodeInput, LightToolResult } from "./light-contracts.js";
import { arrayValue } from "./light-read-results.js";
import {
  enclosingSymbol,
  recordValue,
  stringValue,
  symbolicPath,
  symbolMatches,
} from "./light-navigation.js";
import {
  autoSymbolCandidates,
  contextExcerpt,
  emptySearchScope,
  lexicalQuery,
  limitData,
  orderedMatches,
  pathMatches,
  rankedFiles,
  scopedCandidates,
  searchEnvelope,
  searchMode,
  searchPage,
  searchResultKey,
  searchSymbolResult,
  searchTerms,
  uniqueSearchResults,
  type SearchMode,
} from "./light-search-results.js";
import type { LightReferenceSearch } from "./light-reference-search.js";
import { declarationQuery } from "./light-reference-candidates.js";
import { searchLexically, type LexicalSearchMatch } from "./lexical-search.js";
import type { ByteInterval } from "./read-coverage.js";
import type { WorkspaceFiles } from "./workspace-files.js";

/** The tool input plus grep translations that the model-facing schema does not expose. */
export type CodeSearchRequest = LightSearchCodeInput & {
  contextAfter?: number;
  contextBefore?: number;
  /** Drops presented lines, like `| grep -v` applied to grep's `path:line:text` output. */
  excludeLine?: (line: string) => boolean;
};

export type LightCodeSearchOptions = {
  aliases: LightAliasRegistry;
  /** Runner-only experiment; production keeps compact search until the offline gate is met. */
  experimentalSearchExpansion?: boolean;
  files: WorkspaceFiles;
  references: LightReferenceSearch;
  registerCoverage(path: string, content: Buffer, intervals: ByteInterval[]): Promise<unknown>;
};

type SearchSource = { content: Buffer; symbols: ParsedSymbol[]; text: string };
type TextResults = { cappedFiles: string[]; engine: "node" | "ripgrep"; hasMore: boolean; results: unknown[]; truncated: boolean };

const maximumMatchingLines = 20_000;
const maximumMatchingLinesPerFile = 500;

/** search_code over the current workspace snapshot: paths, text, regex, symbols and references. */
export class LightCodeSearch {
  private readonly options: LightCodeSearchOptions;

  constructor(options: LightCodeSearchOptions) {
    this.options = options;
  }

  private get aliases() {
    return this.options.aliases;
  }

  private get files() {
    return this.options.files;
  }

  private get references() {
    return this.options.references;
  }

  async search(request: CodeSearchRequest, signal?: AbortSignal): Promise<LightToolResult<unknown>> {
    const snapshot = await this.files.snapshot(signal);
    const candidates = scopedCandidates(this.files, snapshot.files, request.scope);
    if (!candidates.length) return emptySearchScope(this.files, snapshot.files, publicInput(request));
    if (request.output && request.output !== "matches") return this.fileSearch(request, candidates, signal);
    const revision = snapshot.revision.source_revision_id;
    const semantic = request.mode === "references"
      ? await this.references.search(request, snapshot.files, candidates, revision, signal)
      : undefined;
    if (semantic && "status" in semantic) return semantic;
    const result = await this.searchResult(
      semantic ? { ...request, query: semantic.lexicalQuery } : request,
      searchMode(request),
      candidates,
      revision,
      signal,
    );
    let labeled = semantic && result.status === "ok" ? { ...result, data: { ...recordValue(result.data),
      semanticFallback: semantic.fallback,
      ...await this.references.recovery(request, semantic.fallback, candidates, revision, signal) } } : result;
    // Keep the original lexical/symbol results and explicit target choice. The
    // bounded syntax route is also reachable from ordinary searches, even when
    // early call sites or substring matches crowd out the exact declaration.
    if (!semantic && result.status === "ok" && request.mode !== "regex") {
      const query = declarationQuery(request.query), data = recordValue(result.data);
      const exact = arrayValue(data.results).some(value => {
        const item = recordValue(value);
        return item.reason === "symbol_name" && typeof item.qualifiedName === "string" &&
          (item.qualifiedName === query || item.qualifiedName.endsWith(`.${query}`));
      });
      if (query && !exact) {
        const discovery = await this.references.declarations({ ...request, query }, candidates, revision, signal);
        if (discovery.declarationCandidates.length || discovery.declarationDiscovery.limited ||
            discovery.declarationDiscovery.status === "source_changed")
          labeled = { ...result, data: { ...data, ...discovery } };
      }
    }
    return this.expandSearch(labeled, revision);
  }

  private async expandSearch(result: LightToolResult<unknown>, revision: string) {
    if (!this.options.experimentalSearchExpansion || result.status !== "ok") return result;
    const data = recordValue(result.data);
    const items = arrayValue(data.results);
    if (data.limited || !items.length || items.length > 2 || data.engine === "node") return result;
    const observations = [];
    for (const item of items) {
      const alias = stringValue(recordValue(item).alias);
      if (!alias || this.aliases.get(alias)?.kind !== "symbol") return result;
      const resolved = await this.aliases.resolveSymbol(alias, this.files, revision);
      const [start, end] = resolved.symbol.range_utf8_bytes;
      if (end - start >= 4 * 1024) return result;
      observations.push({ resolved, observation: codeObservation(resolved.path, resolved.content,
        start, end, "symbol", { alias, qualifiedName: resolved.symbol.qualified_name }) });
    }
    const results = observations.map(({ resolved, observation }) => ({ ...presentObservation(observation),
      lines: resolved.symbol.line_range, context: "Local symbol only; use read_code for imports and surrounding invariants." }));
    if (Buffer.byteLength(JSON.stringify(results)) > 10 * 1024) return result;
    for (const { resolved } of observations)
      await this.options.registerCoverage(resolved.path, resolved.content, [resolved.symbol.range_utf8_bytes]);
    return { ...result, data: { ...data, results, expanded: true,
      searchComplete: true, scope: "Eligible workspace text files up to 2 MiB; ignore rules applied." } };
  }

  private async searchResult(
    request: CodeSearchRequest,
    mode: SearchMode,
    candidates: string[],
    revision: string,
    signal?: AbortSignal,
  ): Promise<LightToolResult<unknown>> {
    const input = publicInput(request);
    const page = searchPage(request);
    const end = page.offset + page.limit;
    if (mode === "symbol" && request.mode === "symbol") {
      const symbols = await this.symbolSearch(request.query, candidates, revision, end + 1, signal);
      return searchEnvelope(input, "symbol", "syntax", symbols.slice(page.offset, end), candidates,
        { hasMore: symbols.length > end });
    }
    const text = await this.textSearch(request, mode === "regex" ? "regex" : "text", candidates, revision, end + 1, signal);
    if (mode !== "symbol")
      return searchEnvelope(input, mode, mode === "references" ? "lexical_fallback" : text.engine,
        text.results.slice(page.offset, end), candidates,
        { cappedFiles: text.cappedFiles, hasMore: text.hasMore || text.results.length > end, truncated: text.truncated });
    const symbolCandidates = autoSymbolCandidates(text.results, candidates, request.query);
    const symbols = await this.symbolSearch(request.query, symbolCandidates, revision, end + 1, signal);
    const merged = uniqueSearchResults([...symbols.slice(0, Math.ceil(page.limit / 2) + page.offset), ...text.results]);
    return searchEnvelope(input, "auto", `syntax_and_${text.engine}`, merged.slice(page.offset, end), candidates, {
      cappedFiles: text.cappedFiles,
      hasMore: text.hasMore || symbols.length > end || merged.length > end,
      truncated: text.truncated,
    });
  }

  /** files and count outputs: every matching file, without aliases or symbol parsing. */
  private async fileSearch(request: CodeSearchRequest, candidates: string[], signal?: AbortSignal): Promise<LightToolResult<unknown>> {
    const mode = request.mode === "regex" ? "regex" : "text";
    const searched = await this.lexical(request, mode, candidates, signal);
    const excluded = request.excludeLine;
    // File listings filter paths, as `grep -l ... | grep -v` filters grep's path lines.
    const items = excluded ? searched.items.filter((match) => !excluded(match.path)) : searched.items;
    const files = rankedFiles(items, searchTerms(request.query), mode === "text");
    const totals = { totalFiles: files.length, totalMatchingLines: items.length };
    const base = { mode, engine: searched.engine, output: request.output, candidateCount: candidates.length };
    if (request.output === "count")
      return { status: "ok", data: { ...base, ...totals,
        ...limitData(publicInput(request), searchPage(request),
          { cappedFiles: searched.cappedFiles, hasMore: false, truncated: searched.truncated }, files.length) } };
    const page = searchPage(request);
    const shown = files.slice(page.offset, page.offset + page.limit)
      .map((file) => ({ path: file.path, matchingLines: file.matches.length }));
    return { status: "ok", data: { ...base, ...totals, files: shown,
      ...limitData(publicInput(request), page,
        { cappedFiles: searched.cappedFiles, hasMore: files.length > page.offset + page.limit, truncated: searched.truncated }, shown.length) } };
  }

  private lexical(request: CodeSearchRequest, mode: "regex" | "text", candidates: string[], signal?: AbortSignal) {
    return searchLexically({
      candidates,
      maximum: maximumMatchingLines,
      maximumPerFile: maximumMatchingLinesPerFile,
      query: lexicalQuery(request.query, mode, request.caseSensitive),
      fileSize: (path) => this.files.fileSize(path),
      read: async (path) => (await this.files.read(path)).content,
      root: this.files.root,
      signal,
    });
  }

  private async symbolSearch(query: string, candidates: string[], revision: string, maximum: number, signal?: AbortSignal) {
    const selected: Array<{ path: string; content: Buffer; symbol: ParsedSymbol; exact: boolean }> = [];
    const normalized = query.toLocaleLowerCase();
    for (const path of candidates) {
      signal?.throwIfAborted();
      if (selected.length === maximum) break;
      if (!symbolicPath(path)) continue;
      const content = (await this.files.read(path)).content;
      if (content.byteLength > 2 * 1024 * 1024) continue;
      for (const symbol of parseCode(path, content).symbols) {
        if (!symbolMatches(symbol, normalized)) continue;
        const exact = symbol.name.toLocaleLowerCase() === normalized ||
          symbol.qualified_name.toLocaleLowerCase() === normalized;
        if (selected.length < maximum) selected.push({ path, content, symbol, exact });
        else if (exact && !selected.at(-1)!.exact) {
          selected.pop();
          selected.push({ path, content, symbol, exact });
        }
        // Stable ties retain candidate/source order. Scan the already parsed
        // file for exact names, but retain the bound on visiting further files.
        selected.sort((left, right) => Number(right.exact) - Number(left.exact));
        if (selected.length === maximum && selected.every((item) => item.exact)) break;
      }
    }
    // Register only returned aliases; discovery still grants no read coverage.
    return selected.map(({ path, content, symbol }) => {
      const { alias, materialized } = this.aliases.registerSymbol(path, content, symbol, revision);
      return searchSymbolResult(alias, path, materialized);
    });
  }

  private async textSearch(
    request: CodeSearchRequest,
    mode: "regex" | "text",
    candidates: string[],
    revision: string,
    wanted: number,
    signal?: AbortSignal,
  ): Promise<TextResults> {
    const relevance = mode === "text";
    const paths = relevance
      ? pathMatches(request.query, candidates, wanted).map((path) => this.pathResult(path))
      : [];
    const searched = await this.lexical(request, mode, candidates, signal);
    const terms = searchTerms(request.query);
    const ordered = orderedMatches(rankedFiles(searched.items, terms, relevance), terms, relevance);
    const content = await this.materializeMatches(ordered, request, revision, wanted);
    const results = uniqueSearchResults([...paths, ...content.results]);
    return { cappedFiles: searched.cappedFiles, engine: searched.engine, hasMore: content.hasMore, results, truncated: searched.truncated };
  }

  private pathResult(path: string) {
    return { alias: this.aliases.registerPath(path), kind: "path", path, reason: "path_name", target: path };
  }

  private async materializeMatches(ordered: LexicalSearchMatch[], request: CodeSearchRequest, revision: string, wanted: number) {
    // text mode groups the hits of one declaration; regex mode lists each line like grep.
    const perLine = request.mode === "regex";
    const promote = request.mode !== "text";
    const sources = new Map<string, SearchSource>();
    const results: unknown[] = [];
    const seen = new Set<string>();
    for (const match of ordered) {
      if (results.length >= wanted) return { hasMore: true, results };
      if (request.excludeLine?.(presentedLine(match))) continue;
      const source = await this.source(sources, match.path, promote);
      const item = this.textMatch(match, revision, source, request);
      const key = perLine ? `${match.path}:${match.line_range[0]}` : searchResultKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
    return { hasMore: false, results };
  }

  private async source(sources: Map<string, SearchSource>, path: string, promote: boolean) {
    const cached = sources.get(path);
    if (cached) return cached;
    const { content } = await this.files.read(path);
    const source = {
      content,
      symbols: promote && symbolicPath(path) ? parseCode(path, content).symbols : [],
      text: content.toString("utf8"),
    };
    sources.set(path, source);
    return source;
  }

  private textMatch(match: LexicalSearchMatch, revision: string, source: SearchSource, request: CodeSearchRequest) {
    const line = match.line_range[0];
    const before = request.contextBefore ?? request.context ?? 0;
    const after = request.contextAfter ?? request.context ?? 0;
    const context = before || after ? { context: contextExcerpt(source.text, line, before, after) } : {};
    const symbol = enclosingSymbol(source.symbols, match.range_utf8_bytes);
    if (symbol) {
      const { alias, materialized } = this.aliases.registerSymbol(match.path, source.content, symbol, revision);
      // The matching line replaces the declaration signature: one location, fewer tokens.
      const result: Partial<ReturnType<typeof searchSymbolResult>> = searchSymbolResult(alias, match.path, materialized, "lexical_symbol");
      delete result.signature;
      return { ...result, matchLine: line, snippet: match.excerpt, ...context };
    }
    return {
      alias: this.aliases.registerRange(match.path, source.content, match.range_utf8_bytes),
      kind: "text",
      path: match.path,
      lines: match.line_range,
      snippet: match.excerpt,
      reason: match.match_reason,
      ...context,
    };
  }
}

function presentedLine(match: LexicalSearchMatch) {
  return `${match.path}:${match.line_range[0]}:${match.excerpt}`;
}

/** nextSearch must stay a valid tool call: internal grep translations are not part of it. */
function publicInput(request: CodeSearchRequest): LightSearchCodeInput {
  const input: CodeSearchRequest = { ...request };
  delete input.contextAfter;
  delete input.contextBefore;
  delete input.excludeLine;
  return input;
}
