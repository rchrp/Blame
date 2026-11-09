import { invocationTestReport } from "./invocation-test-report.js";
import { posix, relative } from "node:path";
import { isTestInvocation, observeCheck, type CheckObservation } from "./check-observation.js";
import { LightCommitService, type LockHolder, type WorkspaceLockedStep } from "./light-commit.js";
import { redactSecuritySecrets } from "../security-secret-redaction.js";
import { EnvironmentAdapter } from "./environment-adapter.js";
import { blockedCommandReason } from "./command-policy.js";
import { commandChanges, observeCommand } from "./command-changes.js";
import {
  DeterministicFormatter,
  DeterministicFormatterError,
  type FormatterCommand,
} from "./deterministic-formatter.js";
import type {
  LightCommandCredentials,
  LightRunTaskInput,
  LightToolResult,
  LightTaskContract,
} from "./light-contracts.js";
import { LightDependencyService } from "./light-dependencies.js";
import { boundedDiagnostic } from "./light-diagnostic.js";
import { recordValue } from "./light-navigation.js";
import {
  commandFailure,
  commandFailureAssessment,
  failedCommandResult,
  type FailureAssessment,
} from "./command-failure.js";
import { readOnlyInspection } from "./shell-inspection.js";
import type { FormattedFileReplacement, LightEditService } from "./light-edit.js";
import { sha256 } from "./light-identity.js";
import type { SessionJournal } from "./session-journal.js";
import {
  readTaskCatalog,
  taskInvocation,
  taskInvocationDisplay,
  isValidationKind,
  plainCompilerCheck,
  type TaskCatalogItem,
} from "./task-catalog.js";
import {
  startWorkspaceCommand,
  type WorkspaceCommandResult,
} from "./workspace-command-process.js";
import { projectTestCommand } from "./project-test-command.js";
import { environmentManifestEvidence } from "./workspace-revisions.js";
import { validationScopePaths } from "./validation-scope.js";
import { validationOutput, type ValidationOutput } from "./validation-output.js";
import { checkReporting } from "./light-validation-report.js";
import type { WorkspaceFiles, WorkspaceSnapshot } from "./workspace-files.js";
import { managedTestReport, type ManagedTestReport } from "./managed-test-report.js";
import { runtimeTestScope, typecheckSelections, type TypecheckSelection } from "./runtime-test-scope.js";

type RunnerContext = {
  commandCredentials?: LightCommandCredentials;
  sessionId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
};

type LightTaskRunnerOptions = {
  commandEnvironment?: LightTaskContract["environment"];
  edits?: Pick<LightEditService, "replaceFiles">;
  files: WorkspaceFiles;
  journal: SessionJournal;
  initialCommandWaitMs?: number;
  refreshPreviewDependencies?: () => Promise<unknown>;
};

type CommandHandle = ReturnType<typeof startWorkspaceCommand>;
type ManagedRun = {
  command: string;
  completion: Promise<LightToolResult<unknown>>;
  handle: CommandHandle;
  result?: LightToolResult<unknown>;
};

type ValidationMetadata = {
  validationScope?: TaskCatalogItem["validationScope"];
  taskCommand?: string;
  args?: string[];
  check?: CheckObservation;
  cwd?: string;
  sourceRevisionId?: string;
  taskId?: string;
  taskKind?: string;
  report?: ManagedTestReport;
  invocationReport?: Awaited<ReturnType<typeof invocationTestReport>>;
  invocationSnapshot?: WorkspaceSnapshot;
  invocationEnvironment?: Awaited<ReturnType<typeof environmentManifestEvidence>>;
  typecheckSelections?: TypecheckSelection[];
};

export class LightTaskRunner {
  private readonly commandEnvironment: LightTaskContract["environment"];
  private readonly edits?: Pick<LightEditService, "replaceFiles">;
  private readonly environment: EnvironmentAdapter;
  private readonly formatter: DeterministicFormatter;
  private readonly dependencies: LightDependencyService;
  private readonly files: WorkspaceFiles;
  private readonly journal: SessionJournal;
  private readonly initialCommandWaitMs: number;
  private readonly refreshPreviewDependencies?: () => Promise<unknown>;
  private readonly runs = new Map<string, ManagedRun>();
  private runSequence = 0;
  /** Settles when the latest command started here has finished. */
  private commandTurn: Promise<unknown> = Promise.resolve();
  private reportSequence = 0;

