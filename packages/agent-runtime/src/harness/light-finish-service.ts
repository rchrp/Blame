import { setTimeout as delay } from "node:timers/promises";
import type { CompletionDecision } from "@blame/harness-core";
import type { AgentToolContext } from "@cline/sdk";
import {
  finishImages,
  type LightCompletionNotification,
  type LightValidationActivity,
} from "./light-completion.js";
import type {
  FinishTaskImage,
  LightRunTaskInput,
  LightTaskContract,
  LightToolResult,
} from "./light-contracts.js";
import {
  finishTaskInputSchema,
  lightRequiredChecksSchema,
} from "./light-contracts.js";
import { LightTaskRunner } from "./light-task-runner.js";
import { LightCommitService } from "./light-commit.js";
import { createProjectMemoryCandidate } from "./project-memory.js";
import { SessionJournal } from "./session-journal.js";
import { readTaskCatalog } from "./task-catalog.js";
import { WorkspaceFiles } from "./workspace-files.js";
import { validationScopePaths } from "./validation-scope.js";
import { currentValidationReport } from "./light-validation-report.js";
import { checkInvocationKey, latestFailedInvocations } from "./light-check-repair.js";

export type LocalFinishOptions = {
  conversationId: string;
  onComplete?(notification: LightCompletionNotification): Promise<void> | void;
  onValidationActivity?(
    activity: LightValidationActivity,
  ): Promise<void> | void;
  taskContract?: LightTaskContract;
  workspaceRoot: string;
};

type LocalFinishTaskInput = {
  context: AgentToolContext;
  input: unknown;
  taskContract?: LightTaskContract;
  workspaceRoot: string;
};

export async function executeLocalFinishTask(
  input: LocalFinishTaskInput,
): Promise<LightToolResult<unknown>> {
  const value = recordValue(input.input);
  if (typeof value.summary !== "string")
    return blockedFinish("A finish summary is required.");
  const notifications: LightCompletionNotification[] = [];
  const validationActivities: LightValidationActivity[] = [];
  const service = createCapturedService(
    input,
    notifications,
    validationActivities,
  );
  try {
    const summary = await service.finish(
      value.summary,
      input.context,
      finishImages(parsedImages(value.images)),
    );
    return {
      status: "ok",
      data: {
        notification: notifications.at(-1),
        summary,
        validationActivities,
      },
    };
  } catch (error) {
    return blockedFinish(errorMessage(error));
  }
}

export class LightFinishService {
  private readonly files: WorkspaceFiles;
  private readonly journal: SessionJournal;
  private readonly options: LocalFinishOptions;
  private readonly tasks: LightTaskRunner;
  private validationSequence = 0;

  constructor(options: LocalFinishOptions) {
    this.options = options;
    this.files = new WorkspaceFiles(options.workspaceRoot);
    this.journal = new SessionJournal(
      options.workspaceRoot,
      options.conversationId,
    );
    this.tasks = new LightTaskRunner({
      files: this.files,
      journal: this.journal,
    });
  }

  async finish(
    summary: string,
    context: AgentToolContext,
    images: FinishTaskImage[] = [],
  ) {
    const initial = await this.completionSnapshot();
    this.assertDelivered(initial.changedPaths);
    assertNoFailedValidation(initial);
    const validation = await this.validateIfNeeded(initial, context);
    const current = await this.completionSnapshot();
    assertNoFailedValidation(current);
    const required = validation.required ?? [];
    const obligations = required.map(({ id, input, cwd, taskKind }) => ({
      id: `check:${id}`,
      passed: current.validations.some((item) => sameInvocation(item, input, cwd) && passedExecution(item, taskKind)),
    }));
    const scopeVerified = current.changedPaths.length ? hasPassingValidation(
      current.validations,
      current.changedPaths,
      validation.taskIds,
    ) : required.length > 0 && required.every(({ input, cwd }) =>
      current.validations.some((item) => sameInvocation(item, input, cwd) && item.status === "passed" && item.terminal === "passed"));
    const verified = scopeVerified && obligations.every(({ passed }) => passed);
    const unavailable = (current.changedPaths.length > 0 || required.length > 0) && !verified;
    const decision = completionDecision(
      current.sourceRevisionId,
      verified,
      unavailable,
      current.changedPaths.length === 0 && required.length === 0,
      obligations,
      current.validations.some((item) =>
        item.sourceRevisionId === current.sourceRevisionId && passedExecution(item, "test")),
    );
    await this.recordCompletion(
      summary,
      decision,
      verified,
      unavailable,
      current,
      validation.taskIds?.find((taskId) =>
        hasPassingValidation(current.validations, current.changedPaths, [taskId]),
      ),
      images,
    );
    return summary;
  }

