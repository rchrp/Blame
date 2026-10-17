import { parseCode } from "./code-intelligence.js";
import { LightAliasRegistry } from "./light-aliases.js";
import type {
  LightSearchCodeInput,
  LightToolResult,
} from "./light-contracts.js";
import { sha256 } from "./light-identity.js";
import {
  enclosingSymbol,
  qualifiedTarget,
  searchSymbolResult,
} from "./light-navigation.js";
import {
  querySemanticReferences,
  referenceFootprintIsCurrent,
} from "./semantic-reference-client.js";
import type { WorkspaceFiles } from "./workspace-files.js";
import { referenceDeclarationCandidates } from "./light-reference-candidates.js";

type Fallback = { fallback: string; lexicalQuery: string };

export class LightReferenceSearch {
  private readonly files: WorkspaceFiles;
  private readonly aliases: LightAliasRegistry;

  constructor(files: WorkspaceFiles, aliases: LightAliasRegistry) {
    this.files = files;
    this.aliases = aliases;
  }

  async recovery(input: LightSearchCodeInput, reason: string,
    paths: string[], revision: string, signal?: AbortSignal) {
    const guidance = "Lexical candidates only. For configured JS/TS semantic references, query a symbol sN alias or path#qualifiedName with mode references. Read before editing.";
    if (reason !== "symbol_target_required") return { guidance };
    const found = await referenceDeclarationCandidates(this.files, input.query, paths, revision, signal);
    const declarations = found.candidates.map(({ path, content, symbol, qualifiedUnique }) => {
      const { alias, materialized } = this.aliases.registerSymbol(path, content, symbol, revision);
      return { ...searchSymbolResult(alias, path, materialized, "exact_declaration_candidate"),
        target: qualifiedUnique ? `${path}#${symbol.qualified_name}` : alias };
    });
    return {
      declarationDiscovery: found.discovery,
      declarationCandidates: declarations,
      nextSearches: declarations.length ? declarations.map(({ target }) =>
        ({ query: target, mode: "references", ...(input.scope ? { scope: input.scope } : {}) }))
        : [{ query: input.query, mode: "symbol", ...(input.scope ? { scope: input.scope } : {}) }],
      guidance: guidance + " Declaration candidates are exact syntax matches, not compiler-resolved references. Choose the intended declaration before following nextSearches; discovery is bounded and not exhaustive. No identity was selected and no edit coverage was granted.",
    };
  }

  async search(
    input: LightSearchCodeInput,
    paths: string[],
    candidates: string[],
    revision: string,
    signal?: AbortSignal,
  ): Promise<LightToolResult<unknown> | Fallback> {
    const entry = this.aliases.get(input.query);
    if (entry?.kind !== "symbol" && !qualifiedTarget(input.query))
      return { fallback: "symbol_target_required", lexicalQuery: input.query };
    const resolved = await this.aliases.resolveSymbol(
      input.query,
      this.files,
      revision,
    );
    const lexicalQuery = resolved.symbol.name;
    if (!/\.[cm]?[jt]sx?$/iu.test(resolved.path))
      return { fallback: "unsupported_language", lexicalQuery };
    if (!paths.includes(resolved.path))
      return { fallback: "target_excluded", lexicalQuery };
    const reply = await querySemanticReferences(
      {
        root: this.files.root,
        target: {
          path: resolved.path,
          name: resolved.symbol.qualified_name,
          start: resolved.symbol.range_utf8_bytes[0],
          end: resolved.symbol.range_utf8_bytes[1],
          hash: sha256(resolved.content),
        },
      },
      signal,
    );
    if (reply.status !== "ok") return { fallback: reply.reason, lexicalQuery };
    if (
      !(await referenceFootprintIsCurrent(reply.footprint, signal)) ||
      (await this.files.snapshot(signal)).revision.source_revision_id !==
        revision
    )
      return { fallback: "source_changed", lexicalQuery };
    const allowed = new Set(candidates);
    const scoped = reply.locations.filter((location) =>
      allowed.has(location.path),
    );
    const unique = new Map<string, (typeof scoped)[number]>();
    for (const location of scoped)
      unique.set(`${location.path}:${location.lines.join(":")}`, location);
    const results: unknown[] = [];
    const sources = new Map<string, Buffer>();
    for (const location of [...unique.values()].slice(0, 8)) {
      signal?.throwIfAborted();
      let content = sources.get(location.path);
      if (!content) {
        content = (await this.files.read(location.path)).content;
        const observed = reply.footprint.reads.find(
          (value) =>
            value.path === this.files.resolveForWrite(location.path).absolute,
        );
        if (!observed || observed.hash !== sha256(content))
          return { fallback: "source_changed", lexicalQuery };
        sources.set(location.path, content);
      }
      const symbol = enclosingSymbol(
        parseCode(location.path, content).symbols,
        location.range,
      );
      const registered = symbol
        ? this.aliases.registerSymbol(location.path, content, symbol, revision)
        : undefined;
      const target = registered
        ? searchSymbolResult(
            registered.alias,
            location.path,
            registered.materialized,
            "semantic_reference",
          )
        : {
            alias: this.aliases.registerRange(
              location.path,
              content,
              location.range,
            ),
            kind: "text",
            path: location.path,
            lines: location.lines,
            reason: "semantic_reference",
          };
      results.push({
        ...target,
        reference: {
          lines: location.lines,
          snippet: location.snippet,
          isWrite: location.isWrite,
        },
      });
    }
    return {
      status: "ok",
      data: {
        mode: "references",
        engine: "typescript_language_service",
        target: `${resolved.path}#${resolved.symbol.qualified_name}`,
        sourceRevision: revision,
        navigationOnly: true,
        targetDefinitionExcluded: true,
        project: reply.project,
        completeness: reply.project.warnings.length
          ? "partial_project"
          : "configured_project",
        resultScope:
          "Eligible source files in the requested scope; dependency internals and ignored files excluded.",
        candidateCount: candidates.length,
        referenceCount: unique.size,
        locationCount: scoped.length,
        results,
        limited: unique.size > 8,
        guidance:
          unique.size > 8
            ? "Result limit reached; narrow scope to see other references. No edit coverage is granted."
            : "References are limited to this configured compiler project, not runtime/dynamic callers. Read before editing.",
      },
    };
  }
}