  constructor(options: LightTaskRunnerOptions) {
    this.commandEnvironment = options.commandEnvironment;
    this.edits = options.edits;
    this.files = options.files;
    this.journal = options.journal;
    this.initialCommandWaitMs = options.initialCommandWaitMs ?? 15_000;
    this.environment = new EnvironmentAdapter(options.files);
    this.formatter = new DeterministicFormatter(options.files);
    this.dependencies = new LightDependencyService(options.files);
    this.refreshPreviewDependencies = options.refreshPreviewDependencies;
  }

  run(input: LightRunTaskInput, context: RunnerContext = {}) {
    if (input.kind === "analyze")
      return Promise.resolve(blocked("input", "Symbolic analysis requires workspace symbol resolution."));
    if (input.kind === "inspect") return this.inspect(input, context.signal);
    if (input.kind === "dependency") return this.dependency(input, context);
    if (input.kind === "project") return this.project(input, context);
    return this.command(input, context);
  }

  private async inspect(
    input: Extract<LightRunTaskInput, { kind: "inspect" }>,
    signal?: AbortSignal,
  ): Promise<LightToolResult<unknown>> {
    const run = this.runs.get(input.run);
    if (!run)
      return blocked(
        "input",
        `Run ${input.run} does not belong to this session or is no longer available.`,
      );
    try {
      // Waiting for the end by default: a turn per burst of test output cost
      // 11 of 107 turns and 13% of US-034's input tokens.
      const until = input.until ?? "exit";
      if (process.env.BLAME_AGENT_INSPECT_WAIT !== "false" && !run.result) {
        if (until === "exit") await run.handle.waitForExit(inspectExitWaitMs, signal);
        else if (until === "output" && input.cursor !== undefined)
          await run.handle.waitForUpdate(input.cursor, 30_000, signal);
      }
      return await this.runView(input.run, run, input.cursor);
    } catch (error) {
      if (signal?.aborted)
        return blocked("environment", "Managed-run inspection was cancelled; no command outcome is inferred.");
      return blocked("input", errorMessage(error));
    }
  }

  /**
   * One page of a run's output and, once it ended, its result. The page
   * starts at the cursor (the latest output without one) and the cursor it
   * returns is where the next page starts, so no output is skipped.
   */
  private async runView(runId: string, run: ManagedRun, cursor?: string): Promise<LightToolResult<unknown>> {
    const snapshot = run.handle.inspect(cursor, outputPageBytes);
    // Process termination precedes source capture and journal finalization.
    // Expose their real result together instead of an exited-only snapshot.
    const completed = run.result ?? (snapshot.process === "running" ? undefined : await run.completion);
    const unread = (snapshot.totalBytes ?? 0) - Number(snapshot.cursor);
    return {
      status: "ok",
      data: {
        run: runId,
        command: run.command,
        process: snapshot.process,
        cursor: snapshot.cursor,
        // Pages join exactly: redacted, not trimmed.
        output: redactSecuritySecrets(snapshot.output),
        ...(cursor === undefined && snapshot.start ? { outputFrom: snapshot.start, earlierOutput: { kind: "inspect", run: runId, cursor: "0", until: "now" } } : {}),
        ...(unread > 0 ? { nextOutput: { kind: "inspect", run: runId, cursor: snapshot.cursor, until: "now" } } : {}),
        ...(completed ? { completed: withFullOutput(completed, runId) } : {}),
      },
    };
  }

  private async project(
    input: Extract<LightRunTaskInput, { kind: "project" }>,
    context: RunnerContext,
  ): Promise<LightToolResult<unknown>> {
    try {
      const task = await this.resolveProjectTask(input);
      if (task.kind === "service" && this.commandEnvironment?.managedPreview !== false)
        return managedServiceResult(task.task_id);
      return await this.executeProjectTask(task, context, input.args);
    } catch (error) {
      const category =
        error instanceof TaskSelectionError ? "input" : "environment";
      return blocked(category, errorMessage(error));
    }
  }