  private completionSnapshot() {
    return new LightCommitService(this.files).exclusive(() =>
      this.journal.completionSnapshot(),
    );
  }

  private assertDelivered(changedPaths: string[]) {
    const required =
      this.options.taskContract?.effect_requirement === "source_change";
    if (required && !changedPaths.length)
      throw new Error("Completion requires a current source change.");
  }

  private async validateIfNeeded(
    state: Awaited<ReturnType<SessionJournal["completionSnapshot"]>>,
    context: AgentToolContext,
  ) {
    const required = await this.requiredValidationInputs();
    if (!state.changedPaths.length && !required.length)
      return { outcome: "not_applicable" as const };
    const inputs = await this.validationInputs(state.changedPaths);
    for (const selection of required)
      if (!inputs.some(({ input, cwd }) => sameInvocation({ taskId: input.task, args: input.args, cwd }, selection.input, selection.cwd)))
        inputs.push({ ...selection, paths: state.changedPaths });
    const failedKeys = new Set(latestFailedInvocations(this.journal.currentValidations()).map(checkInvocationKey));
    // Stable order within each group; a different test filter never clears a
    // failure just because it uses the same catalog task ID.
    inputs.sort((left, right) => Number(failedKeys.has(checkInvocationKey({ taskId: right.input.task, args: right.input.args, cwd: right.cwd }))) -
      Number(failedKeys.has(checkInvocationKey({ taskId: left.input.task, args: left.input.args, cwd: left.cwd }))));
    const pendingTests = inputs.filter(({ input, cwd }) =>
      input.args !== undefined && !state.validations.some((item) => sameInvocation(item, input, cwd)),
    );
    if (pendingTests.length > 16)
      throw new Error("Automatic validation refresh is limited to 16 test selections. Refresh the requested tests with run_task before finishing.");
    for (const { input, paths, cwd } of inputs) {
      const matching = state.validations.filter((item) => sameInvocation(item, input, cwd));
      const requirement = required.find((selection) => sameInvocation({ taskId: input.task, args: input.args, cwd }, selection.input, selection.cwd));
      // Preserve failed selection evidence and any missing exact obligation;
      // repeating the same unavailable discovery cannot validate the source.
      if (matching.some((item) => item.category === "command" &&
        item.check?.selectionFailure === "no_test_files" && item.terminal === "failed")) continue;
      if (requirement && matching.some((item) => passedExecution(item, requirement.taskKind)))
        continue;
      if (!requirement && hasPassingValidation(matching, paths, [input.task]))
        continue;
      if (hasUnavailableValidation(matching, paths, input.task))
        continue;
      if (requirement &&
        matching.some((item) => item.category === "environment" && item.status === "failed" && item.terminal === "failed"))
        continue;
      if (matching.some((validation) => validation.status === "unknown"))
        continue;
      const result = await this.runValidation(input, context);
      if (result.status === "blocked" && result.category === "code")
        throw new Error(result.message);
      if (
        result.status === "ok" &&
        recordValue(recordValue(result.data).validation).status === "stale"
      )
        throw new Error(
          "Source changed during final validation. Review the changes and validate again.",
        );
      // Do not spend another round on green checks while a refreshed code
      // failure still blocks completion. Required obligations remain pending.
      assertNoFailedValidation(await this.completionSnapshot());
    }
    return {
      outcome: "checked" as const,
      taskIds: inputs.map(({ input }) => input.task),
      required,
    };
  }

