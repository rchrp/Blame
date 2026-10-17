import { relative } from "node:path";
import { isTestInvocation, observeCheck, type CheckObservation } from "./check-observation.js";
import { LightCommitService } from "./light-commit.js";
import { redactSecuritySecrets } from "../security-secret-redaction.js";
import { EnvironmentAdapter } from "./environment-adapter.js";
import { blockedCommandReason } from "./command-policy.js";
import { observeCommand } from "./command-changes.js";
import {
  DeterministicFormatter,
  DeterministicFormatterError,
  type FormatterCommand,
} from "./deterministic-formatter.js";
import type { LightRunTaskInput, LightToolResult, LightTaskContract } from "./light-contracts.js";
import {
  dependencyManifestSections,
  LightDependencyService,
} from "./light-dependencies.js";
import { boundedDiagnostic } from "./light-diagnostic.js";
import type { FormattedFileReplacement, LightEditService } from "./light-edit.js";
import { sha256 } from "./light-identity.js";
import type { SessionJournal } from "./session-journal.js";
import {
  readTaskCatalog,
  taskInvocation,
  taskInvocationDisplay,
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

type RunnerContext = {
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
  invocationEnvironment?: Awaited<ReturnType<typeof environmentManifestEvidence>>;
};

type FailureAssessment = {
  category: "code" | "command" | "environment";
  recovery: string;
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
    if (input.kind === "inspect") return this.inspect(input);
    if (input.kind === "dependency") return this.dependency(input, context);
    if (input.kind === "project") return this.project(input, context);
    return this.command(input, context);
  }

  private async inspect(
    input: Extract<LightRunTaskInput, { kind: "inspect" }>,
  ): Promise<LightToolResult<unknown>> {
    const run = this.runs.get(input.run);
    if (!run)
      return blocked(
        "input",
        `Run ${input.run} does not belong to this session or is no longer available.`,
      );
    try {
      const snapshot = run.handle.inspect(input.cursor);
      return {
        status: "ok",
        data: {
          run: input.run,
          command: run.command,
          ...snapshot,
          output: redactedOutput(snapshot.output),
          ...(run.result ? { completed: run.result } : {}),
        },
      };
    } catch (error) {
      return blocked("input", errorMessage(error));
    }
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
    task: TaskCatalogItem,
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
      const invocation = this.environment.command(input.command);
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
      return await this.applyFormatter(this.edits, request, input.cwd, context);
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
    let publishHandle!: (handle: CommandHandle) => void;
    const started = new Promise<CommandHandle>((resolve) => {
      publishHandle = resolve;
    });
    const completion = new LightCommitService(this.files)
      .exclusive(() =>
        this.executeLocked(
          executable,
          args,
          cwd,
          command,
          context,
          metadata,
          publishHandle,
        ),
      )
      .catch((error) => blocked("environment", errorMessage(error)));
    const first = await Promise.race([
      completion.then((result) => ({ kind: "complete" as const, result })),
      started.then((handle) => ({ kind: "started" as const, handle })),
    ]);
    if (first.kind === "complete") return first.result;
    const runId = `r${++this.runSequence}`;
    const managed: ManagedRun = { command, completion, handle: first.handle };
    this.runs.set(runId, managed);
    void completion.then((result) => {
      managed.result = result;
    });
    const initial = await Promise.race([
      completion.then((result) => ({ kind: "complete" as const, result })),
      delay(this.initialCommandWaitMs).then(() => ({ kind: "running" as const })),
    ]);
    if (initial.kind === "complete") {
      this.runs.delete(runId);
      return initial.result;
    }
    const snapshot = first.handle.inspect();
    return {
      status: "ok",
      data: {
        run: runId,
        command,
        ...snapshot,
        output: redactedOutput(snapshot.output),
      },
    };
  }

  private async executeLocked(
    executable: string, args: string[], cwd: string, command: string,
    context: RunnerContext, metadata: ValidationMetadata,
    publishHandle: (handle: CommandHandle) => void,
  ): Promise<LightToolResult<unknown>> {
    context.signal?.throwIfAborted();
    const snapshot = await this.files.snapshot(context.signal);
    const directory =
      relative(this.files.root, cwd).replaceAll("\\", "/") || ".";
    const validation = metadata.taskId
      ? metadata
      : await this.commandValidation(command, directory, snapshot.files);
    const invocationEnvironment = validation.report?.nodeEvents
      ? await environmentManifestEvidence(this.files, snapshot.files) : undefined;
    const { result, after, changedPaths } = await observeCommand(this.files, this.journal,
      snapshot, () => {
        const handle = startWorkspaceCommand(executable, args, {
          cwd,
          signal: context.signal,
        });
        publishHandle(handle);
        return handle.completion;
      });
    return this.recordedResult(
      command,
      result,
      {
        ...metadata,
        ...validation,
        cwd: directory,
        sourceRevisionId: snapshot.revision.source_revision_id,
        ...(invocationEnvironment ? { invocationEnvironment } : {}),
      },
      after,
      changedPaths,
    );
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
    if (!identity) return {};
    const matches = tasks.filter((item) => item.task_id === identity.taskId && item.cwd === cwd);
    return { ...identity, ...(matches.length === 1 ? { taskCommand: matches[0]!.command } : {}) };
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
      return { status: "ok", data: { command, exitCode: result.exitCode,
        ...presented,
        ...(failure ? { failure } : {}), check, reporting: { ...checkReporting(check),
          invocationSourceRevisionId: metadata.sourceRevisionId ?? null,
          completedSourceRevisionId: snapshot.revision.source_revision_id, cwd: metadata.cwd ?? "." },
        changed: changedPaths.length > 0, paths: changedPaths,
        validation: { status: check.freshness === "stale" ? "stale" : check.outcome === "failed" ? "failed" : "unknown" },
      } };
    }
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
      );
    }
    const validatedPaths = await this.recordCommandValidation(
      command,
      status,
      snapshot,
      metadata,
      failure,
    );
    if (failure) return failedCommandResult(result.exitCode, output, failure);
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
    return candidates[0]!;
  }
}