  private async executeProjectTask(
    task: TaskCatalogItem & { typecheckSelections?: TypecheckSelection[] },
    context: RunnerContext,
    args: string[] = [],
  ) {
    const declaredInvocation = taskInvocation(task, args);
    const report = await managedTestReport(
      task,
      declaredInvocation,
      this.files.root,
      ++this.reportSequence,
      context.signal,
    );
    const invocation = report?.invocation ?? declaredInvocation;
    const cwd = await this.environment.cwd(invocation.cwd);
    return this.execute(
      invocation.executable,
      invocation.args,
      cwd,
      taskInvocationDisplay(invocation),
      context,
      {
        cwd: task.cwd,
        taskId: task.task_id,
        taskKind: task.kind,
        ...(task.validationScope ? { validationScope: task.validationScope } : {}),
        taskCommand: task.command,
        ...(task.typecheckSelections ? { typecheckSelections: task.typecheckSelections } : {}),
        ...(args.length ? { args } : {}),
        ...(report ? { report } : {}),
      },
    );
  }

  private async command(
    input: Extract<LightRunTaskInput, { kind: "command" }>,
    context: RunnerContext,
  ): Promise<LightToolResult<unknown>> {
    const formatter = this.formatter.request(input.command);
    if (formatter) return this.format(formatter, input, context);
    const formatterRecovery = this.formatter.recovery(input.command);
    if (formatterRecovery) return blocked("input", formatterRecovery);
    const denied = blockedCommandReason(input.command, this.commandEnvironment);
    if (denied) return blocked("input", denied);
    try {
      const invocation = this.environment.command(
        input.command,
        context.commandCredentials?.githubCli?.binDirectory,
      );
      const cwd = await this.environment.cwd(input.cwd);
      return await this.execute(
        invocation.executable,
        invocation.args,
        cwd,
        input.command,
        context,
        { cwd: input.cwd ?? "." },
      );
    } catch (error) {
      return blocked("environment", errorMessage(error));
    }
  }

  private async format(
    request: FormatterCommand,
    input: Extract<LightRunTaskInput, { kind: "command" }>,
    context: RunnerContext,
  ): Promise<LightToolResult<unknown>> {
    if (!this.edits)
      return blocked(
        "environment",
        "Deterministic formatting is unavailable in this execution context.",
      );
    try {
      const cwd = request.cwd ? posix.join(input.cwd ?? ".", request.cwd) : input.cwd;
      return await this.applyFormatter(this.edits, request, cwd, context);
    } catch (error) {
      if (error instanceof DeterministicFormatterError)
        return blocked(error.category, error.message);
      return blocked("environment", errorMessage(error));
    }
  }

  private async applyFormatter(
    edits: Pick<LightEditService, "replaceFiles">,
    request: FormatterCommand,
    cwdInput: string | undefined,
    context: RunnerContext,
  ) {
    const cwd = await this.environment.cwd(cwdInput);
    const replacements = await this.formatter.format(
      request,
      cwd,
      context.signal,
    );
    const result = await edits.replaceFiles(replacements, context);
    if (result.status !== "ok") return result;
    const paths = replacements.map(({ path }) => path);
    const current = await this.recordFormatterValidation(replacements);
    const formatted = formattedResult(result, paths);
    if (current) return formatted;
    return {
      ...formatted,
      data: {
        ...record(formatted.data),
        validation: {
          status: "stale",
          reason: "Source changed after formatting; run a check on the current source.",
        },
      },
    };
  }

  private async recordFormatterValidation(replacements: FormattedFileReplacement[]) {
    const snapshot = await this.files.snapshot();
    if (replacements.some(({ path, content }) =>
      snapshot.fileStates.find(file => file.path === path)?.hash !== sha256(content)))
      return false;
    const paths = replacements.map(({ path }) => path);
    const sourceRevisionId = snapshot.revision.source_revision_id;
    await this.journal.recordValidation({
      evidenceOrigin: "formatter_output",
      paths,
      sourceRevisionId,
      status: "passed",
      taskKind: "lint",
    });
    return true;
  }

  private async dependency(
    input: Extract<LightRunTaskInput, { kind: "dependency" }>,
    context: RunnerContext,
  ): Promise<LightToolResult<unknown>> {
    try {
      const before = await this.files.snapshot(context.signal);
      const { result } = await observeCommand(this.files, this.journal, before,
        () => this.dependencies.mutate(input, context.signal));
      if (result.status === "blocked")
        return blocked(result.category, result.message);
      return this.appliedDependency(input, result.changedPaths, result.output);
    } catch (error) {
      return blocked("environment", errorMessage(error));
    }
  }

