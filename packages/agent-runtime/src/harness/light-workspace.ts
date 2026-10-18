import type { AgentToolContext } from "@cline/sdk";
import { codeObservation, presentObservation } from "./code-observation.js";
import { readIsolatedEnvironmentImage, readWorkspaceImage } from "./light-images.js";
import { pythonBodyRange } from "./python-body.js";
import {
  outlineSymbol,
  parseCode,
  symbolEditRange,
  type ParsedSymbol,
} from "./code-intelligence.js";
import { LightAliasRegistry, type ResolvedLightSymbol } from "./light-aliases.js";
import { capabilityForPath } from "./light-capabilities.js";
import type {
  LightEditCodeInput,
  LightReadCodeInput,
  LightRunTaskInput,
  LightSearchCodeInput,
  LightTaskContract,
  LightToolResult,
} from "./light-contracts.js";
import { LightEditService } from "./light-edit.js";
import { LightCommitService } from "./light-commit.js";
import {
  autoSearchResult,
  autoSymbolCandidates,
  editTargetSymbols,
  emptySearchScope,
  enclosingSymbol,
  lexicalQuery,
  pathMatches,
  qualifiedTarget,
  rankedTextMatches,
  recordValue,
  requestedLineRange,
  routedView,
  scopedCandidates,
  searchMode,
  searchSymbolResult,
  stringValue,
  symbolicPath,
  symbolMatches,
  symbolSearchResult,
  textSearchResult,
  uniqueSearchResults,
  type EditTarget,
  type SearchMode,
  type TextSearchResults,
} from "./light-navigation.js";
import { LightTaskRunner } from "./light-task-runner.js";
import { LightReferenceSearch } from "./light-reference-search.js";
import { readDependencyDeclaration } from "./light-dependency-read.js";
import { withMissingPathRecovery } from "./light-path-recovery.js";
import {
  searchWithRipgrep,
  type LexicalSearchMatch,
} from "./lexical-search.js";
import { ReadCoverage, type ByteInterval } from "./read-coverage.js";
import { SessionJournal } from "./session-journal.js";
import { currentValidationReport } from "./light-validation-report.js";
import { sha256 } from "./light-identity.js";
import {
  assertMutableWorkspacePath,
  WorkspaceFiles,
} from "./workspace-files.js";
import {
  arrayValue,
  capabilitiesResult,
  contentResult,
  contextGeneration,
  coveredDirectoryResult,
  directoryEntries,
  emptyOutline,
  enclosingOutlineTarget,
  inputBlocked,
  lineByteRange,
  nodeTextSearch,
  outlineRangeCandidates,
  outlineResult,
  readableSource,
  type ReadContext,
  shortImportBlock,
  signatureRange,
  symbolContentResult,
} from "./light-read-results.js";

type LightWorkspaceOptions = {
  /** Runner-only experiment; production keeps compact search until the offline gate is met. */
  experimentalSearchExpansion?: boolean;
  /** Test/embedded runner override; production uses the five-second initial wait. */
  initialCommandWaitMs?: number;
  refreshPreviewDependencies?: () => Promise<unknown>;
  sessionId: string;
  taskContract?: LightTaskContract;
};
type SearchSource = { content: Buffer; symbols: ParsedSymbol[] };

const maximumRawCharacters = 64_000;
const maximumOutlineItems = 32;
const maximumDirectoryEntries = 64;

export class LightWorkspace {
  readonly edits: LightEditService;
  readonly tasks: LightTaskRunner;
  private readonly aliases = new LightAliasRegistry();
  private readonly references: LightReferenceSearch;
  private readonly coverage = new ReadCoverage();
  private readonly files: WorkspaceFiles;
  private readonly journal: SessionJournal;
  private initialization?: Promise<void>;
  private readonly options: LightWorkspaceOptions;
  private readonly commits: LightCommitService;

