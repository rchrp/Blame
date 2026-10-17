import type { CheckObservation } from "./check-observation.js";
import type { JournalCompletionSnapshot } from "./session-journal.js";

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

export function currentValidationReport(state: JournalCompletionSnapshot) {
  const checks = state.validations.slice(-16).map((validation) => ({
    ...(validation.scope ? { scope: validation.scope } : {}),
    id: validation.id, task: validation.taskId ?? null, command: validation.command ?? null,
    args: validation.args ?? [], cwd: validation.cwd ?? ".",
    sourceRevisionId: validation.sourceRevisionId ?? null,
    status: validation.status, terminal: validation.terminal,
    category: validation.category ?? null,
    reporting: validation.check ? checkReporting(validation.check, false) : null,
    ...(validation.check?.evidence ? { evidence: validation.check.evidence } : {}),
    admission: validation.status === "passed" && validation.terminal === "passed" ? "admitted" : "unverified",
  }));
  return { sourceRevisionId: state.sourceRevisionId, scope: "current_source_only" as const,
    checks, total: state.validations.length, truncated: state.validations.length > checks.length,
    failed: state.validations.filter((item) => item.status === "failed").length,
    guidance: "Only current-source journal entries are listed; absent entries may have run on an earlier source. This view launches no commands and does not admit validation. Null counters are unreported, never zero. Pending is distinct from skipped; some runners combine skipped/todo. User criteria require a separate assessment.",
  };
}

export type LightValidationReport = ReturnType<typeof currentValidationReport>;