  private async appliedDependency(
    input: Extract<LightRunTaskInput, { kind: "dependency" }>,
    paths: string[],
    output: string,
  ): Promise<LightToolResult<unknown>> {
    if (!paths.length)
      return {
        status: "ok",
        data: { changed: false, output: boundedDiagnostic(output, "", 4_000) },
      };
    const sourceRevisionId = (await this.files.snapshot()).revision
      .source_revision_id;
    await this.recordDependency(input, paths, sourceRevisionId);
    const preview = await this.refreshPreviewDependencies?.();
    const data = {
      changed: true,
      paths,
      output: boundedDiagnostic(output, "", 4_000),
    };
    if (preview === undefined) return { status: "ok", data };
    return {
      status: "ok",
      data: { ...data, preview },
    };
  }

  private async recordDependency(
    input: Extract<LightRunTaskInput, { kind: "dependency" }>,
    paths: string[],
    sourceRevisionId: string,
  ) {
    await this.journal.recordValidation({
      command: `${input.action} ${input.packages.join(" ")}`,
      paths,
      sourceRevisionId,
      status: "passed",
      taskId: "dependency:consistency",
      taskKind: "build",
    });
  }

  private async execute(
    executable: string,
    args: string[],
    cwd: string,
    command: string,
    context: RunnerContext,
    metadata: ValidationMetadata = {},
  ): Promise<LightToolResult<unknown>> {
    // Commands take turns: one sent while another runs (often in the same
    // response) starts when it ends, instead of failing on the lock.
    const previous = this.commandTurn;
    let finished!: () => void;
    const mine = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.commandTurn = previous.then(() => mine);
    try {
      await abortable(previous, context.signal);
    } catch {
      finished();
      return blocked("environment", "The command was cancelled while it waited for the previous command to finish.");
    }
    let publishHandle!: (handle: CommandHandle) => void;
    const started = new Promise<CommandHandle>((resolve) => {
      publishHandle = resolve;
    });
    const holder: LockHolder = { label: `the command \`${command.slice(0, 120)}\`` };
    // The command holds this session's turn while it runs, and the workspace
    // lock only to look at the files before and after: other sessions in the
    // same folder (chats, Direct stories) keep working during a long run.
    const completion = new LightCommitService(this.files)
      .sessionExclusive(
        (locked) =>
          this.executeLocked(
            executable,
            args,
            cwd,
            command,
            context,
            metadata,
            publishHandle,
            locked,
          ),
        holder,
      )
      .catch((error) => blocked("environment", errorMessage(error)))
      .finally(finished);
    const first = await Promise.race([
      completion.then((result) => ({ kind: "complete" as const, result })),
      started.then((handle) => ({ kind: "started" as const, handle })),
    ]);
    if (first.kind === "complete") return first.result;
    const runId = `r${++this.runSequence}`;
    holder.label = `run ${runId} (\`${command.slice(0, 120)}\`)`;
    const managed: ManagedRun = { command, completion, handle: first.handle };
    this.runs.set(runId, managed);
    this.forgetOldRuns();
    void completion.then((result) => {
      managed.result = result;
    });
    const initial = await Promise.race([
      completion.then((result) => ({ kind: "complete" as const, result })),
      delay(this.initialCommandWaitMs).then(() => ({ kind: "running" as const })),
    ]);
    // A finished run stays readable: its whole output pages through inspect.
    if (initial.kind === "complete") return withFullOutput(initial.result, runId);
    // From here the model watches a long run; its edits wait while it holds the session.
    holder.run = runId;
    return this.runView(runId, managed);
  }

  /** Keeps the latest finished runs' output for paging, and every running one. */
  private forgetOldRuns() {
    const finished = [...this.runs].filter(([, run]) => run.result);
    for (const [id] of finished.slice(0, Math.max(0, finished.length - keptFinishedRuns))) this.runs.delete(id);
  }