class TaskSelectionError extends Error {}

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
): LightToolResult<unknown> {
  if (failure) return failedCommandResult(exitCode, output, failure);
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

function failedCommandResult(
  exitCode: number | undefined,
  output: string,
  failure: FailureAssessment,
): LightToolResult<unknown> {
  const diagnostic =
    boundedDiagnostic(output) || "No diagnostic output was produced.";
  return {
    status: "blocked",
    category: failure.category,
    message: `Command exited with code ${exitCode ?? "unknown"}.\n${diagnostic}`,
    recovery: failure.recovery,
  };
}

async function commandFailureAssessment(
  output: string,
  files: WorkspaceFiles,
  taskKind?: string,
  exitCode?: number,
): Promise<FailureAssessment> {
  const missingEnvironment = missingEnvironmentVariables(output);
  if (missingEnvironment.length)
    return environmentVariableFailure(missingEnvironment);
  const missingEntryModule = missingPythonEntryModule(output);
  if (missingEntryModule) return pythonEntryModuleFailure(missingEntryModule);
  const missing = missingDependencyNames(output);
  if (missing.length) {
    const declared = await declaredDependencies(files);
    if (missing.some((name) => declared.has(name)))
      return environmentDependencyFailure();
    return codeFailure();
  }
  // POSIX sh/dash omits "command" in its missing-executable diagnostic.
  // Require its shell-prefixed line and exit 127, not arbitrary "not found" text.
  if (exitCode === 127 && /^(?:\/[^\s:]+\/)?(?:sh|dash):\s*(?:line\s+)?(?:\d+:\s*)?[^:\r\n]+:\s*not found\s*$/mu.test(output))
    return environmentFailure();
  if (environmentDiagnostic(output)) return environmentFailure();
  return isValidationKind(taskKind) ? codeFailure() : commandFailure();
}

function missingPythonEntryModule(output: string) {
  if (/Traceback \(most recent call last\):/u.test(output)) return undefined;
  return /(?:^|\n)[^\r\n]*\bpython(?:\d+(?:\.\d+)*)?(?:\.exe)?: No module named ([\w.]+)\s*$/u.exec(
    output,
  )?.[1];
}

function pythonEntryModuleFailure(module: string): FailureAssessment {
  return {
    category: "environment",
    recovery: `Python cannot start module ${module} in this interpreter. Check the project environment and module name; install the required tool with the project's package manager if needed, then rerun the command.`,
  };
}

function environmentDiagnostic(output: string) {
  return /(?:\bEAI_AGAIN\b|\bEACCES\b|\bECONN(?:REFUSED|RESET)?\b|\bENETUNREACH\b|\bENOSPC\b|\bENOENT\b|\bENOTFOUND\b|\bEPERM\b|\bETIMEDOUT\b|\bELOOP\b|\bP1001\b|broken (?:symbolic )?link|can't reach database server|command not found|connection refused|could not connect to server|dangling symlink|failed to connect|managed preview.*(?:failed|unavailable)|no space left on device|no such file or directory|PACKAGE_MANAGER_UNAVAILABLE|permission denied|preview (?:container|runtime).*(?:failed|unavailable)|\.prisma\/client)/iu.test(
    output,
  );
}

function missingEnvironmentVariables(output: string) {
  const expressions = [
    /Cannot resolve environment variable:\s*([A-Z][A-Z0-9_]*)/giu,
    /Environment variable not found:\s*([A-Z][A-Z0-9_]*)/giu,
    /Missing environment variable:\s*([A-Z][A-Z0-9_]*)/giu,
  ];
  return [
    ...new Set(
      expressions.flatMap((expression) =>
        [...output.matchAll(expression)].map((match) => match[1]!),
      ),
    ),
  ];
}

function missingDependencyNames(output: string) {
  const expressions = [
    /Cannot find (?:module|package)\s+['"`]([^'"`]+)['"`]/giu,
    /Module not found:\s*(?:Error:\s*)?Can't resolve\s+['"`]([^'"`]+)['"`]/giu,
  ];
  return expressions
    .flatMap((expression) => [...output.matchAll(expression)])
    .flatMap((match) => {
      const name = dependencyName(match[1] ?? "");
      return name ? [name] : [];
    });
}

function dependencyName(value: string) {
  const installed = installedDependencyName(value);
  if (installed) return installed;
  if (
    !value ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.includes("\\")
  )
    return undefined;
  const segments = value.split("/");
  return value.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function installedDependencyName(value: string) {
  const portable = value.replaceAll("\\", "/");
  const installed = portable.split("/node_modules/").at(-1);
  if (!installed || installed === portable) return undefined;
  const segments = installed.split("/");
  return installed.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

async function declaredDependencies(files: WorkspaceFiles) {
  const names = new Set<string>();
  const snapshot = await files.snapshot();
  const manifests = snapshot.files.filter((path) =>
    path.endsWith("package.json"),
  );
  for (const path of manifests.slice(0, 200))
    for (const name of await manifestDependencies(files, path)) names.add(name);
  return names;
}

async function manifestDependencies(files: WorkspaceFiles, path: string) {
  try {
    const content = (await files.read(path)).content.toString("utf8");
    const manifest = JSON.parse(content) as Record<string, unknown>;
    return dependencyManifestSections.flatMap((key) =>
      Object.keys(record(manifest[key])),
    );
  } catch {
    return [];
  }
}

function codeFailure(): FailureAssessment {
  return {
    category: "code",
    recovery:
      "Fix the reported project error before running the relevant validation again.",
  };
}

function environmentDependencyFailure(): FailureAssessment {
  return {
    category: "environment",
    recovery:
      "Use the dependency operation once if the declared installation is incomplete; do not edit manifests or copy files through the shell.",
  };
}

function environmentVariableFailure(names: string[]): FailureAssessment {
  return {
    category: "environment",
    recovery: `Required runtime variable${names.length > 1 ? "s" : ""} ${names.join(", ")} ${names.length > 1 ? "are" : "is"} unavailable. Keep configuration environment-based; do not add credentials, localhost URLs, or source fallbacks. Continue with validations that do not require these values and report this validation unavailable.`,
  };
}

function environmentFailure(): FailureAssessment {
  return {
    category: "environment",
    recovery:
      "Inspect the reported environment problem and recover the required tool, path, or service through the available project operations before retrying.",
  };
}

function commandFailure(): FailureAssessment {
  return {
    category: "command",
    recovery:
      "Inspect the command output and adjust the command or its prerequisites before retrying.",
  };
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

function isValidationKind(
  value: string | undefined,
): value is TaskCatalogItem["kind"] {
  return ["build", "test", "typecheck", "lint"].includes(value ?? "");
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
