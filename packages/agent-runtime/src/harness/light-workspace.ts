import type { AgentToolContext } from "@cline/sdk";
import { readIsolatedEnvironmentImage, readWorkspaceImage } from "./light-images.js";
import { pythonBodyRange } from "./python-body.js";
import {
  parseCode,
  symbolEditRange,
} from "./code-intelligence.js";
import { LightAliasRegistry, type ResolvedLightSymbol } from "./light-aliases.js";
import { LightAttention } from "./light-attention.js";
import {
  foldFileMinimumCharacters,
  foldViewCharacters,
  outlineMinimumCharacters,
} from "./light-fold-economics.js";
import { lineAlignedWindow, planFold, renderFold, type FoldPlan } from "./light-fold-view.js";
import { capabilityForPath } from "./light-capabilities.js";
import type {
  LightEditCodeInput,
  LightReadCodeInput,
  LightRunTaskInput,
  LightTaskContract,
  LightToolResult,
} from "./light-contracts.js";
import { readRanges } from "./light-contracts.js";
import { LightEditService } from "./light-edit.js";
import { checkRepairPlan } from "./light-check-repair.js";
import { LightCommitService } from "./light-commit.js";
import {
  editTargetSymbols,
  enclosingSymbol,
  qualifiedTarget,
  recordValue,
  requestedLineRange,
  routedView,
  stringValue,
  type EditTarget,
} from "./light-navigation.js";
import { LightTaskRunner } from "./light-task-runner.js";
import { LightCodeSearch, type CodeSearchRequest } from "./light-code-search.js";
import { answerShellInspection, shellInspectionRoutes } from "./shell-inspection.js";
import { LightReferenceSearch } from "./light-reference-search.js";
import { readDependencyDeclaration } from "./light-dependency-read.js";
import { withMissingPathRecovery } from "./light-path-recovery.js";
import { failedCheckSnippets } from "./light-failure-snippets.js";
import { ReadCoverage, type ByteInterval } from "./read-coverage.js";
import { SessionJournal } from "./session-journal.js";
import { currentValidationReport, validationStateAfterEdit } from "./light-validation-report.js";
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
  foldedContentResult,
  inputBlocked,
  lineByteRange,
  readableSource,
  type ReadContext,
  shortImportBlock,
  signatureRange,
  symbolContentResult,
} from "./light-read-results.js";

type LightWorkspaceOptions = {
  /** Runner-only experiment; production keeps compact search until the offline gate is met. */
  experimentalSearchExpansion?: boolean;
  /** Test/embedded runner override; production uses the fifteen-second initial wait. */
  initialCommandWaitMs?: number;
  refreshPreviewDependencies?: () => Promise<unknown>;
  sessionId: string;
  taskContract?: LightTaskContract;
};

const maximumRawCharacters = 64_000;
const maximumDirectoryEntries = 64;
const maximumRememberedMarkers = 5_000;

type PlannedFold = { parsed: ReturnType<typeof parseCode>; plan: FoldPlan; window: ByteInterval };

export class LightWorkspace {
  readonly edits: LightEditService;
  readonly tasks: LightTaskRunner;
  private readonly aliases = new LightAliasRegistry();
  private readonly attention = new LightAttention();
  /** Files each consumer last saw folded, by content: a raw re-read then returns only what the fold hid. */
  private readonly foldedViews = new Set<string>();
  /** Marker lines shown in folded views, refused when an edit copies one into source. */
  private readonly shownMarkers = new Set<string>();
  private readonly codeSearch: LightCodeSearch;
  private readonly coverage = new ReadCoverage();
  private readonly files: WorkspaceFiles;
  private readonly journal: SessionJournal;
  private initialization?: Promise<void>;
  private readonly options: LightWorkspaceOptions;
  private readonly commits: LightCommitService;