  private async requiredValidationInputs() {
    const checks = lightRequiredChecksSchema.parse(this.options.taskContract?.required_checks ?? []);
    if (!checks.length) return [];
    const snapshot = await this.files.snapshot();
    const catalog = await readTaskCatalog(this.files.root, snapshot.files);
    return checks.map(({ id, task, args }) => {
      const matches = catalog.filter(({ task_id }) => task_id === task);
      const item = matches[0];
      if (matches.length !== 1 || !item || !["build", "test", "typecheck", "lint"].includes(item.kind))
        throw new Error(`Required check ${id} needs an exact build/test/typecheck/lint catalog ID: ${task}.`);
      if (args?.length && item.kind !== "test")
        throw new Error(`Required check ${id}: extra argv is supported only for test tasks.`);
      return { id, cwd: item.cwd, taskKind: item.kind, input: { kind: "project" as const, task,
        ...(item.kind === "test" ? { args: args ?? [] } : {}) } };
    });
  }

  private async validationInputs(changedPaths: string[]) {
    const snapshot = await this.files.snapshot();
    const observations = this.journal.currentValidations();
    const attempted = new Set(observations.map(({ taskId }) => taskId));
    const catalog = (
      await readTaskCatalog(this.files.root, snapshot.files)
    ).filter(({ task_id }) => attempted.has(task_id));
    const scopes = [...new Set(catalog.map(({ cwd }) => cwd))];
    const failedTasks = latestFailedTasks(this.journal.currentValidations());
    return scopes.flatMap((cwd) => {
      const paths = validationScopePaths(changedPaths, snapshot.files, cwd);
      if (!paths.length) return [];
      const scopedTasks = catalog.filter((item) => item.cwd === cwd);
      const task = selectValidationTask(scopedTasks, paths);
      const required = scopedTasks.filter((item) =>
        failedTasks.has(item.task_id),
      );
      if (task && !required.includes(task)) required.push(task);
      // Keep every literal test selection already requested in this package.
      // A catalog ID alone cannot represent two filters of the same test task.
      const selections = new Map<string, {
        input: Extract<LightRunTaskInput, { kind: "project" }>;
        paths: string[];
        cwd: string;
      }>();
      for (const item of required.filter((item) => item.kind !== "test"))
        selections.set(item.task_id, {
          input: { kind: "project", task: item.task_id }, paths, cwd,
        });
      for (const observation of observations) {
        if (observation.cwd !== cwd || !scopedTasks.some((item) =>
          item.task_id === observation.taskId && item.kind === "test")) continue;
        const args = observation.args ?? [];
        selections.set(JSON.stringify([observation.taskId, args]), {
          input: { kind: "project", task: observation.taskId!, args: [...args] }, paths, cwd,
        });
      }
      return [...selections.values()];
    });
  }

  private async runValidation(
    input: Extract<LightRunTaskInput, { kind: "project" }>,
    context: AgentToolContext,
  ): Promise<LightToolResult<unknown>> {
    const toolCallId = `${context.toolCallId ?? "finish"}:validation:${++this.validationSequence}`;
    await this.options.onValidationActivity?.({
      input,
      phase: "started",
      toolCallId,
    });
    let output = await this.tasks.run(input, context);
    // Automatic final validation owns this invocation through bounded completion.
    // A running handle is not evidence that the requested test has finished.
    while (output.status === "ok" && typeof recordValue(output.data).run === "string") {
      await delay(100, undefined, { signal: context.signal });
      const inspected = await this.tasks.run({
        kind: "inspect", run: String(recordValue(output.data).run),
      }, context);
      output = inspected.status === "ok" && recordValue(inspected.data).completed
        ? recordValue(inspected.data).completed as LightToolResult<unknown>
        : inspected;
    }
    context.signal?.throwIfAborted();
    await this.options.onValidationActivity?.({
      input,
      output,
      phase: "finished",
      toolCallId,
    });
    return output;
  }

