import { parseCode, symbolEditRange } from "./code-intelligence.js";
import {
  validateContent,
  type ContentValidation,
} from "./content-validation.js";
import type { LightEditCodeInput, LightToolResult } from "./light-contracts.js";
import { capabilityForPath, parseAvailability } from "./light-capabilities.js";
import {
  LightAliasRegistry,
  SymbolResolutionError,
  type LightAlias,
  type ResolvedLightSymbol,
} from "./light-aliases.js";
import { planLightPatch, planScopedLightPatch, splitLightPatch } from "./light-patch.js";
import {
  LightCommitConflict,
  LightCommitService,
  type LightCommitResult,
} from "./light-commit.js";
import type { SessionJournal } from "./session-journal.js";
import type { WorkspaceFiles, WorkspaceSnapshot } from "./workspace-files.js";
import { symbolsTouchedByPatch } from "./patch-symbol-attribution.js";
import { sha256 } from "./light-identity.js";
import { planSemanticRename } from "./light-semantic-rename.js";
import { referenceFootprintIsCurrent } from "./semantic-reference-client.js";
import type { ReferenceFootprint } from "./semantic-reference-types.js";

import { type Replacement, symbolReplacement } from "./light-symbol-replacement.js";

type PlannedFile = {
  bodyTargets?: string[];
  footprint?: ReferenceFootprint;
  semanticRename?: Awaited<ReturnType<typeof planSemanticRename>>["receipt"];
  fileMode?: number;
  initial: Buffer | null;
  mutation?: "add" | "delete";
  path: string;
  replacements: Replacement[];
  symbols: string[];
};

type FinalFile = PlannedFile & {
  content: Buffer | null;
  parse: LightParseResult;
};

type LightParseStatus =
  | "passed"
  | "failed"
  | "unsupported"
  | "unavailable"
  | "degraded_preexisting_errors";

type LightParseResult = {
  diagnostics: string[];
  status: LightParseStatus;
};

type EditContext = {
  sessionId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
};

type LightEditOptions = {
  files: WorkspaceFiles;
  journal: SessionJournal;
};

export type FormattedFileReplacement = {
  before: Buffer;
  content: string;
  path: string;
};

export class LightEditService {
  private readonly aliases: LightAliasRegistry;
  private readonly commits: LightCommitService;
  private readonly files: WorkspaceFiles;
  private readonly journal: SessionJournal;
  private receiptSequence = 0;

  constructor(aliases: LightAliasRegistry, options: LightEditOptions) {
    this.aliases = aliases;
    this.files = options.files;
    this.journal = options.journal;
    this.commits = new LightCommitService(options.files);
  }

  async edit(
    input: LightEditCodeInput,
    context: EditContext = {},
  ): Promise<LightToolResult<unknown>> {
    try {
      const snapshot = await this.files.snapshot(context.signal);
      const plans = await this.plan(input, snapshot, context.signal);
      return await this.applyPlans(plans, snapshot, context.signal);
    } catch (error) {
      return editFailure(error);
    }
  }

  async replaceFiles(
    replacements: FormattedFileReplacement[],
    context: EditContext = {},
  ): Promise<LightToolResult<unknown>> {
    try {
      if (!replacements.length || replacements.length > 50)
        throw new Error("Formatter batch must contain between 1 and 50 files.");
      const snapshot = await this.files.snapshot(context.signal);
      const plans = await this.replacementPlans(replacements);
      return await this.applyPlans(plans, snapshot, context.signal);
    } catch (error) {
      return editFailure(error);
    }
  }

  private async replacementPlans(replacements: FormattedFileReplacement[]) {
    const plans: PlannedFile[] = [];
    for (const replacement of replacements) {
      const path = this.files.normalizePath(replacement.path);
      const plan = await this.filePlan(new Map(), path);
      if (!plan.initial) throw new Error(`${path} does not exist.`);
      if (!plan.initial.equals(replacement.before))
        throw new LightCommitConflict(`File changed before commit: ${path}.`);
      plan.replacements.push({
        start: 0,
        end: plan.initial.byteLength,
        replacement: replacement.content,
        source: `formatter ${path}`,
      });
      plans.push(plan);
    }
    return plans;
  }