  constructor(workspaceRoot: string, options: LightWorkspaceOptions) {
    this.files = new WorkspaceFiles(workspaceRoot, options.sessionId);
    this.codeSearch = new LightCodeSearch({
      aliases: this.aliases,
      experimentalSearchExpansion: options.experimentalSearchExpansion,
      files: this.files,
      references: new LightReferenceSearch(this.files, this.aliases),
      registerCoverage: (path, content, intervals) =>
        this.registerCoverage(path, content, intervals, {}),
    });
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
    const marker = this.copiedMarker(input);
    if (marker)
      return {
        status: "blocked" as const,
        category: "input" as const,
        message: `This edit copies the folded-view line "${marker}", which stands for hidden source lines. Read them (the sN alias or the line range it names) and write the actual code.`,
      };
    const result = await this.edits.edit(input, context);
    if (result.status === "ok")
      for (const change of arrayValue(recordValue(result.data).changes)) {
        const path = stringValue(recordValue(change).path);
        if (!path) continue;
        this.coverage.invalidatePath(path);
        this.attention.changed(path);
        this.attention.edit(path, arrayValue(recordValue(change).symbols).flatMap((symbol) => stringValue(symbol) ?? []));
      }
    await this.journal.recordCoverage(this.coverage.snapshot());
    await this.journal.recordAttention(this.attention.snapshot());
    if (result.status !== "ok" || recordValue(result.data).changed !== true) return result;
    return this.withCheckRepair(await this.withValidationState(result, recordValue(result.status === "ok" ? result.data : undefined).sourceRevisionId), false);
  }

  private async withValidationState(result: LightToolResult<unknown>, expectedRevision?: unknown): Promise<LightToolResult<unknown>> {
    if (result.status !== "ok") return result;
    const completed = recordValue(recordValue(result.data).completed);
    const changed = recordValue(completed.status === "ok" ? completed.data : result.data).changed === true;
    if (!changed) return result;
    // Evidence presentation must never mask an already committed edit. Avoid a
    // new snapshot when no invocation has been recorded in this session.
    const validationState = this.journal.currentValidations().length
      ? await this.commits.exclusive(async () => {
          const state = await this.journal.completionSnapshot();
          return validationStateAfterEdit(state, this.journal.currentValidations(), expectedRevision ?? state.sourceRevisionId);
        }).catch(() => undefined)
      : undefined;
    return validationState ? { ...result, data: { ...recordValue(result.data), validationState } } : result;
  }

  private copiedMarker(input: LightEditCodeInput) {
    if (!this.shownMarkers.size) return undefined;
    for (const operation of input.operations) {
      const text = operation.kind === "symbol"
        ? operation.content ?? ""
        : operation.patch.trimStart().startsWith("*** Begin Patch")
          ? operation.patch.split("\n").filter((line) => line.startsWith("+")).map((line) => line.slice(1)).join("\n")
          : operation.patch;
      const copied = text.split("\n").map((line) => line.trim()).find((line) => this.shownMarkers.has(line));
      if (copied) return copied;
    }
    return undefined;
  }

  /** The repair plan last attached to a run_task result. */
  private shownRepair?: string;

  async runTask(input: LightRunTaskInput, context: AgentToolContext) {
    const inspection = input.kind === "command" ? await this.shellInspection(input, context) : undefined;
    if (inspection) return inspection;
    const result = await this.withValidationState(await this.runTaskWithDiagnostics(input, context));
    return this.withCheckRepair(result, checkOrFailure(result, input));
  }

  /** Answers grep/cat-style source inspection with search_code and read_code observations. */
  private async shellInspection(input: Extract<LightRunTaskInput, { kind: "command" }>, context: AgentToolContext) {
    if (process.platform === "win32" || process.env.BLAME_AGENT_SHELL_INSPECTION_ROUTING === "false") return undefined;
    const routes = shellInspectionRoutes(input.command, { cwd: input.cwd, root: this.files.root });
    if (!routes) return undefined;
    return answerShellInspection(input.command, routes, {
      lineCount: async (path) => (await this.files.read(path)).content.toString("utf8").split(/(?<=\n)/u).length,
      read: (readInput) => this.readCode(readInput, context),
      search: (request) => this.searchCode(request, context.signal),
    });
  }