  private async executeLocked(
    executable: string, args: string[], cwd: string, command: string,
    context: RunnerContext, metadata: ValidationMetadata,
    publishHandle: (handle: CommandHandle) => void,
    locked: WorkspaceLockedStep,
  ): Promise<LightToolResult<unknown>> {
    context.signal?.throwIfAborted();
    const directory =
      relative(this.files.root, cwd).replaceAll("\\", "/") || ".";
    const { invocationEnvironment, invocationReport, snapshot, validation } = await locked(async () => {
      const snapshot = await this.files.snapshot(context.signal);
      const validation = metadata.taskId
        ? metadata
        : await this.commandValidation(command, directory, snapshot.files);
      const invocationReport = validation.taskKind === "test" && !validation.report && /\b(?:node|vitest|npm|pnpm|yarn|bun)\b/u.test(validation.taskCommand ?? command)
        ? await invocationTestReport(this.files.root) : undefined;
      const invocationEnvironment = validation.report?.nodeEvents || invocationReport
        ? await environmentManifestEvidence(this.files, snapshot.files) : undefined;
      return { invocationEnvironment, invocationReport, snapshot, validation };
    });
    const [execution] = await Promise.allSettled([Promise.resolve().then(() => {
      const handle = startWorkspaceCommand(executable, args, {
        cwd,
        credentials: context.commandCredentials,
        ...(invocationReport ? { environment: invocationReport.environment } : {}),
        signal: context.signal,
      });
      publishHandle(handle);
      return handle.completion;
    })]);
    return locked(async () => {
      // Another session may have written files meanwhile: they count as the
      // command's changes, and a check sees that its source moved.
      const { after, changedPaths } = await commandChanges(this.files, this.journal, snapshot);
      if (execution.status === "rejected") throw execution.reason;
      return this.recordedResult(
        command,
        execution.value,
        {
          ...metadata,
          ...validation,
          cwd: directory,
          sourceRevisionId: snapshot.revision.source_revision_id,
          ...(invocationEnvironment ? { invocationEnvironment } : {}),
          ...(invocationReport ? { invocationReport, invocationSnapshot: snapshot } : {}),
        },
        after,
        changedPaths,
      );
    });
  }

  private async commandValidation(
    command: string,
    cwd: string,
    files: string[],
  ): Promise<ValidationMetadata> {
    const tasks = await readTaskCatalog(this.files.root, files);
    const task = tasks.find(
      (item) =>
        item.cwd === cwd &&
        isValidationKind(item.kind) &&
        (command === item.command ||
          command === `${item.package_manager} run ${item.script}` ||
          command === `${item.package_manager} ${item.script}`),
    );
    const identity = task ? { taskId: task.task_id, taskKind: task.kind,
      ...(task.validationScope ? { validationScope: task.validationScope } : {}) }
      : projectTestCommand(command, cwd, tasks);
    if (!identity) return process.env.BLAME_AGENT_LITERAL_COMPILER_REPAIR !== "false" && plainCompilerCheck(command)
      ? { taskKind: "typecheck", validationScope: "invocation_only" } : {};
    const matches = tasks.filter((item) => item.task_id === identity.taskId && item.cwd === cwd);
    return { ...identity, typecheckSelections: typecheckSelections(tasks, cwd),
      ...(matches.length === 1 ? { taskCommand: matches[0]!.command } : {}) };
  }

