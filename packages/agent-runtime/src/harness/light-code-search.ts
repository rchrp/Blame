import { codeObservation, presentObservation } from "./code-observation.js";
import { parseCode, type ParsedSymbol } from "./code-intelligence.js";
import type { LightAliasRegistry } from "./light-aliases.js";
import type { LightSearchCodeInput, LightToolResult } from "./light-contracts.js";
import {
  arrayValue,
  nodeTextSearch,
  pathSearch,
} from "./light-read-results.js";
import {
  autoSearchResult,
  autoSymbolCandidates,
  emptySearchScope,
  enclosingSymbol,
  lexicalQuery,
  rankedTextMatches,
  recordValue,
  scopedCandidates,
  searchMode,
  searchSymbolResult,
  stringValue,
  symbolicPath,
  symbolMatches,
  symbolSearchResult,
  textSearchResult,
  uniqueSearchResults,
  type SearchMode,
  type TextSearchResults,
} from "./light-navigation.js";
import type { LightReferenceSearch } from "./light-reference-search.js";
import { declarationQuery } from "./light-reference-candidates.js";
import { searchWithRipgrep, type LexicalSearchMatch } from "./lexical-search.js";
import type { ByteInterval } from "./read-coverage.js";
import type { WorkspaceFiles } from "./workspace-files.js";

type SearchSource = { content: Buffer; symbols: ParsedSymbol[] };

export type LightCodeSearchOptions = {
  aliases: LightAliasRegistry;
  /** Runner-only experiment; production keeps compact search until the offline gate is met. */
  experimentalSearchExpansion?: boolean;
  files: WorkspaceFiles;
  references: LightReferenceSearch;
  registerCoverage(path: string, content: Buffer, intervals: ByteInterval[]): Promise<unknown>;
};

