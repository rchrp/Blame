import {
  materializeSymbol,
  parseCode,
  semanticLanguageName,
  type CodeSymbol,
  type ParsedSymbol,
} from "./code-intelligence.js";
import { sha256 } from "./light-identity.js";
import type { WorkspaceFiles } from "./workspace-files.js";

type SymbolAlias = {
  alias: string;
  contentHash?: string;
  observed?: Array<[number, number]>;
  end: number;
  fileHash: string;
  kind: "symbol";
  language: string;
  path: string;
  qualifiedName: string;
  symbolKind: string;
  start: number;
};

type RangeAlias = {
  alias: string;
  end: number;
  fileHash: string;
  kind: "range";
  path: string;
  start: number;
};

type PathAlias = {
  alias: string;
  kind: "path";
  path: string;
};

export type LightAlias = SymbolAlias | RangeAlias | PathAlias;

export type ResolvedLightSymbol = {
  alias?: string;
  content: Buffer;
  materialized: CodeSymbol;
  path: string;
  symbol: ParsedSymbol;
};

export class SymbolResolutionError extends Error {
  readonly candidates: Array<{
    kind: string;
    line: number;
    qualifiedName: string;
  }>;

  constructor(
    message: string,
    candidates: SymbolResolutionError["candidates"] = [],
  ) {
    super(message);
    this.candidates = candidates;
  }
}

export class LightAliasRegistry {
  private readonly aliases = new Map<string, LightAlias>();
  private readonly observations = new Map<string, { hash: string; intervals: Array<[number, number]> }>();
  private sequence = 0;

  registerSymbol(
    path: string,
    content: Buffer,
    symbol: ParsedSymbol,
    revision: string,
  ) {
    const materialized = materializeSymbol({ symbol, path, revision, content });
    const existing = this.reusableSymbol(path, content, symbol);
    if (existing) {
      this.updateSymbol(existing.alias, path, content, symbol);
      return { alias: existing.alias, materialized };
    }
    const alias = this.nextAlias();
    this.updateSymbol(alias, path, content, symbol);
    return { alias, materialized };
  }

  registerPath(path: string) {
    const existing = [...this.aliases.values()].find(
      (entry) => entry.kind === "path" && entry.path === path,
    );
    if (existing) return existing.alias;
    const alias = this.nextAlias();
    this.aliases.set(alias, { alias, kind: "path", path });
    return alias;
  }

  registerRange(path: string, content: Buffer, range: [number, number]) {
    const fileHash = sha256(content);
    const existing = [...this.aliases.values()].find(
      (entry) =>
        entry.kind === "range" &&
        entry.path === path &&
        entry.fileHash === fileHash &&
        entry.start === range[0] &&
        entry.end === range[1],
    );
    if (existing) return existing.alias;
    const alias = this.nextAlias();
    this.aliases.set(alias, {
      alias,
      end: range[1],
      fileHash,
      kind: "range",
      path,
      start: range[0],
    });
    return alias;
  }

  get(alias: string) {
    return this.aliases.get(alias);
  }

  entries() {
    return [...this.aliases.values()].map((entry) => ({ ...entry }));
  }

  observe(path: string, content: Buffer, intervals: Array<[number, number]>) {
    const hash = sha256(content);
    this.rememberObservation(path, hash, intervals);
    for (const entry of this.aliases.values()) {
      if (entry.kind !== "symbol" || entry.path !== path || entry.fileHash !== hash) continue;
      entry.observed = mergedIntervals([...(entry.observed ?? []), ...intervals.map(([start, end]): [number, number] =>
        [Math.max(0, start - entry.start), Math.min(entry.end - entry.start, end - entry.start)])]
        .filter(([start, end]) => end > start));
    }
  }

  rememberObservation(path: string, hash: string, intervals: Array<[number, number]>) {
    const previous = this.observations.get(path);
    this.observations.set(path, { hash, intervals: mergedIntervals([
      ...(previous?.hash === hash ? previous.intervals : []), ...intervals,
    ]) });
    if (this.observations.size > 500) this.observations.delete(this.observations.keys().next().value!);
  }

  assertObserved(alias: string | undefined, range: [number, number]) {
    const entry = alias ? this.aliases.get(alias) : undefined;
    if (entry?.kind !== "symbol") throw new SymbolResolutionError("Read the target before replacing it.");
    let cursor = range[0];
    for (const [start, end] of [...(entry.observed ?? [])].sort((a, b) => a[0] - b[0])) {
      if (start > cursor) break;
      cursor = Math.max(cursor, end);
    }
    if (cursor < range[1]) throw new SymbolResolutionError(`Read ${alias} before replacing unobserved source.`);
  }