  private async recordedResult(
    command: string,
    result: WorkspaceCommandResult,
    metadata: ValidationMetadata,
    snapshot: WorkspaceSnapshot,
    changedPaths: string[],
  ): Promise<LightToolResult<unknown>> {
    const output = redactedOutput(result.all);
    if (metadata.taskKind === "test" || (metadata.taskKind !== "typecheck" && isTestInvocation(command))) {
      // Counts come from this process's output, interpreted using the exact
      // catalog script when a known npm wrapper obscures the runner name.
      // Keep the original command/argv in the journal and execute it unchanged.
      const report = await metadata.report?.read();
      const check = observeCheck(metadata.taskCommand ?? command, { ...result, all: output }, metadata.cwd ?? ".",
        snapshot.revision.source_revision_id !== metadata.sourceRevisionId,
        metadata.report?.nodeEvents ? undefined : report,
        metadata.report?.nodeEvents ? { ...metadata.report.nodeEvents,
          ...(typeof report === "string" ? { report } : {}) } : undefined);
      if (check.evidence) check.evidence = { ...check.evidence,
        command, cwd: metadata.cwd ?? ".", taskId: metadata.taskId, args: metadata.args ?? [],
        invocationSourceRevisionId: metadata.sourceRevisionId,
        completedSourceRevisionId: snapshot.revision.source_revision_id,
        ...(metadata.invocationEnvironment ? { manifestEnvironment: {
          before: metadata.invocationEnvironment,
          after: await environmentManifestEvidence(this.files, snapshot.files),
        } } : {}) };
      const observed = metadata.invocationSnapshot
        ? await metadata.invocationReport?.read(metadata.invocationSnapshot, snapshot) : undefined;
      if (observed) {
        const environmentAfter = metadata.invocationEnvironment
          ? await environmentManifestEvidence(this.files, snapshot.files) : undefined;
        check.counts = observed.report.counts;
        check.execution = check.counts.executed > 0 ? "observed" : "zero_tests";
        check.outcome = result.interruption ? "unknown" : check.counts.failed > 0 || observed.report.setupFailed && observed.evidence.reportedFileCount > 0 ? "failed"
          : check.counts.executed === 0 ? "unknown" : observed.report.setupFailed ? "failed"
          : result.exitCode === 0 ? "passed" : "unknown";
        check.evidenceOrigin = "vitest_report";
        check.evidence = { ...observed.evidence, command, cwd: metadata.cwd ?? ".",
          invocationSourceRevisionId: metadata.sourceRevisionId,
          completedSourceRevisionId: snapshot.revision.source_revision_id,
          ...(metadata.invocationEnvironment ? { manifestEnvironment: { beforeRevisionId: metadata.invocationEnvironment.revisionId,
            afterRevisionId: environmentAfter?.revisionId ?? null, boundary: "Manifest/lock hashes only; installed dependencies and full environment are unknown." } } : {}) };
      }
      const failure = check.selectionFailure === "no_test_files"
        ? { category: "command" as const,
          recovery: `Vitest reported no selected test files from ${metadata.cwd ?? "."}. Resolve paths and filters from this working directory and inspect include/exclude settings, then rerun the intended selection. This failed invocation verifies no code; a different passing selection does not satisfy an explicitly required invocation.` }
        : check.outcome === "failed" ? await commandFailureAssessment(output, this.files, "test", result.exitCode) : undefined;
      await this.recordCommandValidation(command,
        check.outcome === "failed" ? "failed" : "unknown", snapshot,
        { ...metadata, taskKind: "test", check },
        failure);
      const presented = await validationOutput(this.files.root, output);
      if (failure || changedPaths.length) presented.output = boundedDiagnostic(output, "", 4_000);
      if (check.evidenceOrigin === "node_events" && check.counts)
        presented.output += `\nActive Node case results: ${check.counts.passed} passed, ${check.counts.failed} failed, ${check.counts.skipped} skipped/todo. File workers and suites are excluded. Command outcome: ${check.outcome}. Test scope, selection and freshness are not admitted by these counts.`;
      const scope = runtimeTestScope({ check,
        ...(metadata.taskCommand ? { script: redactedOutput(metadata.taskCommand) } : {}),
        ...(metadata.args ? { args: metadata.args.map(redactedOutput) } : {}),
        changedPaths: await this.journal.currentChangedPaths(),
        ...(metadata.typecheckSelections ? { typecheckSelections: metadata.typecheckSelections } : {}),
      });
      return { status: "ok", data: { command, exitCode: result.exitCode,
        ...presented,
        ...(failure ? { failure } : {}), check, reporting: { ...checkReporting(check),
          invocationSourceRevisionId: metadata.sourceRevisionId ?? null,
          completedSourceRevisionId: snapshot.revision.source_revision_id, cwd: metadata.cwd ?? "." },
        changed: changedPaths.length > 0, paths: changedPaths,
        validation: { status: check.freshness === "stale" ? "stale" : check.outcome === "failed" ? "failed" : "unknown" },
        ...(scope ? { testValidationScope: scope } : {}),
      } };
    }
    const inspection = !metadata.taskKind && !changedPaths.length ? readOnlyInspection(command) : undefined;
    if (inspection) return this.inspectionResult(command, result, output, inspection);
    const status = result.failed ? "failed" : "passed";
    const failure =
      result.interruption ? commandFailure() : result.failed
        ? await commandFailureAssessment(output, this.files, metadata.taskKind, result.exitCode)
        : undefined;
    const validatedRevisionId = snapshot.revision.source_revision_id;
    if (validatedRevisionId !== metadata.sourceRevisionId) {
      if (failure && isValidationKind(metadata.taskKind))
        await this.recordCommandValidation(
          command,
          "failed",
          snapshot,
          metadata,
          failure,
        );
      return sourceChangedDuringValidation(
        result.exitCode,
        output,
        failure,
        changedPaths,
        command,
      );
    }
    const validatedPaths = await this.recordCommandValidation(
      command,
      status,
      snapshot,
      metadata,
      failure,
    );
    if (failure) return failedCommandResult(result.exitCode, output, failure, command);
    const validation = validationProof(validatedRevisionId, validatedPaths, metadata);
    return passedCommandResult(
      command,
      result.exitCode,
      validation
        ? await validationOutput(this.files.root, output)
        : { output: boundedDiagnostic(output, "", 4_000) },
      this.environment.target(),
      validation,
    );
  }