  private async recordCompletion(
    summary: string,
    decision: CompletionDecision,
    verified: boolean,
    unavailable: boolean,
    state: Awaited<ReturnType<SessionJournal["completionSnapshot"]>>,
    validationTaskId?: string,
    images: FinishTaskImage[] = [],
  ) {
    await this.journal.recordTerminal(
      unavailable ? "completed_with_validation_unavailable" : "completed",
      summary,
    );
    const memory =
      verified && validationTaskId
        ? this.completionMemory(summary, state, validationTaskId)
        : undefined;
    await this.options.onComplete?.({
      completion: decision,
      ...(images.length ? { images } : {}),
      ...(memory ? { memory } : {}),
      submission_outcome: "accepted",
      validationReport: currentValidationReport(state, this.journal.currentValidations()),
      summary,
      verified,
    });
  }

  private completionMemory(
    summary: string,
    state: Awaited<ReturnType<SessionJournal["completionSnapshot"]>>,
    validationTaskId?: string,
  ) {
    if (!state.files.length || state.files.length > 24) return undefined;
    const validation = state.validations.find(
      (item) => item.taskId === validationTaskId && item.terminal === "passed",
    );
    return createProjectMemoryCandidate({
      files: state.files,
      objective: this.options.taskContract?.objective ?? "",
      sourceRevisionId: state.sourceRevisionId,
      storyId: this.options.taskContract?.story_id,
      summary,
      symbols: state.symbols,
      validationKind: validation?.taskKind,
      validationTaskId,
    });
  }
}

function createCapturedService(
  input: LocalFinishTaskInput,
  notifications: LightCompletionNotification[],
  activities: LightValidationActivity[],
) {
  return new LightFinishService({
    conversationId: input.taskContract?.session_id ?? "unscoped-session",
    onComplete: (value) => {
      notifications.push(value);
    },
    onValidationActivity: (value) => {
      activities.push(value);
    },
    taskContract: input.taskContract,
    workspaceRoot: input.workspaceRoot,
  });
}

function selectValidationTask(
  tasks: Awaited<ReturnType<typeof readTaskCatalog>>,
  paths: string[],
) {
  const priorities = ["build", "test", "typecheck", "lint"];
  return tasks
    .filter(({ kind }) => priorities.includes(kind))
    .map((task) => ({
      task,
      score: validationTaskScore(task, paths, priorities),
    }))
    .sort((left, right) => right.score - left.score)[0]?.task;
}

function validationTaskScore(
  task: Awaited<ReturnType<typeof readTaskCatalog>>[number],
  paths: string[],
  priorities: string[],
) {
  const scope = task.cwd === "." ? "" : `${task.cwd}/`;
  const scoped = paths.filter((path) => path.startsWith(scope)).length;
  return scoped * 100 + (priorities.length - priorities.indexOf(task.kind));
}

function sameInvocation(
  validation: { taskId?: string; args?: string[]; cwd?: string },
  input: Extract<LightRunTaskInput, { kind: "project" }>,
  cwd: string,
) {
  return validation.taskId === input.task && (validation.cwd ?? ".") === cwd &&
    JSON.stringify(validation.args ?? []) === JSON.stringify(input.args ?? []);
}

/** Satisfies an execution obligation only; it never promotes unknown test scope. */
function passedExecution(validation: Awaited<ReturnType<SessionJournal["completionSnapshot"]>>["validations"][number], taskKind: string) {
  if (validation.taskKind !== taskKind) return false;
  if (taskKind === "test") return validation.check?.process === "exited" &&
    validation.check.execution === "observed" && validation.check.outcome === "passed";
  return validation.status === "passed" && validation.terminal === "passed";
}

