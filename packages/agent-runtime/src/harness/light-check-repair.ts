import type { LightRunTaskInput, LightTaskContract } from "./light-contracts.js";
import type { SessionJournal } from "./session-journal.js";
import { readTaskCatalog, plainCompilerCheck } from "./task-catalog.js";
import type { WorkspaceFiles } from "./workspace-files.js";

type Validation = ReturnType<SessionJournal["currentValidations"]>[number];
const checkKinds = new Set(["build", "test", "typecheck", "lint"]);

export function checkInvocationKey(value: { taskId?: string; cwd?: string; args?: string[]; command?: string }) {
  return JSON.stringify([value.cwd ?? ".", value.taskId ?? value.command, value.args ?? []]);
}

/** Literal selections remain distinct, even if they share a catalog task ID. */
export function latestFailedInvocations(validations: Validation[]) {
  const latest = new Map<string, Validation>();
  for (const value of validations) latest.set(checkInvocationKey(value), value);
  return [...[...latest.values()].filter(value => value.taskId && checkKinds.has(value.taskKind ?? "") &&
    value.terminal === "failed"), ...failedLiteralCompilerInvocations(validations)];
}

/** Only exact no-emit compiler commands; never replay arbitrary or compound shell. */
export function failedLiteralCompilerInvocations(validations: Validation[]) {
  const latest = new Map<string, Validation>();
  for (const value of validations) if (value.command && plainCompilerCheck(value.command))
    latest.set(JSON.stringify([value.cwd ?? ".", value.command]), value);
  return [...latest.values()].filter(value => !value.taskId && value.taskKind === "typecheck" && value.terminal === "failed");
}

export async function checkRepairPlan(files: WorkspaceFiles, journal: SessionJournal, contract?: LightTaskContract) {
  const failures = latestFailedInvocations(journal.currentValidations());
  if (!failures.length) return undefined;
  const state = await journal.completionSnapshot();
  const snapshot = await files.snapshot();
  const catalog = await readTaskCatalog(files.root, snapshot.files);
  const exactTask = (task: string, cwd?: string) => {
    const matches = catalog.filter(value => value.task_id === task && (cwd === undefined || value.cwd === cwd));
    return matches.length === 1 && checkKinds.has(matches[0]!.kind) ? matches[0] : undefined;
  };
  const repairFirst = failures.flatMap(value => {
    const item = value.taskId ? exactTask(value.taskId, value.cwd ?? ".") : undefined;
    const input: LightRunTaskInput | undefined = item && (!value.args?.length || item.kind === "test")
      ? { kind: "project", task: item.task_id, ...(item.kind === "test" ? { args: value.args ?? [] } : {}) }
      : !value.taskId && value.command && plainCompilerCheck(value.command)
        ? { kind: "command", command: value.command, ...(value.cwd && value.cwd !== "." ? { cwd: value.cwd } : {}) } : undefined;
    if (!input) return [];
    return [{ input, cwd: item?.cwd ?? value.cwd ?? ".",
      category: value.category ?? null, sourceRevisionId: value.sourceRevisionId ?? null,
      freshness: value.sourceRevisionId === state.sourceRevisionId ? "current" : "earlier_source",
      ...(value.recovery ? { recovery: value.recovery } : {}) }];
  });
  if (!repairFirst.length) return undefined;
  const required = (contract?.required_checks ?? []).flatMap(value => {
    const item = exactTask(value.task);
    if (!item || (value.args?.length && item.kind !== "test")) return [];
    const input: Extract<LightRunTaskInput, { kind: "project" }> = { kind: "project", task: value.task,
      ...(item.kind === "test" ? { args: value.args ?? [] } : {}) };
    return [{ id: value.id, input, cwd: item.cwd }];
  });
  return { sourceRevisionId: state.sourceRevisionId, advisoryOnly: true,
    repairFirst: repairFirst.slice(0, 4), omittedFailures: Math.max(0, repairFirst.length - 4),
    requiredAfterRepair: required.slice(0, 16), omittedRequirements: Math.max(0, required.length - 16),
    unresolvedRequirements: (contract?.required_checks?.length ?? 0) - required.length,
    instruction: "Investigate the failed selection first, including environment or test-expectation errors; an earlier-source failure is a repair lead, not a current result. Rerun that exact selection after repairing it before repeating already passing checks. After the final source/test edit, run every required invocation on that final source. Do not weaken tests, public types or user criteria. This advice runs no command and admits no validation or acceptance.",
  };
}
