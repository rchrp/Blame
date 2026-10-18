import type { CheckObservation } from "./check-observation.js";
import type { JournalCompletionSnapshot } from "./session-journal.js";
import { checkInvocationKey } from "./light-check-repair.js";

type Validation = JournalCompletionSnapshot["validations"][number];
const checkKinds = new Set(["build", "test", "typecheck", "lint"]);

/** Present recorded evidence; never infer counters or promote validation. */
export function checkReporting(check: CheckObservation, includeGuidance = true) {
  return {
    process: check.process, exitCode: check.exitCode ?? null,
    execution: check.execution, outcome: check.outcome,
    counts: {
      executed: check.counts?.executed ?? null,
      passed: check.counts?.passed ?? check.reportedCounts?.passed ?? null,
      failed: check.counts?.failed ?? check.reportedCounts?.failed ?? null,
      skipped: check.counts?.skipped ?? check.reportedCounts?.skipped ?? null,
      pending: check.reportedCounts?.pending ?? null,
    },
    evidenceOrigin: check.evidenceOrigin, selection: check.selection,
    ...(check.selectionFailure ? { selectionFailure: check.selectionFailure } : {}),
    ...(check.typechecking ? { typechecking: check.typechecking } : {}),
    freshness: check.freshness, admission: "unverified" as const,
    ...(includeGuidance ? { guidance: "Null means unreported, never zero. Pending is distinct from skipped. Counters follow the runner (some combine skipped/todo). Process success, passing tests, admitted source verification and user acceptance are separate claims." } : {}),
  };
}

export function currentValidationReport(state: JournalCompletionSnapshot, history: Validation[] = state.validations) {
  const checks = state.validations.slice(-16).map((validation) => ({
    ...(validation.scope ? { scope: validation.scope } : {}),
    id: validation.id, task: validation.taskId ?? null, command: validation.command ?? null,
    args: validation.args ?? [], cwd: validation.cwd ?? ".",
    sourceRevisionId: validation.sourceRevisionId ?? null,
    recordedAt: validation.timestamp, taskKind: validation.taskKind ?? null,
    recordedPaths: validation.paths.slice(0, 32), recordedPathCount: validation.paths.length,
    recordedPathsTruncated: validation.paths.length > 32,
    status: validation.status, terminal: validation.terminal,
    category: validation.category ?? null,
    reporting: validation.check ? checkReporting(validation.check, false) : null,
    ...(validation.check?.evidence ? { evidence: validation.check.evidence } : {}),
    admission: checkKinds.has(validation.taskKind ?? "") && validation.status === "passed" && validation.terminal === "passed" ? "admitted" : "unverified",
  }));
  const previous = previousChecks(state, history);
  return { sourceRevisionId: state.sourceRevisionId, scope: "current_source_only" as const,
    checks, total: state.validations.length, truncated: state.validations.length > checks.length,
    failed: state.validations.filter((item) => item.status === "failed").length,
    previousChecks: boundedPreviousChecks(previous, 8, 6_000), previousTotal: previous.length,
    environment: "not_rechecked" as const, userCriteria: "not_assessed" as const,
    guidance: "checks contains only current-source journal entries. previousChecks is bounded historical evidence, never eligible for current source. Source identity does not recheck installed dependencies or the environment, prove invocation start time, or assess user criteria. This view launches no commands and admits no validation. Null counters are unreported, never zero; pending differs from skipped.",
  };
}

/** Explicit post-edit invalidation, not a command, proof, or prose validator. */
export function validationStateAfterEdit(state: JournalCompletionSnapshot, history: Validation[], editSourceRevisionId: unknown) {
  if (editSourceRevisionId !== state.sourceRevisionId) return undefined;
  const previous = previousChecks(state, history);
  if (!previous.length) return undefined;
  const checks = boundedPreviousChecks(previous, 6, 1_800);
  return { sourceRevisionId: state.sourceRevisionId, observation: "current_source_snapshot_after_operation" as const, invalidatedChecks: checks,
    omitted: previous.length - checks.length, nextRead: { target: "@checks" },
    guidance: "These invocation results do not apply to this source snapshot. After the final source/test edit, rerun every required invocation and any optional check you claim as final. Historical success, current passing tests, admitted verification and user acceptance are distinct. This receipt runs no check and rechecks no environment.",
  };
}

function previousChecks(state: JournalCompletionSnapshot, history: Validation[]) {
  const latest = new Map<string, { validation: Validation; index: number }>();
  history.forEach((validation, index) => {
    if (checkKinds.has(validation.taskKind ?? "") || validation.check)
      latest.set(checkInvocationKey(validation), { validation, index });
  });
  const current = new Set(state.validations.map(checkInvocationKey));
  return [...latest.values()].filter(({ validation }) => !current.has(checkInvocationKey(validation)))
    .sort((a, b) => b.index - a.index).map(({ validation }) => ({
      id: validation.id, task: validation.taskId ?? null, cwd: validation.cwd ?? ".", args: validation.args ?? [],
      ...(!validation.taskId ? { command: validation.command } : {}),
      sourceRevisionId: validation.sourceRevisionId ?? null, recordedAt: validation.timestamp,
      sourceState: validation.sourceRevisionId && validation.sourceRevisionId !== state.sourceRevisionId
        ? "earlier_source" as const : "not_current" as const,
      previousOutcome: validation.check?.outcome ?? validation.terminal,
      eligibleForCurrentSource: false as const, admission: "unverified" as const,
    }));
}

function boundedPreviousChecks(checks: ReturnType<typeof previousChecks>, limit: number, maximumBytes: number) {
  const kept: typeof checks = [];
  for (const check of checks) {
    if (kept.length >= limit) break;
    // Omit an oversized identity instead of truncating cwd/argv into another invocation.
    if (Buffer.byteLength(JSON.stringify([...kept, check])) <= maximumBytes) kept.push(check);
  }
  return kept;
}

export type LightValidationReport = ReturnType<typeof currentValidationReport>;