  private async applyPlans(
    plans: PlannedFile[],
    snapshot: WorkspaceSnapshot,
    signal?: AbortSignal,
  ): Promise<LightToolResult<unknown>> {
    const finalFiles = await this.finalize(plans);
    const footprint = plans.find((plan) => plan.footprint)?.footprint;
    if (footprint && !(await referenceFootprintIsCurrent(footprint, signal)))
      throw new LightCommitConflict("Semantic rename source or dependency changed before commit.");
    const invalid = finalFiles.find(({ parse }) => parse.status === "failed");
    if (invalid) return invalidParseResult(invalid);
    const result: LightCommitResult | LightEditFailure = await this.commit(
      finalFiles,
      snapshot,
      signal,
    ).catch(commitFailure);
    if (isLightFailure(result)) return result;
    try {
      const mapped = await this.mapResult(result, finalFiles, snapshot);
      const rename = plans.find((plan) => plan.semanticRename)?.semanticRename;
      return rename && mapped.status === "ok" ? { ...mapped, data: {
        ...(mapped.data as Record<string, unknown>), semanticRename: {
          ...rename, engine: "typescript_language_service", scope: "configured_project",
          staticGuard: "no_new_diagnostics_in_changed_files",
          guidance: "Applied the listed compiler-derived binding edits. An import/export's source-side name and namespace property follow the renamed declaration; explicit local/public alias spellings stay unchanged. Examples show individual identifier edits, not a complete diff. Inspect read_code @changes or the final diff before further edits; remaining textual homonyms/comments/literals need not be renamed. Static checks do not establish behavioral equivalence or satisfy required test/validation criteria; run required checks after editing.",
        },
      } } : mapped;
    }
    catch (error) {
      return { status: "failed", category: "harness", applied: true,
        recovery: "recovery_required", paths: result.changedPaths,
        message: `Files were committed but the receipt could not be persisted. Do not replay this batch. ${errorMessage(error)}`,
        diagnosticId: `edit-${Date.now().toString(36)}` };
    }
  }

  private async plan(input: LightEditCodeInput, snapshot: WorkspaceSnapshot, signal?: AbortSignal) {
    const rename = input.operations.find((operation) => operation.kind === "symbol" && operation.action === "rename");
    if (rename?.kind === "symbol") {
      if (input.operations.length !== 1) throw new Error("Semantic rename must be the only operation in a batch.");
      const derived = await planSemanticRename(this.aliases, this.files, snapshot, rename.target, rename.content!, signal);
      const plans = new Map<string, PlannedFile>();
      for (const location of derived.reply.locations) {
        const file = await this.filePlan(plans, location.path, derived.sources.get(location.path));
        file.footprint = derived.reply.footprint;
        file.semanticRename = derived.receipt;
        if (file.path === derived.targetPath) file.symbols.push(derived.oldQualifiedName, derived.newQualifiedName);
        file.replacements.push({ start: location.range[0], end: location.range[1],
          replacement: location.replacement!, source: `semantic rename ${rename.target}` });
      }
      for (const file of plans.values()) file.symbols.push(...symbolsTouchedByPatch(file.path, file.initial, { mode: "update", replacements: file.replacements }));
      return [...plans.values()];
    }
    const files = new Map<string, PlannedFile>();
    let operationCount = 0;
    for (const operation of input.operations) {
      if (operation.kind === "patch") {
        if (operation.target) {
          if (++operationCount > 50) throw new Error("Edit batch contains too many operations.");
          await this.planScopedPatch(files, operation, snapshot);
          continue;
        }
        operationCount += await this.planPatch(
          files,
          operation.path,
          operation.patch,
          50 - operationCount,
        );
      } else {
        if (operationCount >= 50)
          throw new Error("Edit batch contains too many operations.");
        operationCount += 1;
        await this.planSymbol(files, operation, snapshot);
      }
    }
    for (const file of files.values()) assertCompatibleMutations(file);
    return [...files.values()];
  }