function hasPassingValidation(
  validations: Awaited<
    ReturnType<SessionJournal["completionSnapshot"]>
  >["validations"],
  changedPaths: string[],
  taskIds?: string[],
) {
  if (!taskIds?.length || !changedPaths.length) return false;
  const paths = new Set(
    validations
      .filter(
        (validation) =>
          validation.status === "passed" &&
          validation.terminal === "passed" &&
          taskIds.includes(validation.taskId ?? ""),
      )
      .flatMap((validation) => validation.paths),
  );
  return changedPaths.every((path) => paths.has(path));
}

function hasUnavailableValidation(
  validations: Awaited<
    ReturnType<SessionJournal["completionSnapshot"]>
  >["validations"],
  changedPaths: string[],
  taskId: string,
) {
  return validations.some(
    ({ category, paths, status, taskId: validationTaskId, terminal }) =>
      category === "environment" &&
      status === "failed" &&
      terminal === "failed" &&
      validationTaskId === taskId &&
      changedPaths.every((path) => paths.includes(path)),
  );
}

function completionDecision(
  sourceRevisionId: string,
  verified: boolean,
  unavailable: boolean,
  nonMutating: boolean,
  obligations: Array<{ id: string; passed: boolean }>,
  observedPassingTest = false,
): CompletionDecision {
  return {
    source_revision_id:
      sourceRevisionId as CompletionDecision["source_revision_id"],
    delivery: "satisfied",
    verification: verified
      ? "verified"
      : nonMutating
        ? "not_applicable"
        : "unverified",
    satisfied_obligations: [...(verified ? ["validation"] : []), ...obligations.filter(({ passed }) => passed).map(({ id }) => id)],
    missing_obligations: obligations.filter(({ passed }) => !passed).map(({ id }) => id),
    failed_obligations: [],
    reservations: [
      ...(obligations.some(({ passed }) => !passed) ? [{
        code: "REQUIRED_CHECK_UNCONFIRMED",
        message: "A required final-source invocation has no observed passing execution. User acceptance criteria remain a separate assessment.",
        obligation_ids: obligations.filter(({ passed }) => !passed).map(({ id }) => id),
      }] : []),
      ...(unavailable && !nonMutating
        ? [
            {
              code: "VALIDATION_UNAVAILABLE",
              message: observedPassingTest
                ? "A test invocation reported a passing result. Its evidence does not establish verification of the current source."
                : "No current project validation was available.",
              obligation_ids: [],
            },
          ]
        : []),
    ],
  };
}

function assertNoFailedValidation(
  state: Awaited<ReturnType<SessionJournal["completionSnapshot"]>>,
) {
  const failed = state.validations.filter(
    (validation) =>
      validation.terminal === "failed" &&
      validation.category === "code" &&
      ["build", "test", "typecheck", "lint"].includes(
        validation.taskKind ?? "",
      ),
  );
  if (failed.length)
    throw new Error(
      `Current validation is still failing: ${failed.map((item) => item.taskId ?? item.command).join(", ")}. Resolve it and run the relevant check before finishing.`,
    );
}

function latestFailedTasks(
  validations: ReturnType<SessionJournal["currentValidations"]>,
) {
  return new Set(
    latestFailedInvocations(validations)
      .filter(
        (validation) =>
          validation.taskId &&
          validation.terminal === "failed" &&
          validation.category === "code" &&
          ["build", "test", "typecheck", "lint"].includes(
            validation.taskKind ?? "",
          ),
      )
      .map((validation) => validation.taskId!),
  );
}

function blockedFinish(message: string): LightToolResult<unknown> {
  return { status: "blocked", category: "code", message };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// The remote finish receives images already checked by the agent runtime.
function parsedImages(value: unknown) {
  const parsed = finishTaskInputSchema.shape.images.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