  hydrate(entries: LightAlias[]) {
    this.aliases.clear();
    for (const entry of entries) this.aliases.set(entry.alias, { ...entry });
    this.sequence = Math.max(0, ...entries.map(aliasSequence));
  }

  async resolveSymbol(
    target: string,
    files: WorkspaceFiles,
    revision: string,
    forEdit = false,
  ) {
    const entry = this.targetAlias(target, files);
    if (entry) return this.resolveAlias(entry, files, revision, forEdit);
    const resolvedTarget = await this.resolveQualifiedTarget(target, files, revision);
    if (!forEdit) return resolvedTarget;
    const { alias } = this.registerSymbol(resolvedTarget.path, resolvedTarget.content, resolvedTarget.symbol, revision);
    return { ...resolvedTarget, alias };
  }

  private targetAlias(target: string, files: WorkspaceFiles) {
    const direct = this.aliases.get(target);
    if (direct) return direct;
    const separator = target.lastIndexOf("#");
    if (separator < 1) return undefined;
    const path = files.normalizePath(target.slice(0, separator));
    const name = target.slice(separator + 1);
    const entry = this.aliases.get(name);
    if (entry?.kind === "symbol" && entry.path === path) return entry;
    const matching = [...this.aliases.values()].filter(
      (alias) =>
        alias.kind === "symbol" &&
        alias.path === path &&
        alias.qualifiedName === name,
    );
    return matching.length === 1 ? matching[0] : undefined;
  }

  private async resolveAlias(
    entry: LightAlias,
    files: WorkspaceFiles,
    revision: string,
    forEdit: boolean,
  ): Promise<ResolvedLightSymbol> {
    if (entry.kind !== "symbol")
      throw new SymbolResolutionError(
        `${entry.alias} is a ${entry.kind} target, not a symbol.`,
      );
    const content = (await files.read(entry.path)).content;
    const parsed = parseCode(entry.path, content);
    const exact = sha256(content) === entry.fileHash;
    const candidates = parsed.symbols.filter((symbol) =>
      exact ? sameRange(symbol, entry) : sameIdentity(symbol, entry),
    );
    if (candidates.length !== 1)
      throw resolutionConflict(entry.qualifiedName, candidates);
    if (forEdit && !exact) assertObservedSymbol(entry, content, candidates[0]!);
    if (!forEdit) this.updateSymbol(entry.alias, entry.path, content, candidates[0]!);
    return resolved(entry.path, content, candidates[0]!, revision, entry.alias);
  }

  private async resolveQualifiedTarget(
    target: string,
    files: WorkspaceFiles,
    revision: string,
  ) {
    const separator = target.lastIndexOf("#");
    if (separator < 1 || separator === target.length - 1)
      throw new SymbolResolutionError(
        "Use a symbol alias or path#qualifiedName.",
      );
    const path = files.normalizePath(target.slice(0, separator));
    const qualifiedName = target.slice(separator + 1);
    const content = (await files.read(path)).content;
    const symbols = parseCode(path, content).symbols;
    const candidates = symbols.filter(
      (symbol) => symbol.qualified_name === qualifiedName,
    );
    if (candidates.length === 0) {
      const trimmed = qualifiedName.trim();
      const canonical = `${path}#${trimmed}`;
      const alternatives = trimmed && trimmed !== qualifiedName
        ? symbols.filter(symbol => symbol.qualified_name === trimmed) : [];
      const entry = alternatives.length === 1 ? this.targetAlias(canonical, files) : undefined;
      const safeSuggestion = !entry || entry.kind === "symbol" &&
        entry.qualifiedName === trimmed && entry.fileHash === sha256(content);
      const suggestion = alternatives.length === 1 && safeSuggestion
        ? ` Whitespace around the qualified name prevents an exact match. Suggested read_code input: ${JSON.stringify({ target: canonical })}`
        : "";
      throw new SymbolResolutionError(`No indexed declaration matches ${JSON.stringify(qualifiedName)} in ${path}.${suggestion || " Use a text search or short file range for source not indexed here."}`);
    }
    if (candidates.length !== 1)
      throw resolutionConflict(qualifiedName, candidates);
    return resolved(path, content, candidates[0]!, revision);
  }

  private nextAlias() {
    return `s${++this.sequence}`;
  }