  /** `relevant`: the plan is about this result (a check, a failure, @checks), so it always rides on it. */
  private async withCheckRepair(result: LightToolResult<unknown>, relevant: boolean): Promise<LightToolResult<unknown>> {
    if (result.status === "ok" && typeof recordValue(result.data).run === "string" &&
        !recordValue(result.data).completed) return result;
    // Advisory discovery must not turn a committed edit or completed command
    // into a missing receipt when a manifest is temporarily incomplete.
    const repair = await checkRepairPlan(this.files, this.journal, this.options.taskContract).catch(() => undefined);
    const key = repair && JSON.stringify(repair);
    const previous = this.shownRepair;
    this.shownRepair = key;
    if (!repair) return result;
    // A failing check's plan rode on every later command, an `ls` included
    // (46 results in US-041). Repeat it only with checks and failures.
    if (key === previous && !relevant) return result;
    return result.status === "ok" ? { ...result, data: { ...recordValue(result.data), validationRepair: repair } }
      : result.status === "blocked" ? { ...result, recovery: `${result.recovery ?? ""}\n${JSON.stringify({ validationRepair: repair })}`.trim() }
      : result;
  }

  private async runTaskWithDiagnostics(input: LightRunTaskInput, context: AgentToolContext) {
    await this.ready;
    if (input.kind === "analyze") {
      const { analyzeWorkspaceSymbol } = await import("./light-symbolic-analysis.js");
      return analyzeWorkspaceSymbol(this.files, this.aliases, input, context.signal);
    }
    const result = await this.tasks.run(input, context);
    if (result.status !== "ok") return result;
    // A long run reports its changed files when it completes, through inspect.
    const completed = recordValue(recordValue(recordValue(result.data).completed).data);
    const paths = [...arrayValue(recordValue(result.data).paths), ...arrayValue(completed.paths)].flatMap(
      (value) => {
        const path = stringValue(value);
        return path ? [path] : [];
      },
    );
    for (const path of paths) {
      this.coverage.invalidatePath(path);
      this.attention.changed(path);
    }
    if (paths.length)
      await this.journal.recordCoverage(this.coverage.snapshot());
    if (recordValue(recordValue(result.data).check).outcome === "failed") {
      const data = recordValue(result.data);
      const snippets = await failedCheckSnippets(this.files, data, (target, startLine, endLine) =>
        this.readCode({ target, view: "range", range: { startLine, endLine } }, context));
      await this.pointAt(snippets.flatMap((snippet) => {
        const value = recordValue(snippet);
        const path = stringValue(value.path);
        const lines = arrayValue(value.lines);
        const [start, end] = [Number(lines[0]), Number(lines[1])];
        return path && Number.isSafeInteger(start) && end >= start
          ? [{ path, lines: Array.from({ length: Math.min(end - start + 1, 16) }, (_, index) => start + index) }]
          : [];
      }));
      if (snippets.length) return { ...result, data: { ...data, diagnostics: snippets } };
    }
    return result;
  }

  async searchCode(
    input: CodeSearchRequest,
    signal?: AbortSignal,
  ): Promise<LightToolResult<unknown>> {
    try {
      await this.ready;
      const result = await this.persistAliases(
        await this.commits.readExclusive(() => this.codeSearch.search(input, signal)),
      );
      await this.recordObservationAudit("search_code", input.mode ?? "auto", result);
      if (result.status === "ok") await this.pointAt(searchHits(result.data));
      return result;
    } catch (error) {
      return inputBlocked(error);
    }
  }