  /**
   * Read-only inspection is no validation evidence: it stays out of the check
   * journal, and grep's exit status 1 ("no line matched") is not a failure.
   */
  private async inspectionResult(command: string, result: WorkspaceCommandResult, output: string,
    inspection: "read" | "search"): Promise<LightToolResult<unknown>> {
    // Exit 141: a reader such as `head` closed the pipe once it had enough,
    // and pipefail reports the writer's SIGPIPE.
    const pipeClosed = result.exitCode === 141 && command.includes("|");
    const tolerated = result.exitCode === 0 || pipeClosed || (inspection === "search" && result.exitCode === 1);
    if (result.interruption || !tolerated)
      return failedCommandResult(result.exitCode, output, result.interruption
        ? commandFailure() : await commandFailureAssessment(output, this.files, undefined, result.exitCode));
    return { status: "ok", data: {
      command,
      exitCode: result.exitCode,
      ...(result.exitCode === 1 ? { noMatch: true } : {}),
      ...(pipeClosed ? { pipeClosedEarly: true } : {}),
      output: boundedDiagnostic(output, "", 4_000),
      environment: this.environment.target(),
      ...(/\b(?:grep|rg|cat|sed|head|tail)\b/u.test(command) && !command.includes("node_modules")
        ? { guidance: "search_code (regex, files output, context lines) and read_code (line ranges) answer source inspection with sN aliases and read coverage." }
        : {}),
    } };
  }

  private async recordCommandValidation(
    command: string,
    status: "failed" | "passed" | "unknown",
    snapshot: WorkspaceSnapshot,
    metadata: ValidationMetadata,
    failure?: FailureAssessment,
  ) {
    const paths = metadata.validationScope === "invocation_only" ? [] : validationScopePaths(
      await this.journal.currentChangedPaths(),
      snapshot.files,
      metadata.cwd ?? ".",
    );
    await this.journal.recordValidation({
      ...(metadata.validationScope ? { scope: metadata.validationScope } : {}),
      command,
      cwd: metadata.cwd,
      paths,
      sourceRevisionId:
        metadata.sourceRevisionId ?? snapshot.revision.source_revision_id,
      status,
      taskId: metadata.taskId,
      taskKind: metadata.taskKind,
      check: metadata.check,
      ...(metadata.args?.length ? { args: metadata.args } : {}),
      ...(failure
        ? { category: failure.category, recovery: failure.recovery }
        : {}),
    });
    return paths;
  }

  private async resolveProjectTask(
    input: Extract<LightRunTaskInput, { kind: "project" }>,
  ) {
    const snapshot = await this.files.snapshot();
    const tasks = await readTaskCatalog(this.files.root, snapshot.files);
    const packagePath = input.packagePath
      ? this.files.normalizePath(input.packagePath)
      : undefined;
    const scoped = packagePath
      ? tasks.filter((task) => packageMatches(task, packagePath))
      : tasks;
    const candidates = matchingTasks(scoped, input.task);
    if (candidates.length !== 1)
      throw new TaskSelectionError(taskSelectionError(input.task, candidates));
    if (input.args?.length && candidates[0]!.kind !== "test")
      throw new TaskSelectionError("Extra arguments are supported only for project test tasks.");
    const selected = candidates[0]!;
    return { ...selected, ...(selected.kind === "test"
      ? { typecheckSelections: typecheckSelections(tasks, selected.cwd) } : {}) };
  }
}

class TaskSelectionError extends Error {}