  constructor(workspaceRoot: string, options: LightWorkspaceOptions) {
    this.files = new WorkspaceFiles(workspaceRoot);
    this.references = new LightReferenceSearch(this.files, this.aliases);
    this.commits = new LightCommitService(this.files);
    this.journal = new SessionJournal(workspaceRoot, options.sessionId);
    this.options = options;
    this.edits = new LightEditService(this.aliases, {
      files: this.files,
      journal: this.journal,
    });
    this.tasks = new LightTaskRunner({
      commandEnvironment: options.taskContract?.environment,
      edits: this.edits,
      files: this.files,
      ...(options.initialCommandWaitMs !== undefined
        ? { initialCommandWaitMs: options.initialCommandWaitMs }
        : {}),
      journal: this.journal,
      refreshPreviewDependencies: options.refreshPreviewDependencies,
    });
  }

  private get ready() {
    return (this.initialization ??= this.initializeJournal(this.options));
  }

  async editCode(
    input: LightEditCodeInput,
    context: {
      sessionId?: string;
      toolCallId?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    await this.ready;
    const result = await this.edits.edit(input, context);
    if (result.status === "ok")
      for (const change of arrayValue(recordValue(result.data).changes)) {
        const path = stringValue(recordValue(change).path);
        if (path) this.coverage.invalidatePath(path);
      }
    await this.journal.recordCoverage(this.coverage.snapshot());
    return result;
  }

  async runTask(input: LightRunTaskInput, context: AgentToolContext) {
    await this.ready;
    if (input.kind === "analyze") {
      const { analyzeWorkspaceSymbol } = await import("./light-symbolic-analysis.js");
      return analyzeWorkspaceSymbol(this.files, this.aliases, input, context.signal);
    }
    const result = await this.tasks.run(input, context);
    if (result.status !== "ok") return result;
    const paths = arrayValue(recordValue(result.data).paths).flatMap(
      (value) => {
        const path = stringValue(value);
        return path ? [path] : [];
      },
    );
    for (const path of paths) this.coverage.invalidatePath(path);
    if (paths.length)
      await this.journal.recordCoverage(this.coverage.snapshot());
    if (recordValue(recordValue(result.data).check).outcome === "failed") {
      const data = recordValue(result.data);
      const output = typeof data.output === "string" ? data.output : "";
      const snippets: unknown[] = [];
      let remaining = 4 * 1024;
      const seen = new Set<string>();
      const locations = [
        ...arrayValue(recordValue(data.check).diagnostics).flatMap((value) => {
          const diagnostic = recordValue(value);
          return typeof diagnostic.path === "string" && typeof diagnostic.line === "number"
            ? [{ path: diagnostic.path, line: diagnostic.line }] : [];
        }),
        ...[...output.matchAll(/(?:^|\s|\()([^\s():]+\.(?:[cm]?[jt]sx?|py|java|cs)):(\d+)(?::\d+)?/gmu)]
          .map((match) => ({ path: match[1]!, line: Number(match[2]) })),
      ];
      for (const location of locations) {
        const { line } = location;
        let path: string;
        try { path = this.files.normalizePath(location.path); } catch { continue; }
        if (snippets.length >= 2) break;
        if (seen.has(path)) continue;
        seen.add(path);
        if (!Number.isSafeInteger(line) || line < 1) continue;
        try {
          const content = (await this.files.read(path)).content;
          const [start, end] = lineByteRange(content, Math.max(1, line - 2), line + 2);
          if (end - start > remaining - 512) continue;
        } catch { continue; }
        const snippet = await this.readCode({ target: path, view: "range",
          range: { startLine: Math.max(1, line - 2), endLine: line + 2 } }, context);
        if (snippet.status !== "ok") continue;
        const bytes = Buffer.byteLength(JSON.stringify(snippet.data));
        if (bytes > remaining) continue;
        remaining -= bytes;
        snippets.push({ ...recordValue(snippet.data), source: "current workspace; diagnostic revision not certified" });
      }
      if (snippets.length) return { ...result, data: { ...data, diagnostics: snippets } };
    }
    return result;
  }

  async searchCode(
    input: LightSearchCodeInput,
    signal?: AbortSignal,
  ): Promise<LightToolResult<unknown>> {
    try {
      await this.ready;
      const result = await this.commits.exclusive(() =>
        this.searchCurrentWorkspace(input, signal),
      );
      await this.recordObservationAudit("search_code", input.mode ?? "auto", result);
      return result;
    } catch (error) {
      return inputBlocked(error);
    }
  }

  private async searchCurrentWorkspace(
    input: LightSearchCodeInput,
    signal?: AbortSignal,
  ) {
    const snapshot = await this.files.snapshot(signal);
    const candidates = scopedCandidates(
      this.files,
      snapshot.files,
      input.scope,
    );
    if (!candidates.length) return emptySearchScope(this.files, snapshot.files, input);
    const semantic = input.mode === "references"
      ? await this.references.search(input, snapshot.files, candidates, snapshot.revision.source_revision_id, signal)
      : undefined;
    if (semantic && "status" in semantic) return this.persistAliases(semantic);
    const result = await this.searchResult(
      semantic ? { ...input, query: semantic.lexicalQuery } : input,
      searchMode(input),
      candidates,
      snapshot.revision.source_revision_id,
      signal,
    );
    const labeled = semantic && result.status === "ok" ? { ...result, data: { ...recordValue(result.data),
      semanticFallback: semantic.fallback,
      ...await this.references.recovery(input, semantic.fallback,
        candidates, snapshot.revision.source_revision_id, signal) } } : result;
    const expanded = await this.expandSearch(labeled, snapshot.revision.source_revision_id);
    return this.persistAliases(expanded);
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
      await this.registerCoverage(resolved.path, resolved.content, [resolved.symbol.range_utf8_bytes], {});
    return { ...result, data: { ...data, results, expanded: true,
      searchComplete: true, scope: "Eligible workspace text files up to 2 MiB; ignore rules applied." } };
  }

  async readCode(
    input: LightReadCodeInput,
    context: ReadContext,
  ): Promise<LightToolResult<unknown>> {
    try {
      await this.ready;
      let result = await this.commits.exclusive(() =>
        this.readCurrentWorkspace(input, context),
      );
      if (process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS === "true" && process.env.BLAME_AGENT_SYMBOLIC_HINTS !== "false" && result.status === "ok") {
        const data = recordValue(result.data), path = stringValue(data.path);
        if (path && data.view === "raw" && data.complete === true && typeof data.content === "string") {
          const { symbolicReadHints } = await import("./light-symbolic-hint.js");
          const hints = symbolicReadHints(path, data.content);
          if (hints.length) result = { ...result, data: { ...data, symbolicAnalysis: hints } };
        }
      }
      await this.recordObservationAudit("read_code", input.view ?? "auto", result);
      return result;
    } catch (error) {
      return inputBlocked(error);
    }
  }

  private async readCurrentWorkspace(
    input: LightReadCodeInput,
    context: ReadContext,
  ) {
    context.signal?.throwIfAborted();
    if (input.view === "declaration")
      return readDependencyDeclaration(this.files, input, context.signal);
    if (input.offset !== undefined)
      throw new Error("offset is only supported for declaration continuation.");
    const externalImage = await readIsolatedEnvironmentImage(
      this.files, input.target, context, this.options.taskContract?.environment?.isolated,
    );
    if (externalImage) return externalImage;
    const special = await this.specialReadResult(input.target);
    if (special) return special;
    const snapshot = await this.files.snapshot(context.signal);
    return withMissingPathRecovery(
      {
        files: this.files, input, snapshot,
        literalPath: !this.aliases.get(input.target) && !qualifiedTarget(input.target),
        signal: context.signal,
      },
      async () => {
        const directory = await this.directoryReadResult(input, snapshot.files, context);
        return directory ?? this.readWorkspaceTarget(input, snapshot.revision.source_revision_id, context);
      },
    );
  }

  private async recordObservationAudit(tool: "read_code" | "search_code", requestedView: string, result: LightToolResult<unknown>) {
    if (result.status !== "ok") return;
    const data = recordValue(result.data);
    const targets = arrayValue(data.results ?? data.items ?? data.editTargets);
    await this.journal.recordObservationAudit({ tool, requestedView,
      renderedView: stringValue(data.view ?? data.mode) ?? "unknown",
      bytes: Buffer.byteLength(JSON.stringify(result.data)),
      aliases: targets.filter((item) => stringValue(recordValue(item).alias)).length + (data.alias ? 1 : 0),
      limited: data.limited === true || data.truncated === true });
  }

  private async initializeJournal(options: LightWorkspaceOptions) {
    await this.commits.exclusive(() => this.journal.hydrate());
    this.aliases.hydrate(this.journal.currentAliases());
    this.coverage.hydrate(this.journal.currentCoverage());
    for (const entry of this.journal.currentCoverage().entries)
      this.aliases.rememberObservation(entry.path, entry.hash, entry.intervals);
    const objective = options.taskContract?.objective;
    if (objective) await this.journal.ingestUserRequest("initial", objective);
  }

  private async persistAliases<T>(result: LightToolResult<T>) {
    await this.journal.recordAliases(this.aliases.entries());
    return result;
  }

  private async searchResult(
    input: LightSearchCodeInput,
    mode: SearchMode,
    candidates: string[],
    revision: string,
    signal?: AbortSignal,
  ): Promise<LightToolResult<unknown>> {
    if (mode === "symbol" && input.mode === "symbol")
      return symbolSearchResult(
        await this.symbolSearch(input.query, candidates, revision, signal),
        candidates,
      );
    const text = await this.textSearch(
      input.query,
      candidates,
      revision,
      input.mode !== "text",
      signal,
    );
    if (mode !== "symbol") return textSearchResult(mode, text, candidates);
    const symbolCandidates = autoSymbolCandidates(text.results, candidates, input.query);
    const symbols = await this.symbolSearch(
      input.query,
      symbolCandidates,
      revision,
      signal,
    );
    return autoSearchResult(symbols, text, candidates);
  }

  private async specialReadResult(target: string) {
    if (target === "@checks")
      return { status: "ok" as const, data: currentValidationReport(await this.journal.completionSnapshot()) };
    if (target === "@capabilities") return capabilitiesResult();
    if (target === "@changes")
      return {
        status: "ok" as const,
        data: { changes: this.journal.currentChanges() },
      };
    return undefined;
  }

  private async directoryReadResult(
    input: LightReadCodeInput,
    files: string[],
    context: ReadContext,
  ): Promise<LightToolResult<unknown> | undefined> {
    if (this.aliases.get(input.target) || qualifiedTarget(input.target))
      return undefined;
    const path = this.files.normalizePath(input.target);
    assertMutableWorkspacePath(path);
    if (!(await this.files.pathProfile(path)).directory) return undefined;
    const entries = directoryEntries(path, files);
    const content = Buffer.from(JSON.stringify(entries));
    const coverage = await this.registerCoverage(
      `${path}/`,
      content,
      [[0, content.byteLength]],
      context,
    );
    if (coverage.covered)
      return coveredDirectoryResult(path, coverage.receipt);
    return {
      status: "ok",
      receipt: coverage.receipt,
      data: {
        candidateCount: entries.length,
        entries: entries.slice(0, maximumDirectoryEntries),
        path,
        truncated: entries.length > maximumDirectoryEntries,
        view: "directory",
      },
    };
  }

  private async readWorkspaceTarget(
    input: LightReadCodeInput,
    revision: string,
    context: ReadContext,
  ) {
    const alias = this.aliases.get(input.target);
    const result =
      alias?.kind === "path"
        ? await this.readPath(
            { ...input, target: alias.path },
            revision,
            context,
          )
        : alias?.kind === "range"
          ? await this.readRangeAlias(alias, input, revision, context)
          : alias?.kind === "symbol" || qualifiedTarget(input.target)
            ? await this.readSymbol(input.target, revision, context, input)
            : await this.readPath(input, revision, context);
    return this.persistAliases(result);
  }

  private async symbolSearch(
    query: string,
    candidates: string[],
    revision: string,
    signal?: AbortSignal,
  ) {
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
    const paths = this.pathSearch(query, candidates);
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

  private pathSearch(query: string, candidates: string[]) {
    return pathMatches(query, candidates).map((path) => ({
      alias: this.aliases.registerPath(path),
      kind: "path",
      path,
      reason: "path_name",
      target: path,
    }));
  }

  private textMatch(
    match: LexicalSearchMatch,
    revision: string,
    source: SearchSource,
  ) {
    const { content } = source;
    const symbol = enclosingSymbol(source.symbols, match.range_utf8_bytes);
    if (symbol) return this.symbolResult(match.path, content, symbol, revision, "lexical_symbol");
    const alias = this.aliases.registerRange(
      match.path,
      content,
      match.range_utf8_bytes,
    );
    return {
      alias,
      kind: "text",
      path: match.path,
      lines: match.line_range,
      snippet: match.excerpt,
      reason: match.match_reason,
    };
  }

  private async readPath(
    input: LightReadCodeInput,
    revision: string,
    context: ReadContext,
  ): Promise<LightToolResult<unknown>> {
    const path = this.files.normalizePath(input.target);
    assertMutableWorkspacePath(path);
    const image = await readWorkspaceImage(this.files, path, context);
    if (image) return image;
    const file = await this.files.read(path);
    const source = readableSource(file.content);
    const view = routedView(input, path, source.length);
    if (view === "signature")
      throw new Error("Signature view requires a symbol alias or path#qualifiedName. Read the file outline to choose a declaration.");
    if (view === "outline")
      return await this.readOutlinePath(path, file.content, revision, context, input.range);
    if (view === "range")
      return await this.readLineRange(path, file.content, input, revision, context);
    return await this.raw(
      path,
      file.content,
      revision,
      context,
      view === "symbol" ? "symbol_target_missing" : undefined,
    );
  }

  private async readOutlinePath(
    path: string,
    content: Buffer,
    revision: string,
    context: ReadContext,
    range?: LightReadCodeInput["range"],
  ) {
    const parsed = parseCode(path, content);
    if (parsed.supported)
      return await this.outline(
        path,
        content,
        parsed.symbols,
        revision,
        context,
        range,
      );
    return await this.raw(
      path,
      content,
      revision,
      context,
      "symbol_view_unavailable",
    );
  }

  private async readLineRange(
    path: string,
    content: Buffer,
    input: LightReadCodeInput,
    revision: string,
    context: ReadContext,
  ) {
    if (!input.range) throw new Error("range is required for the range view.");
    const range = lineByteRange(
      content,
      input.range.startLine,
      input.range.endLine,
    );
    const editTargets = this.registerEditTargets(path, content, revision, [
      range,
    ]);
    return await this.coveredContent(
      path,
      content,
      [range],
      context,
      "range",
      undefined,
      false,
      editTargets,
    );
  }

  private async outline(
    path: string,
    content: Buffer,
    symbols: ParsedSymbol[],
    revision: string,
    context: ReadContext,
    range?: LightReadCodeInput["range"],
  ): Promise<LightToolResult<unknown>> {
    const projection = await this.prepareOutline(
      path,
      content,
      symbols,
      revision,
      context,
      range,
    );
    if (!projection) return emptyOutline(path);
    const { candidates, coverage, editTargets, selected } = projection;
    const items = this.outlineItems(path, content, selected, revision);
    return outlineResult(
      path,
      items,
      candidates.length,
      coverage.receipt,
      editTargets,
    );
  }

  private async prepareOutline(
    path: string,
    content: Buffer,
    symbols: ParsedSymbol[],
    revision: string,
    context: ReadContext,
    range?: LightReadCodeInput["range"],
  ) {
    const candidates = outlineRangeCandidates(symbols, range);
    const selected = candidates.slice(0, maximumOutlineItems);
    if (!selected.length) return undefined;
    const interval = range
      ? lineByteRange(content, range.startLine, range.endLine)
      : undefined;
    const editTargets = this.registerEditTargets(
      path,
      content,
      revision,
      interval ? [interval] : undefined,
    );
    const coverage = await this.registerCoverage(
      path,
      content,
      selected.map(signatureRange),
      context,
    );
    return { candidates, coverage, editTargets, selected };
  }

  private outlineItems(
    path: string,
    content: Buffer,
    symbols: ParsedSymbol[],
    revision: string,
  ) {
    const registered = symbols.map((symbol) => {
      const { alias, materialized } = this.aliases.registerSymbol(
        path,
        content,
        symbol,
        revision,
      );
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

  private async readSymbol(
    target: string,
    revision: string,
    context: ReadContext,
    input: LightReadCodeInput = { target },
  ): Promise<LightToolResult<unknown>> {
    const resolved = await this.resolveReadSymbol(target, revision);
    if (requestedLineRange(input))
      return this.readLineRange(resolved.path, resolved.content, input, revision, context);
    if (input.view === "outline")
      return this.symbolOutline(resolved, revision, context);
    if (input.view === "signature")
      return this.readSignature(resolved, context);
    const [start, end] = resolved.symbol.range_utf8_bytes;
    if (end - start > maximumRawCharacters) {
      let boundedEnd = start + maximumRawCharacters;
      while (boundedEnd > start && (resolved.content[boundedEnd]! & 0xc0) === 0x80) boundedEnd--;
      return this.coveredContent(resolved.path, resolved.content, [[start, boundedEnd]], context,
        "range", "symbol_exceeds_inline_budget", true,
        [{ alias: resolved.alias!, qualifiedName: resolved.symbol.qualified_name }]);
    }
    const { signature, body, imports, coverage } = await this.symbolProjection(
      resolved,
      context,
    );
    const result = symbolContentResult(
      resolved,
      signature,
      body,
      imports,
      [signature, body, ...coverage.uncovered],
      coverage.receipt,
    );
    if (process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS === "true" && process.env.BLAME_AGENT_SYMBOLIC_HINTS !== "false" && result.status === "ok" &&
        typeof recordValue(result.data).body === "string") {
      const { symbolicReadHints } = await import("./light-symbolic-hint.js");
      const hints = symbolicReadHints(resolved.path, resolved.content.toString("utf8"), resolved.symbol.qualified_name);
      if (hints.length) return { ...result, data: { ...recordValue(result.data), symbolicAnalysis: hints } };
    }
    return result;
  }

  private async resolveReadSymbol(target: string, revision: string) {
    const candidate = await this.aliases.resolveSymbol(
      target,
      this.files,
      revision,
    );
    const registered = this.aliases.registerSymbol(
      candidate.path,
      candidate.content,
      candidate.symbol,
      revision,
    );
    return {
      ...candidate,
      alias: registered.alias,
      materialized: registered.materialized,
    };
  }

  private async readSignature(resolved: ResolvedLightSymbol, context: ReadContext) {
    const [start, end] = signatureRange(resolved.symbol);
    let boundedEnd = Math.min(end, start + 4_096);
    while (boundedEnd > start && (resolved.content[boundedEnd]! & 0xc0) === 0x80) boundedEnd--;
    const coverage = await this.registerCoverage(resolved.path, resolved.content,
      [[start, boundedEnd]], context);
    return { status: "ok" as const, receipt: coverage.receipt, data: {
      path: resolved.path, alias: resolved.alias, view: "signature",
      qualifiedName: resolved.symbol.qualified_name,
      signature: resolved.content.subarray(start, boundedEnd).toString("utf8"),
      truncated: boundedEnd < end, bodyOmitted: boundedEnd < resolved.symbol.range_utf8_bytes[1],
      guidance: "Only these header bytes were read. Use the symbol view for implementation, type members or a complete declaration before editing or rename.",
    } };
  }

  private async symbolOutline(
    resolved: ResolvedLightSymbol,
    revision: string,
    context: ReadContext,
  ) {
    const [start, end] = resolved.symbol.range_utf8_bytes;
    const symbols = parseCode(resolved.path, resolved.content).symbols.filter(
      ({ range_utf8_bytes: range }) => range[0] >= start && range[1] <= end,
    );
    const [startLine, endLine] = resolved.symbol.line_range;
    return this.outline(
      resolved.path,
      resolved.content,
      symbols,
      revision,
      context,
      { startLine, endLine },
    );
  }

  private async symbolProjection(
    resolved: ResolvedLightSymbol,
    context: ReadContext,
  ) {
    const signature = symbolEditRange(resolved.symbol, "signature");
    const range = symbolEditRange(resolved.symbol, "body");
    const body =
      capabilityForPath(resolved.path)?.language === "python"
        ? pythonBodyRange(resolved.content, range)
        : range;
    const imports = shortImportBlock(resolved.content.toString("utf8"));
    const coverage = await this.registerCoverage(
      resolved.path,
      resolved.content,
      [resolved.symbol.range_utf8_bytes, ...(imports ? [imports.range] : [])],
      context,
    );
    return { signature, body, imports, coverage };
  }

  private async readRangeAlias(
    alias: Extract<
      NonNullable<ReturnType<LightAliasRegistry["get"]>>,
      { kind: "range" }
    >,
    input: LightReadCodeInput,
    revision: string,
    context: ReadContext,
  ) {
    const content = (await this.files.read(alias.path)).content;
    if (sha256(content) !== alias.fileHash)
      throw new Error(
        `${alias.alias} is stale and cannot be relocated as text.`,
      );
    if (requestedLineRange(input))
      return this.readLineRange(alias.path, content, input, revision, context);
    if (input.view === "symbol") {
      const symbol = enclosingSymbol(parseCode(alias.path, content).symbols, [
        alias.start,
        alias.end,
      ]);
      if (symbol) {
        const registered = this.aliases.registerSymbol(
          alias.path,
          content,
          symbol,
          revision,
        );
        return this.readSymbol(registered.alias, revision, context);
      }
    }
    const intervals: ByteInterval[] = [[alias.start, alias.end]];
    const editTargets = this.registerEditTargets(
      alias.path,
      content,
      revision,
      intervals,
    );
    return await this.coveredContent(
      alias.path,
      content,
      intervals,
      context,
      "range",
      undefined,
      false,
      editTargets,
    );
  }

  private async raw(
    path: string,
    content: Buffer,
    revision: string,
    context: ReadContext,
    fallbackReason?: string,
  ) {
    let end = Math.min(content.byteLength, maximumRawCharacters);
    while (end > 0 && end < content.length && (content[end]! & 0xc0) === 0x80) end--;
    const editTargets = this.registerEditTargets(path, content, revision);
    return await this.coveredContent(
      path,
      content,
      [[0, end]],
      context,
      "raw",
      fallbackReason,
      content.byteLength > end,
      editTargets,
    );
  }

  private async coveredContent(
    path: string,
    content: Buffer,
    intervals: ByteInterval[],
    context: ReadContext,
    view: "range" | "raw",
    fallbackReason?: string,
    truncated = false,
    editTargets: EditTarget[] = [],
  ): Promise<LightToolResult<unknown>> {
    const coverage = await this.registerCoverage(
      path,
      content,
      intervals,
      context,
    );
    return contentResult(
      path,
      content,
      intervals,
      view,
      coverage.receipt,
      fallbackReason,
      truncated,
      editTargets,
    );
  }

  private registerEditTargets(
    path: string,
    content: Buffer,
    revision: string,
    intervals?: ByteInterval[],
  ) {
    if (content.byteLength > 2 * 1024 * 1024) return [];
    const parsed = parseCode(path, content);
    if (!parsed.supported) return [];
    return editTargetSymbols(parsed.symbols, intervals).map((symbol) => {
      const { alias, materialized } = this.aliases.registerSymbol(
        path,
        content,
        symbol,
        revision,
      );
      return { alias, qualifiedName: materialized.qualified_name };
    });
  }

  private async registerCoverage(
    path: string,
    content: Buffer,
    intervals: ByteInterval[],
    context: ReadContext,
  ) {
    this.aliases.observe(path, content, intervals);
    const result = this.coverage.register({
      consumerId:
        context.agentId ||
        context.conversationId ||
        context.sessionId ||
        "lead",
      generation: contextGeneration(context),
      hash: sha256(content),
      intervals,
      path,
    });
    await this.journal.recordCoverage(this.coverage.snapshot());
    return result;
  }
}