  async readCode(
    input: LightReadCodeInput,
    context: ReadContext,
  ): Promise<LightToolResult<unknown>> {
    try {
      await this.ready;
      let result = await this.commits.readExclusive(() =>
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

  /** Search hits and failing-check lines, kept whole by later folded views. */
  private async pointAt(hits: Array<{ path: string; lines: number[] }>) {
    if (!hits.length) return;
    const byPath = new Map<string, number[]>();
    for (const hit of hits) byPath.set(hit.path, [...(byPath.get(hit.path) ?? []), ...hit.lines]);
    for (const [path, lines] of byPath) this.attention.point(path, lines);
    await this.journal.recordAttention(this.attention.snapshot());
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
    this.attention.hydrate(this.journal.currentAttention());
    for (const entry of this.journal.currentCoverage().entries)
      this.aliases.rememberObservation(entry.path, entry.hash, entry.intervals);
    const objective = options.taskContract?.objective;
    if (objective) await this.journal.ingestUserRequest("initial", objective);
  }

  private async persistAliases<T>(result: LightToolResult<T>) {
    await this.journal.recordAliases(this.aliases.entries());
    return result;
  }

  private async specialReadResult(target: string) {
    if (target === "@checks")
      return this.withCheckRepair({ status: "ok" as const, data: currentValidationReport(await this.journal.completionSnapshot(), this.journal.currentValidations()) }, true);
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
    readableSource(file.content);
    const view = routedView(input);
    if (view === "signature")
      throw new Error("Signature view requires a symbol alias or path#qualifiedName. Read the file outline to choose a declaration.");
    if (view === "outline")
      return await this.readOutlinePath(path, file.content, revision, context, input);
    if (view === "range")
      return await this.readLineRange(path, file.content, input, revision, context);
    if (view === "auto") {
      // A file larger than a folded view is always folded, down to one line per declaration if need be.
      const folded = this.plannedFold(path, file.content, [0, file.content.byteLength], foldFileMinimumCharacters,
        file.content.toString("utf8").length > foldViewCharacters);
      if (folded) return await this.foldResult(path, file.content, folded, revision, context);
    }
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
    input: LightReadCodeInput,
  ) {
    if (!parseCode(path, content).supported)
      return await this.raw(path, content, revision, context, "symbol_view_unavailable");
    const ranges = readRanges(input).map(({ startLine, endLine }) => lineByteRange(content, startLine, endLine));
    const window: ByteInterval = ranges.length
      ? [Math.min(...ranges.map(([start]) => start)), Math.max(...ranges.map(([, end]) => end))]
      : [0, content.byteLength];
    const folded = this.plannedFold(path, content, window, outlineMinimumCharacters);
    if (folded) return await this.foldResult(path, content, folded, revision, context);
    // Folding would save less than the call that unfolds it.
    return ranges.length
      ? await this.readLineRange(path, content, input, revision, context)
      : await this.raw(path, content, revision, context, "outline_not_smaller");
  }

  /** A fold of `window` when it removes at least `minimum` characters. */
  private plannedFold(path: string, content: Buffer, window: ByteInterval, minimum: number, always = false): PlannedFold | undefined {
    if (content.byteLength > 2 * 1024 * 1024) return undefined;
    const parsed = parseCode(path, content);
    if (!parsed.supported) return undefined;
    const aligned = lineAlignedWindow(content, window);
    const plan = planFold(content, parsed, aligned, this.attention.forFile(path));
    return always || (plan.markers.length && plan.removed >= minimum) ? { parsed, plan, window: aligned } : undefined;
  }

  private async foldResult(
    path: string,
    content: Buffer,
    { parsed, plan, window }: PlannedFold,
    revision: string,
    context: ReadContext,
  ) {
    const view = renderFold(content, parsed, window, plan,
      (symbol) => this.aliases.registerSymbol(path, content, symbol, revision).alias);
    for (const marker of view.markers) this.shownMarkers.add(marker.text.trim());
    while (this.shownMarkers.size > maximumRememberedMarkers)
      this.shownMarkers.delete(this.shownMarkers.values().next().value!);
    const coverage = await this.registerCoverage(path, content, view.shown, context);
    this.foldedViews.add(this.foldKey(path, content, context));
    const whole = window[0] === 0 && window[1] === content.byteLength;
    const editTargets = whole ? this.registerEditTargets(path, content, revision) : [];
    return foldedContentResult(path, content, window, view, plan, coverage.receipt, editTargets);
  }

  private foldKey(path: string, content: Buffer, context: ReadContext) {
    const { consumerId, generation } = coverageScope(context);
    return [consumerId, generation, path, sha256(content)].join("\0");
  }

  /**
   * A whole-file read right after a folded view of the same content returns
   * only what the fold hid: the rest is already in the agent's context.
   */
  private async foldedDelta(path: string, content: Buffer, context: ReadContext) {
    if (!this.foldedViews.has(this.foldKey(path, content, context))) return undefined;
    const uncovered = this.coverage.uncovered({
      ...coverageScope(context), hash: sha256(content), path, intervals: [[0, content.byteLength]],
    });
    if (!uncovered.length) {
      const coverage = await this.registerCoverage(path, content, [], context);
      return {
        status: "ok" as const,
        receipt: coverage.receipt,
        data: {
          path, view: "raw", status: "already_in_context",
          note: "Your folded view and later reads of this file already hold every line of its current content.",
        },
      };
    }
    const intervals: ByteInterval[] = [];
    let budget = maximumRawCharacters;
    let truncated = false;
    for (const [start, end] of uncovered) {
      let stop = Math.min(end, start + budget);
      while (stop > start && stop < content.length && (content[stop]! & 0xc0) === 0x80) stop--;
      if (stop > start) intervals.push([start, stop]);
      budget -= stop - start;
      if (stop < end) {
        truncated = true;
        break;
      }
    }
    const result = await this.coveredContent(path, content, intervals, context, "raw", "folded_view_delta", truncated);
    return result.status === "ok"
      ? { ...result, data: { ...recordValue(result.data), delta: "Only the lines your folded view of this file hid; the other lines are in that view, unchanged." } }
      : result;
  }

  private async readLineRange(
    path: string,
    content: Buffer,
    input: LightReadCodeInput,
    revision: string,
    context: ReadContext,
  ) {
    const ranges = readRanges(input);
    if (!ranges.length) throw new Error("range is required for the range view.");
    const intervals = mergedIntervals(
      ranges.map(({ startLine, endLine }) => lineByteRange(content, startLine, endLine)),
    );
    const editTargets = this.registerEditTargets(path, content, revision, intervals);
    return await this.coveredContent(
      path,
      content,
      intervals,
      context,
      "range",
      undefined,
      false,
      editTargets,
    );
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
    const folded = end - start > maximumRawCharacters
      ? this.plannedFold(resolved.path, resolved.content, [start, end], 0)
      : undefined;
    if (folded) return this.foldResult(resolved.path, resolved.content, folded, revision, context);
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
    const folded = this.plannedFold(resolved.path, resolved.content, resolved.symbol.range_utf8_bytes,
      outlineMinimumCharacters);
    if (folded) return this.foldResult(resolved.path, resolved.content, folded, revision, context);
    return this.readSymbol(resolved.alias!, revision, context);
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
    const delta = await this.foldedDelta(path, content, context);
    if (delta) return delta;
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
      ...coverageScope(context),
      hash: sha256(content),
      intervals,
      path,
    });
    await this.journal.recordCoverage(this.coverage.snapshot());
    return result;
  }
}

/** A result the repair plan is about: a failure, a project task, or a recorded check. */
function checkOrFailure(result: LightToolResult<unknown>, input: LightRunTaskInput) {
  if (result.status !== "ok" || input.kind !== "command") return true;
  const data = recordValue(result.data);
  const completed = recordValue(recordValue(data.completed).data);
  return ["validation", "reporting", "testValidationScope", "check"].some((key) => key in data || key in completed);
}

/** Who holds a read in context: the agent and its context generation. */
function coverageScope(context: ReadContext) {
  return {
    consumerId: context.agentId || context.conversationId || context.sessionId || "lead",
    generation: contextGeneration(context),
  };
}

function mergedIntervals(intervals: ByteInterval[]) {
  const output: ByteInterval[] = [];
  for (const [start, end] of [...intervals].sort((left, right) => left[0] - right[0])) {
    const previous = output.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else output.push([start, end]);
  }
  return output;
}

/** Lines search results point at, per path. */
function searchHits(data: unknown) {
  return arrayValue(recordValue(data).results).flatMap((item) => {
    const result = recordValue(item);
    const path = stringValue(result.path);
    const lines = arrayValue(result.lines);
    const line = typeof result.matchLine === "number" ? result.matchLine : typeof lines[0] === "number" ? lines[0] : undefined;
    return path && line ? [{ path, lines: [line] }] : [];
  });
}