  private async planPatch(
    plans: Map<string, PlannedFile>,
    requestedPath: string | undefined,
    patch: string,
    remainingOperations: number,
  ) {
    const normalizedPatch = await this.normalizeNewFilePatch(
      plans,
      requestedPath,
      patch,
    );
    const operations = splitLightPatch(normalizedPatch, requestedPath);
    if (operations.length > remainingOperations)
      throw new Error("Edit batch contains too many operations.");
    for (const operation of operations)
      await this.planPatchFile(plans, operation.path, operation.patch);
    return operations.length;
  }

  private async planScopedPatch(
    plans: Map<string, PlannedFile>,
    operation: Extract<LightEditCodeInput["operations"][number], { kind: "patch" }>,
    snapshot: WorkspaceSnapshot,
  ) {
    if (!this.aliases.get(operation.target!))
      throw new SymbolResolutionError("A scoped patch requires an observed symbol alias.");
    const resolved = await this.aliases.resolveSymbol(operation.target!, this.files,
      snapshot.revision.source_revision_id, true);
    try {
      await this.planResolvedScopedPatch(plans, operation, resolved);
    } catch (error) {
      throw new ScopedEditRecovery(errorMessage(error), resolved,
        error instanceof ScopedPatchShapeError ? error.correction
          : scopedContextCorrection(operation.patch, resolved, errorMessage(error)));
    }
  }

  private async planResolvedScopedPatch(
    plans: Map<string, PlannedFile>,
    operation: Extract<LightEditCodeInput["operations"][number], { kind: "patch" }>,
    resolved: ResolvedLightSymbol,
  ) {
    const sections = splitLightPatch(operation.patch);
    if (sections.length !== 1 || this.files.normalizePath(sections[0]!.path) !== resolved.path ||
        (operation.path && this.files.normalizePath(operation.path) !== resolved.path))
      throw new ScopedPatchShapeError(resolved.path, sections.map(({ path }) => path), operation.path);
    const [start, end] = resolved.symbol.range_utf8_bytes;
    const source = resolved.content.subarray(start, end).toString("utf8");
    const replacements = planScopedLightPatch(source, sections[0]!.patch, resolved.path);
    const file = await this.filePlan(plans, resolved.path, resolved.content);
    file.symbols.push(resolved.symbol.qualified_name);
    for (const replacement of replacements) {
      this.aliases.assertObserved(resolved.alias, [replacement.start, replacement.end]);
      if (replacement.start === replacement.end &&
          (replacement.start === 0 || replacement.end === end - start))
        throw new Error("Use insert_before or insert_after for a symbol boundary insertion.");
      file.replacements.push({ ...replacement, start: start + replacement.start,
        end: start + replacement.end, source: `patch ${resolved.alias}` });
    }
    let scoped = resolved.content.subarray(start, end);
    for (const replacement of [...replacements].reverse())
      scoped = Buffer.concat([scoped.subarray(0, replacement.start), Buffer.from(replacement.replacement), scoped.subarray(replacement.end)]);
    const candidate = Buffer.concat([resolved.content.subarray(0, start), scoped, resolved.content.subarray(end)]);
    const boundary = parseCode(resolved.path, candidate).symbols.filter((symbol) =>
      symbol.kind === resolved.symbol.kind && symbol.range_utf8_bytes[0] === start &&
      symbol.range_utf8_bytes[1] === start + scoped.length);
    if (boundary.length !== 1)
      throw new SymbolResolutionError("Scoped patch changes a declaration boundary; use an explicit symbol action.");
  }

  private async normalizeNewFilePatch(
    plans: Map<string, PlannedFile>,
    requestedPath: string | undefined,
    patch: string,
  ) {
    if (!requestedPath || hasClinePatchEnvelope(patch)) return patch;
    const path = this.files.normalizePath(requestedPath);
    if (plans.has(path) || (await optionalFile(this.files, path))) return patch;
    return completeNewFilePatch(path, patch);
  }

  private async planPatchFile(
    plans: Map<string, PlannedFile>,
    requestedPath: string,
    patch: string,
  ) {
    const path = this.files.normalizePath(requestedPath);
    const file = await this.filePlan(plans, path);
    const source = file.initial?.toString("utf8");
    const patchPlan = await planLightPatch(
      this.files.root,
      path,
      source,
      patch,
    );
    file.symbols.push(...symbolsTouchedByPatch(path, file.initial, patchPlan));
    applyPatchPlan(file, path, patchPlan);
  }