  private exactSymbol(path: string, content: Buffer, symbol: ParsedSymbol) {
    const fileHash = sha256(content);
    return [...this.aliases.values()].find(
      (entry): entry is SymbolAlias =>
        entry.kind === "symbol" &&
        entry.path === path &&
        entry.fileHash === fileHash &&
        sameRange(symbol, entry),
    );
  }

  private reusableSymbol(path: string, content: Buffer, symbol: ParsedSymbol) {
    const exact = this.exactSymbol(path, content, symbol);
    if (exact) return exact;
    // A same-name declaration is not a unique identity when overloads or other
    // duplicate indexed declarations coexist in the current source.
    const current = parseCode(path, content).symbols.filter(candidate =>
      candidate.kind === symbol.kind && candidate.qualified_name === symbol.qualified_name);
    if (current.length !== 1) return undefined;
    const matches = [...this.aliases.values()].filter(
      (entry): entry is SymbolAlias =>
        entry.kind === "symbol" &&
        entry.path === path &&
        sameIdentity(symbol, entry),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private updateSymbol(
    alias: string,
    path: string,
    content: Buffer,
    symbol: ParsedSymbol,
  ) {
    const previous = this.aliases.get(alias);
    const next = symbolAlias(alias, path, content, symbol);
    if (previous?.kind === "symbol" && previous.contentHash === next.contentHash)
      next.observed = previous.observed;
    const observed = this.observations.get(path);
    if (observed?.hash === next.fileHash) next.observed = mergedIntervals([
      ...(next.observed ?? []), ...observed.intervals.map(([start, end]): [number, number] =>
        [Math.max(0, start - next.start), Math.min(next.end - next.start, end - next.start)]),
    ].filter(([start, end]) => end > start));
    this.aliases.set(alias, next);
  }
}

function mergedIntervals(intervals: Array<[number, number]>) {
  const output: Array<[number, number]> = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const previous = output.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else output.push([start, end]);
  }
  return output;
}

function symbolAlias(
  alias: string,
  path: string,
  content: Buffer,
  symbol: ParsedSymbol,
): SymbolAlias {
  return {
    alias,
    contentHash: symbolContentHash(content, symbol),
    end: symbol.range_utf8_bytes[1],
    fileHash: sha256(content),
    kind: "symbol",
    language: semanticLanguageName(path),
    path,
    qualifiedName: symbol.qualified_name,
    symbolKind: symbol.kind,
    start: symbol.range_utf8_bytes[0],
  };
}

function symbolContentHash(content: Buffer, symbol: ParsedSymbol) {
  return sha256(content.subarray(...symbol.range_utf8_bytes));
}

function assertObservedSymbol(
  entry: SymbolAlias,
  content: Buffer,
  symbol: ParsedSymbol,
) {
  if (entry.contentHash === symbolContentHash(content, symbol)) return;
  const current = content.subarray(...symbol.range_utf8_bytes).toString("utf8");
  throw new SymbolResolutionError(
    `Symbol ${entry.qualifiedName} changed since it was observed. Read ${entry.alias} to refresh before editing. Current target:\n${current.slice(0, 4_000)}`,
  );
}

function aliasSequence(entry: LightAlias) {
  const value = Number.parseInt(entry.alias.slice(1), 10);
  return Number.isFinite(value) ? value : 0;
}

function sameIdentity(symbol: ParsedSymbol, entry: SymbolAlias) {
  return (
    symbol.kind === entry.symbolKind &&
    symbol.qualified_name === entry.qualifiedName &&
    semanticLanguageName(entry.path) === entry.language
  );
}

function sameRange(symbol: ParsedSymbol, entry: SymbolAlias) {
  return (
    symbol.kind === entry.symbolKind &&
    symbol.range_utf8_bytes[0] === entry.start &&
    symbol.range_utf8_bytes[1] === entry.end
  );
}

function resolved(
  path: string,
  content: Buffer,
  symbol: ParsedSymbol,
  revision: string,
  alias?: string,
): ResolvedLightSymbol {
  return {
    ...(alias ? { alias } : {}),
    content,
    materialized: materializeSymbol({ symbol, path, revision, content }),
    path,
    symbol,
  };
}

function resolutionConflict(name: string, candidates: ParsedSymbol[]) {
  return new SymbolResolutionError(
    candidates.length
      ? `Symbol ${name} is ambiguous in its original file.`
      : `Symbol ${name} no longer exists in its original file.`,
    candidates.slice(0, 5).map((symbol) => ({
      kind: symbol.kind,
      line: symbol.line_range[0],
      qualifiedName: symbol.qualified_name,
    })),
  );
}