const outputPageBytes = 12_000;
// Under Claude Code's 300 s limit on a silent MCP tool call, should a
// Claude Code build ignore the variable that lifts it (claude-code-cli.ts).
const inspectExitWaitMs = 4 * 60_000;
const keptFinishedRuns = 20;

/** A result whose output was cut says how to page the whole of it. */
function withFullOutput(result: LightToolResult<unknown>, runId: string): LightToolResult<unknown> {
  if (!JSON.stringify(result).includes("diagnostic truncated")) return result;
  const fullOutput = { kind: "inspect", run: runId, cursor: "0", until: "now" };
  return result.status === "ok"
    ? { ...result, data: { ...recordValue(result.data), fullOutput } }
    : ({ ...result, fullOutput } as unknown as LightToolResult<unknown>);
}

function managedServiceResult(taskId: string): LightToolResult<unknown> {
  return blocked(
    "environment",
    `Project task ${taskId} is a long-running service managed by the preview runtime.`,
    "Inspect the managed preview once when visual evidence matters. Do not start a replacement server or database from run_task.",
  );
}

function sourceChangedDuringValidation(
  exitCode: number | undefined,
  output: string,
  failure?: FailureAssessment,
  changedPaths: string[] = [],
  command?: string,
): LightToolResult<unknown> {
  if (failure) return failedCommandResult(exitCode, output, failure, command);
  return {
    status: "ok",
    data: {
      changed: changedPaths.length > 0,
      paths: changedPaths,
      exitCode,
      output: boundedDiagnostic(output, "", 4_000),
      validation: {
        status: "stale",
        reason:
          "Source changed during execution; run a check on the resulting code to verify it.",
      },
    },
  };
}

function matchingTasks(tasks: TaskCatalogItem[], requested: string) {
  const identified = tasks.filter((task) => task.task_id === requested);
  if (identified.length) return identified;
  const scripted = tasks.filter((task) => task.script === requested);
  return scripted.length
    ? scripted
    : tasks.filter((task) => task.kind === requested);
}

function packageMatches(task: TaskCatalogItem, packagePath: string) {
  const normalized =
    packagePath.replace(/(?:^|\/)package\.json$/u, "").replace(/\/$/u, "") || ".";
  return task.cwd === normalized || task.task_id.startsWith(`${normalized}:`);
}

function taskSelectionError(task: string, candidates: TaskCatalogItem[]) {
  if (!candidates.length) return `No project task matches ${task}.`;
  return `Project task ${task} is ambiguous: ${candidates.map(({ task_id }) => task_id).join(", ")}.`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function redactedOutput(output: string | Uint8Array) {
  return redactSecuritySecrets(String(output ?? "").trim());
}

function passedCommandResult(
  command: string,
  exitCode: number | undefined,
  output: ValidationOutput,
  environment: string,
  validation: ReturnType<typeof validationProof>,
): LightToolResult<unknown> {
  return {
    status: "ok",
    data: {
      command,
      exitCode,
      ...output,
      environment,
      ...(validation ? { validation } : {}),
    },
  };
}

function validationProof(
  sourceRevisionId: string | undefined,
  paths: string[],
  metadata: ValidationMetadata,
) {
  if (!sourceRevisionId || !isValidationKind(metadata.taskKind))
    return undefined;
  return {
    paths,
    sourceRevisionId,
    status: "passed" as const,
    taskId: metadata.taskId,
    taskKind: metadata.taskKind,
    ...(metadata.validationScope ? { scope: metadata.validationScope } : {}),
  };
}

function formattedResult(
  result: Extract<LightToolResult<unknown>, { status: "ok" }>,
  paths: string[],
): Extract<LightToolResult<unknown>, { status: "ok" }> {
  return {
    ...result,
    data: {
      ...record(result.data),
      mutation: "deterministic_format",
      formatter: "prettier",
      paths,
    },
  };
}

/** Waits for a promise unless the signal aborts first; never rejects for the promise itself. */
function abortable(promise: Promise<unknown>, signal: AbortSignal | undefined) {
  if (!signal) return promise.then(() => undefined, () => undefined);
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("Aborted."));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      () => resolve(),
      () => resolve(),
    ).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function blocked(
  category: "input" | "code" | "environment" | "external",
  message: string,
  recovery?: string,
): LightToolResult<unknown> {
  return {
    status: "blocked",
    category,
    message,
    ...(recovery ? { recovery } : {}),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