  private async planSymbol(
    plans: Map<string, PlannedFile>,
    operation: Extract<
      LightEditCodeInput["operations"][number],
      { kind: "symbol" }
    >,
    snapshot: WorkspaceSnapshot,
  ) {
    const resolved = await this.aliases.resolveSymbol(
      operation.target,
      this.files,
      snapshot.revision.source_revision_id,
      true,
    );
    assertSymbolEditAvailable(resolved.path);
    if (["replace", "replace_body", "delete"].includes(operation.action)) {
      const range = operation.action === "replace_body"
        ? symbolEditRange(resolved.symbol, "body") : resolved.symbol.range_utf8_bytes;
      this.aliases.assertObserved(resolved.alias, [range[0] - resolved.symbol.range_utf8_bytes[0],
        range[1] - resolved.symbol.range_utf8_bytes[0]]);
    }
    const file = await this.filePlan(plans, resolved.path, resolved.content);
    file.symbols.push(resolved.symbol.qualified_name);
    file.replacements.push(symbolReplacement(resolved, operation));
    if (operation.action === "replace_body") (file.bodyTargets ??= []).push(resolved.alias ?? operation.target);
  }

  private async filePlan(
    plans: Map<string, PlannedFile>,
    path: string,
    knownContent?: Buffer,
  ) {
    const existing = plans.get(path);
    if (existing) return existing;
    const file = await optionalFile(this.files, path);
    const initial = knownContent ?? file?.content ?? null;
    const plan: PlannedFile = {
      initial,
      path,
      replacements: [],
      symbols: [],
      ...(file ? { fileMode: file.mode } : {}),
    };
    plans.set(path, plan);
    return plan;
  }

  private async finalize(plans: PlannedFile[]) {
    return Promise.all(
      plans.map(async (plan): Promise<FinalFile> => {
        const content = applyPlan(plan);
        const parse = await finalParseStatus(
          this.files.root,
          plan.path,
          plan.initial,
          content,
        );
        return { ...plan, content, parse };
      }),
    );
  }

  private commit(
    files: FinalFile[],
    snapshot: WorkspaceSnapshot,
    signal?: AbortSignal,
  ) {
    return this.commits.commit(
      files.map((file) => ({
        after: file.content,
        before: file.initial,
        mode: file.fileMode,
        path: file.path,
      })),
      snapshot.revision.source_revision_id,
      signal,
    );
  }

  private async mapResult(
    result: LightCommitResult,
    files: FinalFile[],
    snapshot: WorkspaceSnapshot,
  ): Promise<LightToolResult<unknown>> {
    if (!result.changedPaths.length)
      return {
        status: "ok",
        data: { changed: false, parse: parseSummary(files),
          ...(files.some(file => file.bodyTargets?.length) ? {
            guidance: "The observed body already matches. replace_body preserves parameters, return type and imports. To change them, read the complete declaration/file and use replace or a file patch; do not repeat this body edit.",
            nextReads: [...new Set(files.flatMap(file => file.bodyTargets ?? []))].map(target => ({ target, view: "symbol" })),
          } : {}),
        },
      };
    return this.appliedResult(files, snapshot, result);
  }

  private async appliedResult(
    files: FinalFile[],
    snapshot: WorkspaceSnapshot,
    result: LightCommitResult,
  ): Promise<LightToolResult<unknown>> {
    const receipt = `c${++this.receiptSequence}`;
    const paths = result.changedPaths;
    const parse = parseSummary(files);
    await this.journal.recordChange({
      beforeFiles: files.map((file) => ({
        path: file.path,
        hash: file.initial ? sha256(file.initial) : "absent",
      })),
      paths,
      receipt,
      sourceRevisionId: result.sourceRevisionId,
      symbols: [...new Set(files.flatMap(({ symbols }) => symbols))],
      parse: parse.status === "passed" ? "passed" : "not_supported",
    });
    const aliases = await this.refreshAliases(
      paths,
      new Set(files.flatMap(({ symbols }) => symbols)),
    );
    await this.journal.recordAliases(this.aliases.entries());
    return appliedEditResult(
      receipt,
      result.sourceRevisionId,
      files,
      aliases,
      parse,
      snapshot,
    );
  }