/** search_code over the current workspace snapshot: paths, text, symbols and references. */
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

  async search(input: LightSearchCodeInput, signal?: AbortSignal): Promise<LightToolResult<unknown>> {
    const snapshot = await this.files.snapshot(signal);
    const candidates = scopedCandidates(this.files, snapshot.files, input.scope);
    if (!candidates.length) return emptySearchScope(this.files, snapshot.files, input);
    const revision = snapshot.revision.source_revision_id;
    const semantic = input.mode === "references"
      ? await this.references.search(input, snapshot.files, candidates, revision, signal)
      : undefined;
    if (semantic && "status" in semantic) return semantic;
    const result = await this.searchResult(
      semantic ? { ...input, query: semantic.lexicalQuery } : input,
      searchMode(input),
      candidates,
      revision,
      signal,
    );
    let labeled = semantic && result.status === "ok" ? { ...result, data: { ...recordValue(result.data),
      semanticFallback: semantic.fallback,
      ...await this.references.recovery(input, semantic.fallback, candidates, revision, signal) } } : result;
    // Keep the original lexical/symbol results and explicit target choice. The
    // bounded syntax route is also reachable from ordinary searches, even when
    // early call sites or substring matches crowd out the exact declaration.
    if (!semantic && result.status === "ok") {
      const query = declarationQuery(input.query), data = recordValue(result.data);
      const exact = arrayValue(data.results).some(value => {
        const item = recordValue(value);
        return item.reason === "symbol_name" && typeof item.qualifiedName === "string" &&
          (item.qualifiedName === query || item.qualifiedName.endsWith(`.${query}`));
      });
      if (query && !exact) {
        const discovery = await this.references.declarations({ ...input, query }, candidates, revision, signal);
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
    input: LightSearchCodeInput,
    mode: SearchMode,
    candidates: string[],
    revision: string,
    signal?: AbortSignal,
  ): Promise<LightToolResult<unknown>> {
    if (mode === "symbol" && input.mode === "symbol")
      return symbolSearchResult(await this.symbolSearch(input.query, candidates, revision, signal), candidates);
    const text = await this.textSearch(input.query, candidates, revision, input.mode !== "text", signal);
    if (mode !== "symbol") return textSearchResult(mode, text, candidates);
    const symbolCandidates = autoSymbolCandidates(text.results, candidates, input.query);
    const symbols = await this.symbolSearch(input.query, symbolCandidates, revision, signal);
    return autoSearchResult(symbols, text, candidates);
  }

  private async symbolSearch(query: string, candidates: string[], revision: string, signal?: AbortSignal) {
    const selected: Array<{ path: string; content: Buffer; symbol: ParsedSymbol; exact: boolean }> = [];
    const normalized = query.toLocaleLowerCase();
    for (const path of candidates) {
      signal?.throwIfAborted();
      if (selected.length === 8) break;
      if (!symbolicPath(path)) continue;
      const content = (await this.files.read(path)).content;
      if (content.byteLength > 2 * 1024 * 1024) continue;
      for (const symbol of parseCode(path, content).symbols) {
        if (!symbolMatches(symbol, normalized)) continue;
        const exact = symbol.name.toLocaleLowerCase() === normalized ||
          symbol.qualified_name.toLocaleLowerCase() === normalized;
        if (selected.length < 8) selected.push({ path, content, symbol, exact });
        else if (exact && !selected.at(-1)!.exact) {
          selected.pop();
          selected.push({ path, content, symbol, exact });
        }
        // Stable ties retain candidate/source order. Scan the already parsed
        // file for exact names, but retain the bound on visiting further files.
        selected.sort((left, right) => Number(right.exact) - Number(left.exact));
        if (selected.length === 8 && selected.every((item) => item.exact)) break;
      }
    }
    // Register only returned aliases; discovery still grants no read coverage.
    return selected.map(({ path, content, symbol }) => this.symbolResult(path, content, symbol, revision));
  }

  private symbolResult(path: string, content: Buffer, symbol: ParsedSymbol, revision: string, reason?: string) {
    const { alias, materialized } = this.aliases.registerSymbol(path, content, symbol, revision);
    return searchSymbolResult(alias, path, materialized, reason);
  }

  private async textSearch(
    query: string,
    candidates: string[],
    revision: string,
    promoteSymbols: boolean,
    signal?: AbortSignal,
  ): Promise<TextSearchResults> {
    const paths = pathSearch(this.aliases, query, candidates);
    const searched = await searchWithRipgrep({
      candidates,
      maximum: 32,
      query: lexicalQuery(query),
      root: this.files.root,
      signal,
    });
    const content = searched.available
      ? await this.materializeMatches(rankedTextMatches(searched.items, query), revision, promoteSymbols)
      : await nodeTextSearch(this.files, this.aliases, query, candidates, signal);
    const results = uniqueSearchResults([...paths, ...content]);
    return { results: results.slice(0, 8), engine: searched.engine,
      limited: !searched.available || searched.truncated || content.length >= 8 || paths.length >= 8 || results.length > 8 };
  }

  private async materializeMatches(matches: LexicalSearchMatch[], revision: string, promote: boolean) {
    const sources = new Map<string, SearchSource>();
    let results: unknown[] = [];
    for (const match of matches) {
      let source = sources.get(match.path);
      if (!source) {
        const { content } = await this.files.read(match.path);
        source = { content, symbols: promote && symbolicPath(match.path) ? parseCode(match.path, content).symbols : [] };
        sources.set(match.path, source);
      }
      results = uniqueSearchResults([...results, this.textMatch(match, revision, source)]);
      if (results.length >= 8) break;
    }
    return results;
  }

  private textMatch(match: LexicalSearchMatch, revision: string, source: SearchSource) {
    const { content } = source;
    const symbol = enclosingSymbol(source.symbols, match.range_utf8_bytes);
    if (symbol) return this.symbolResult(match.path, content, symbol, revision, "lexical_symbol");
    const alias = this.aliases.registerRange(match.path, content, match.range_utf8_bytes);
    return {
      alias,
      kind: "text",
      path: match.path,
      lines: match.line_range,
      snippet: match.excerpt,
      reason: match.match_reason,
    };
  }
}