  private async refreshAliases(paths: string[], touched: Set<string>) {
    const snapshot = await this.files.snapshot();
    const existing = this.aliases.entries();
    const output: Array<{
      alias: string;
      path: string;
      qualifiedName: string;
    }> = [];
    for (const path of paths) {
      const content = (await optionalFile(this.files, path))?.content;
      if (!content) continue;
      const symbols = parseCode(path, content).symbols;
      for (const symbol of symbols) {
        const aliases = matchingAliases(existing, path, symbol);
        if (!aliases.length && !touched.has(symbol.qualified_name)) continue;
        const previouslyComplete = aliases.some((entry) => {
          if (entry.kind !== "symbol") return false;
          try { this.aliases.assertObserved(entry.alias, [0, entry.end - entry.start]); return true; }
          catch { return false; }
        });
        const { alias } = this.aliases.registerSymbol(
          path,
          content,
          symbol,
          snapshot.revision.source_revision_id,
        );
        if (previouslyComplete && touched.has(symbol.qualified_name))
          this.aliases.observe(path, content, [symbol.range_utf8_bytes]);
        if (touched.has(symbol.qualified_name))
          output.push({ alias, path, qualifiedName: symbol.qualified_name });
      }
    }
    return uniqueAliasReceipts(output);
  }
}

function matchingAliases(
  aliases: LightAlias[],
  path: string,
  symbol: ReturnType<typeof parseCode>["symbols"][number],
) {
  return aliases.filter(
    (entry) =>
      entry.kind === "symbol" &&
      entry.path === path &&
      entry.qualifiedName === symbol.qualified_name &&
      entry.symbolKind === symbol.kind,
  );
}

function uniqueAliasReceipts(
  aliases: Array<{ alias: string; path: string; qualifiedName: string }>,
) {
  const seen = new Set<string>();
  return aliases.filter(({ alias }) => {
    if (seen.has(alias)) return false;
    seen.add(alias);
    return true;
  });
}

function applyPatchPlan(
  file: PlannedFile,
  path: string,
  patch: Awaited<ReturnType<typeof planLightPatch>>,
) {
  if (patch.mode === "add") {
    if (file.initial && file.mutation === "delete")
      return replaceDeletedFile(file, path, patch.content);
    if (file.initial) throw new Error(`${path} already exists.`);
    file.mutation = "add";
    file.replacements.push({
      start: 0,
      end: 0,
      replacement: patch.content,
      source: `add ${path}`,
    });
    return;
  }
  if (patch.mode === "delete") {
    if (!file.initial) throw new Error(`${path} does not exist.`);
    file.mutation = "delete";
    return;
  }
  file.replacements.push(
    ...patch.replacements.map((replacement) => ({
      ...replacement,
      source: `patch ${path}`,
    })),
  );
}

function replaceDeletedFile(file: PlannedFile, path: string, content: string) {
  if (file.replacements.length)
    throw new Error(`File replacement cannot overlap another edit in ${path}.`);
  file.mutation = undefined;
  file.replacements.push({
    start: 0,
    end: file.initial!.length,
    replacement: content,
    source: `replace ${path}`,
  });
}

function appliedEditResult(
  receipt: string,
  sourceRevisionId: string,
  files: FinalFile[],
  aliases: Array<{ alias: string; path: string; qualifiedName: string }>,
  parse: ReturnType<typeof parseSummary>,
  snapshot: WorkspaceSnapshot,
): LightToolResult<unknown> {
  return {
    status: "ok",
    receipt,
    data: {
      changed: true,
      changes: files.map(fileChange),
      ...(aliases.length ? { aliases } : {}),
      parse,
      basedOn: snapshot.git ? "worktree" : "filesystem",
      sourceRevisionId,
    },
  };
}

function assertSymbolEditAvailable(path: string) {
  const capability = capabilityForPath(path);
  if (capability?.loaded && capability.level !== "raw") return;
  throw new SymbolResolutionError(`Symbol editing is unavailable for ${path}.`);
}

function hasClinePatchEnvelope(patch: string) {
  return /^\s*\*\*\* (?:Begin Patch|Add File:|Delete File:|Update File:)/u.test(
    patch,
  );
}

function completeNewFilePatch(path: string, content: string) {
  const addedLines = content
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => `+${line}`);
  return [
    "*** Begin Patch",
    `*** Add File: ${path}`,
    ...addedLines,
    "*** End Patch",
  ].join("\n");
}

async function optionalFile(files: WorkspaceFiles, path: string) {
  try {
    return await files.read(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function assertCompatibleMutations(file: PlannedFile) {
  if (file.mutation && file.replacements.length > 1)
    throw new Error(
      `File creation or deletion cannot overlap another edit in ${file.path}.`,
    );
  const ordered = [...file.replacements].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (replacementsOverlap(previous, current))
      throw new Error(
        `Edit operations overlap in ${file.path}: ${previous.source} conflicts with ${current.source}. Replace their common parent once, or split the edits and re-read after the first commit.`,
      );
  }
}

function replacementsOverlap(left: Replacement, right: Replacement) {
  if (isInsertion(left) && isInsertion(right))
    return left.start === right.start;
  if (isInsertion(left)) return insertionInside(left.start, right);
  if (isInsertion(right)) return insertionInside(right.start, left);
  return left.start < right.end && right.start < left.end;
}

function isInsertion(replacement: Replacement) {
  return replacement.start === replacement.end;
}

function insertionInside(offset: number, replacement: Replacement) {
  return offset > replacement.start && offset < replacement.end;
}

function applyPlan(plan: PlannedFile) {
  if (plan.mutation === "delete") return null;
  let content = plan.initial ?? Buffer.alloc(0);
  const descending = [...plan.replacements].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
  for (const replacement of descending)
    content = Buffer.concat([
      content.subarray(0, replacement.start),
      Buffer.from(replacement.replacement),
      content.subarray(replacement.end),
    ]);
  return content;
}

async function finalParseStatus(
  workspaceRoot: string,
  path: string,
  before: Buffer | null,
  after: Buffer | null,
): Promise<LightParseResult> {
  if (!after) return { diagnostics: [], status: "unsupported" };
  const validation = await validateFinalContent(workspaceRoot, path, after);
  if (validation.status === "passed")
    return { diagnostics: [], status: "passed" };
  if (validation.status === "unsupported")
    return {
      diagnostics: validation.diagnostics,
      status: unsupportedStatus(path),
    };
  return {
    diagnostics: validation.diagnostics,
    status: await failedOrDegraded(
      workspaceRoot,
      path,
      before,
      after,
      validation,
    ),
  };
}

function unsupportedStatus(path: string): LightParseStatus {
  return parseAvailability(path) === "unavailable"
    ? "unavailable"
    : "unsupported";
}

async function failedOrDegraded(
  workspaceRoot: string,
  path: string,
  before: Buffer | null,
  after: Buffer,
  validation: ContentValidation,
): Promise<LightParseStatus> {
  if (!before || validation.status !== "failed") return "failed";
  const previousValidation = await validateFinalContent(
    workspaceRoot,
    path,
    before,
  );
  if (previousValidation.status !== "failed") return "failed";
  const previous = parseCode(path, before);
  const current = parseCode(path, after);
  const errorsDidNotIncrease =
    current.errorCount <= previous.errorCount &&
    validation.diagnostics.length <= previousValidation.diagnostics.length;
  return previous.supported && errorsDidNotIncrease
    ? "degraded_preexisting_errors"
    : "failed";
}

function validateFinalContent(
  workspaceRoot: string,
  path: string,
  content: Buffer,
) {
  return validateContent({
    content,
    externalValidation: path.endsWith(".prisma") ? "unsupported" : "enabled",
    path,
    workspaceRoot,
  });
}

function invalidParseResult(file: FinalFile): LightToolResult<unknown> {
  const diagnostic = file.parse.diagnostics[0];
  return {
    status: "blocked",
    category: "code",
    message: `Final parse failed for ${file.path}; no files were written.${diagnostic ? ` ${diagnostic}` : ""}`,
    recovery: "Correct the final syntax and submit one new atomic batch.",
  };
}

function editFailure(error: unknown): LightToolResult<unknown> {
  const diagnosticId = `edit-${Date.now().toString(36)}`;
  if (error instanceof ScopedEditRecovery)
    return { status: "blocked", category: "input", message: error.message,
      recovery: error.recovery, diagnosticId };
  if (error instanceof SymbolResolutionError) {
    const recovery = error.candidates.length
      ? JSON.stringify(error.candidates)
      : patchFailureRecovery(error.message);
    return {
      status: "blocked",
      category: "input",
      message: error.message,
      ...(recovery ? { recovery } : {}),
      diagnosticId,
    };
  }
  const message = errorMessage(error);
  const recovery = patchFailureRecovery(message);
  return {
    status: "blocked",
    category: "input",
    message,
    ...(recovery ? { recovery } : {}),
    diagnosticId,
  };
}

class ScopedPatchShapeError extends Error {
  readonly correction;

  constructor(expectedPath: string, patchPaths: string[], suppliedPath?: string) {
    super("Scoped patch header must match the symbol's file and contain one Update File.");
    const repeatedHeaders = patchPaths.length > 1 && new Set(patchPaths).size === 1;
    this.correction = {
      reason: repeatedHeaders ? "multiple_headers_for_symbol"
        : patchPaths.length !== 1 ? "multiple_files_for_symbol" : "wrong_file_for_symbol",
      expectedPath, patchPaths: patchPaths.slice(0, 8), patchPathCount: patchPaths.length,
      ...(suppliedPath ? { suppliedPath } : {}),
      symbolRoute: "Keep target and use one operation per observed symbol, each with one matching Update File. Split unrelated file changes into separate operations in the same atomic batch.",
      fileRoute: "Review and read all intended file changes first. For a deliberate file patch, omit target; explicit file headers select the files. This changes the scope of your request and is never done automatically. Exact preimages and atomic batch guards still apply.",
    };
  }
}

class ScopedEditRecovery extends Error {
  readonly recovery: string;

  constructor(message: string, resolved: ResolvedLightSymbol,
    patchCorrection?: ScopedPatchShapeError["correction"] | ScopedContextCorrection) {
    const contextCorrection = patchCorrection && "affectedLines" in patchCorrection ? patchCorrection : undefined;
    super(contextCorrection ? "Patch context matches the whole file but exceeds the selected symbol scope." : message);
    const [startLine, endLine] = resolved.symbol.line_range;
    this.recovery = "No operations in this batch were applied. Every operation uses the original source, not earlier operations in the same batch. " +
      (contextCorrection ? "The exact context matches the file; resending it with this same narrow target cannot fix the scope conflict. Narrow the patch context or explicitly choose a file patch after inspecting the affected lines. Other edit guards still apply. "
        : patchFailureRecovery(message) ? `${patchFailureRecovery(message)} ` : "") +
      JSON.stringify({ target: resolved.alias, path: resolved.path,
        ...(patchCorrection ? { patchCorrection } : {}),
        declarationLines: [startLine, endLine],
        nextRead: contextCorrection?.nextRead ?? { target: resolved.path, view: "range",
          range: { startLine: Math.max(1, startLine - 3), endLine: Math.min(endLine + 2, startLine + 24) } },
        routes: "Read the current text before retrying. For changes inside the declaration, read the symbol then use a symbol action or a focused alias patch. For JSDoc, export wrappers or context outside it, read those lines and use a file patch. For dependent edits, commit separately and read again. These locations are hints, not observed edit coverage; refresh after source changes." });
  }
}

type ScopedContextCorrection = {
  reason: "context_outside_symbol";
  expectedPath: string;
  affectedLines: [number, number][];
  affectedRangeCount: number;
  changesOutsideSymbol: boolean;
  nextRead: { target: string; view: "range"; range: { startLine: number; endLine: number } };
};

/** Diagnostic only: use the existing exact planner, without applying its result. */
function scopedContextCorrection(patch: string, resolved: ResolvedLightSymbol, message: string): ScopedContextCorrection | undefined {
  if (!/context does not match/iu.test(message) || resolved.content.byteLength > 512 * 1024 || Buffer.byteLength(patch) > 32 * 1024)
    return undefined;
  try {
    const replacements = planScopedLightPatch(resolved.content.toString("utf8"), patch, resolved.path);
    if (!replacements.length) return undefined;
    const [start, end] = resolved.symbol.range_utf8_bytes;
    const outside = replacements.filter((replacement) => replacement.start < start || replacement.end > end);
    const lines = (replacement: { start: number; end: number }): [number, number] => [
      resolved.content.subarray(0, replacement.start).toString("utf8").split("\n").length,
      resolved.content.subarray(0, Math.max(replacement.start, replacement.end - 1)).toString("utf8").split("\n").length,
    ];
    const firstLine = lines((outside[0] ?? replacements[0])!)[0];
    const totalLines = resolved.content.toString("utf8").split("\n").length;
    const startLine = Math.max(1, firstLine - 3);
    return { reason: "context_outside_symbol", expectedPath: resolved.path,
      affectedLines: replacements.slice(0, 8).map(lines), affectedRangeCount: replacements.length,
      changesOutsideSymbol: outside.length > 0,
      nextRead: { target: resolved.path, view: "range", range: { startLine, endLine: Math.min(totalLines, startLine + 24) } } };
  } catch {
    // Missing, ambiguous and malformed whole-file context is not evidence of a
    // scope conflict. Keep the original refusal rather than guess a location.
    return undefined;
  }
}

function patchFailureRecovery(message: string) {
  if (/context is ambiguous/iu.test(message))
    return "Do not resend the same patch. Read the affected outline and target its symbol or selector alias, or add one short unique context line.";
  if (/context does not match/iu.test(message))
    return "Read only the affected symbol or short range, then submit a focused patch against the current text.";
  if (/too many (?:files|operations)/iu.test(message))
    return "Split the change into smaller atomic batches without repeating completed files.";
  return undefined;
}

type LightEditFailure = Exclude<LightToolResult<unknown>, { status: "ok" }>;

function commitFailure(error: unknown): LightEditFailure {
  if (error instanceof LightCommitConflict)
    return {
      status: "blocked",
      category: "input",
      message: error.message,
      diagnosticId: `edit-${Date.now().toString(36)}`,
    };
  return {
    status: "failed",
    category: "harness",
    recovery: "recovery_required",
    message: errorMessage(error),
    diagnosticId: `edit-${Date.now().toString(36)}`,
  };
}

function isLightFailure(
  value: LightCommitResult | LightEditFailure,
): value is LightEditFailure {
  return "status" in value;
}

function parseSummary(files: FinalFile[]) {
  const statuses = files.map(({ parse }) => parse.status);
  const priority: LightParseStatus[] = [
    "failed",
    "unavailable",
    "degraded_preexisting_errors",
    "unsupported",
    "passed",
  ];
  return {
    status:
      priority.find((status) => statuses.includes(status)) ?? "unsupported",
    files: files.map(({ path, parse }) => ({
      path,
      status: parse.status,
      ...(parse.diagnostics.length ? { diagnostics: parse.diagnostics } : {}),
    })),
  };
}

function fileChange(file: FinalFile) {
  const before = sourceLines(file.initial?.toString("utf8") ?? "");
  const after = sourceLines(file.content?.toString("utf8") ?? "");
  const common = commonLineCount(before, after);
  return {
    path: file.path,
    additions: after.length - common,
    deletions: before.length - common,
    ...(file.symbols.length ? { symbols: [...new Set(file.symbols)] } : {}),
  };
}

function commonLineCount(left: string[], right: string[]) {
  const rightCounts = new Map<string, number>();
  for (const line of right)
    rightCounts.set(line, (rightCounts.get(line) ?? 0) + 1);
  let count = 0;
  for (const line of left) {
    const available = rightCounts.get(line) ?? 0;
    if (!available) continue;
    count += 1;
    rightCounts.set(line, available - 1);
  }
  return count;
}

function sourceLines(value: string) {
  if (!value) return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
