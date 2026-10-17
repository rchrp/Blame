import type { WorkspaceCommandResult } from "./workspace-command-process.js";
import {
  parseTestReport,
  parseTestReports,
  type TestReport,
} from "./test-report.js";
import { nodeEventEvidence, type NodeEventBinding } from "./node-event-evidence.js";
import { testTypeEvidence, type TestTypeEvidence } from "./test-type-evidence.js";

export type CheckObservation = {
  process: "running" | "exited" | "timed_out" | "cancelled";
  exitCode?: number;
  execution: "observed" | "zero_tests" | "not_observed";
  outcome: "passed" | "failed" | "unknown";
  counts?: {
    executed: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  /** Partial runner fields; missing categories remain null and grant no admission. */
  reportedCounts?: { passed: number | null; failed: number | null; pending: number | null; skipped: number | null };
  scope: string;
  selection: "confirmed" | "unknown";
  freshness: "current" | "stale" | "unknown";
  evidenceOrigin: "report" | "runner_output" | "node_events" | "none";
  /** Runner discovery failed; never a passing test or admitted selection. */
  selectionFailure?: "no_test_files";
  /** Typechecking diagnostics remain separate from runner case counts and admission. */
  typechecking?: TestTypeEvidence;
  evidence?: Record<string, unknown>;
  note?: string;
  diagnostics?: TestReport["failures"];
};

export function isTestInvocation(command: string) {
  return isMochaInvocation(command) || /(?:^|\s)(?:pytest|py\.test|vitest|jest)(?:\s|$)|\b(?:dotnet|mvn|mvnw|gradle|gradlew)\s+[^;&|]*\btest\b|\bnode\s+[^;&|]*--test\b/u.test(
    command,
  );
}

/** Only parse final summaries emitted by this invocation. Never discover old reports. */
export function observeCheck(
  command: string,
  result: WorkspaceCommandResult,
  scope: string,
  sourceChanged: boolean,
  attributedReport?: string | string[],
  nodeEvents?: NodeEventBinding,
): CheckObservation {
  // ANSI SGR emitted by runners is presentation, not diagnostic content.
  // eslint-disable-next-line no-control-regex
  const output = result.all.replace(/\x1b\[[0-9;]*m/gu, "");
  const report =
    (Array.isArray(attributedReport)
      ? parseTestReports(attributedReport)
      : attributedReport
        ? parseTestReport(attributedReport)
        : undefined) ??
    parseTestReport(output);
  // Node can count a successful empty file worker as a test, including a
  // name filter matching no cases. Text reporters cannot distinguish that
  // wrapper from a user case named like a source path. Withhold the aggregate.
  const ambiguousNode = /\bnode\b[^;&|]*--test\b/u.test(command) &&
    output.split(/\r?\n/u).some(nodeFileWorkerLabel);
  const structured = nodeEvents ? nodeEventEvidence(nodeEvents) : undefined;
  const counts = nodeEvents ? structured?.counts
    : ambiguousNode ? undefined : report?.counts ?? runnerCounts(command, output);
  const reportedCounts = isMochaInvocation(command) ? mochaReportedCounts(output).reportedCounts : undefined;
  const interrupted = Boolean(result.interruption);
  const typechecking = testTypeEvidence(command, output, interrupted);
  const noTestFiles = !interrupted && result.exitCode === 1 && !report && !counts && !reportedCounts &&
    vitestNoTestFiles(command, output);
  const execution = counts
    ? counts.executed > 0
      ? "observed"
      : "zero_tests"
    : "not_observed";
  const failed =
    result.failed || structured?.failed || report?.setupFailed || (counts?.failed ?? 0) > 0 || (reportedCounts?.failed ?? 0) > 0;
  return {
    process:
      result.interruption === "cancelled"
        ? "cancelled"
        : result.interruption === "timed_out"
          ? "timed_out"
          : "exited",
    exitCode: result.exitCode,
    execution,
    outcome: interrupted
      ? "unknown"
      : failed
        ? "failed"
        : execution === "observed" && result.exitCode === 0
          ? "passed"
          : "unknown",
    ...(counts ? { counts } : {}),
    ...(reportedCounts ? { reportedCounts } : {}),
    scope,
    selection: "unknown",
    // A host process can have unobserved external writers; pre/post equality is insufficient.
    freshness: sourceChanged ? "stale" : "unknown",
    evidenceOrigin: structured ? "node_events" : report ? "report" : counts || reportedCounts ? "runner_output" : "none",
    ...(noTestFiles ? { selectionFailure: "no_test_files" as const } : {}),
    ...(typechecking ? { typechecking } : {}),
    ...(structured ? { evidence: structured.evidence } : {}),
    ...(nodeEvents && !structured ? { note: "Invocation-owned Node events are incomplete or unsupported; executed case count remains unconfirmed." }
      : ambiguousNode && !structured ? { note: "Node text summaries can count empty file workers. Source-path labels leave the executed case count unconfirmed." } : {}),
    ...(report?.failures.length ? { diagnostics: report.failures } : {}),
  };
}

function vitestNoTestFiles(command: string, output: string) {
  // A bounded runner diagnostic, not a coverage adapter. Contradictory summaries
  // or compiler/setup failures must keep their ordinary failure classification.
  const parts = command.trim().split(/\s+&&\s+/u);
  if (parts.length > 2 || (parts.length === 2 &&
    !/^tsc(?:\s+[\w./:=@+-]+)*$/u.test(parts[0]!))) return false;
  return /^(?:vitest|node\s+(?:[\w./-]+\/)?vitest\.[cm]?js)(?:\s+[\w./:=@+-]+)*$/u.test(parts.at(-1)!) &&
    [...output.matchAll(/^\s*RUN\s+v[1-3]\.\d+\.\d+[^\r\n]*$/gmu)].length === 1 &&
    [...output.matchAll(/^No test files found, exiting with code 1\s*$/gmu)].length === 1 &&
    !/^\s*(?:FAIL\b|Tests\s|Test Files\s|Unhandled\b|(?:Assertion|Syntax|Type)?Error\b|Type Errors\s)|\berror TS\d+:/mu.test(output);
}

function isMochaInvocation(command: string) {
  return /(?:^|[\s/\\])mocha(?:\.[cm]?js)?(?=\s|$)/u.test(command);
}

function mochaReportedCounts(output: string) {
  const fields = ["passing", "failing", "pending", "skipped"] as const;
  const counts = fields.map((field) => [...output.matchAll(new RegExp(`^\\s*(\\d+) ${field}(?: \\([^\\r\\n]*\\))?\\s*$`, "gmu"))]);
  if (!counts.some((hits) => hits.length) || counts.some((hits) => hits.length > 1)) return {};
  const [passed, failed, pending, skipped] = counts.map((hits) => hits.length ? Number(hits[0]![1]) : null);
  if ([passed, failed, pending, skipped].some((count) => count !== null && !Number.isSafeInteger(count))) return {};
  return { reportedCounts: { passed: passed!, failed: failed!, pending: pending!, skipped: skipped! } };
}

function runnerCounts(
  command: string,
  output: string,
): CheckObservation["counts"] {
  if (/\bnode\b[^;&|]*--test\b/u.test(command)) {
    const field = (name: string) => {
      const hits = [
        ...output.matchAll(new RegExp(`^(?:#|ℹ) ${name} (\\d+)\\s*$`, "gmu")),
      ];
      return hits.length === 1 ? Number(hits[0]![1]) : undefined;
    };
    const total = field("tests"),
      passed = field("pass"),
      failed = field("fail");
    const skipped = field("skipped"),
      cancelled = field("cancelled"),
      todo = field("todo");
    if (
      total !== undefined &&
      passed !== undefined &&
      failed !== undefined &&
      skipped !== undefined &&
      cancelled === 0 &&
      todo !== undefined &&
      total === passed + failed + skipped + todo
    )
      return {
        executed: passed + failed,
        passed,
        failed,
        skipped: skipped + todo,
      };
  }
  if (/\bpytest\b|\bpy\.test\b/u.test(command)) {
    const summaries = [
      ...output.matchAll(/^=+ ([^\n]+) in [\d.]+s[^\n]*=+\s*$/gmu),
    ];
    if (summaries.length !== 1) return undefined;
    const summary = summaries[0]![1]!;
    if (/\berrors?\b/u.test(summary)) return undefined;
    const count = (label: string) =>
      Number(new RegExp(`(\\d+) ${label}\\b`, "u").exec(summary)?.[1] ?? 0);
    if (
      !/\d+ (?:passed|failed|skipped|deselected|xfailed|xpassed)/u.test(summary)
    )
      return undefined;
    const passed = count("passed"),
      failed = count("failed");
    return {
      executed: passed + failed,
      passed,
      failed,
      skipped: count("skipped") + count("xfailed") + count("xpassed"),
    };
  }
  if (/\b(?:vitest|jest)\b/u.test(command)) {
    const summaries = [...output.matchAll(/^\s*Tests\s*:?\s+([^\n]+)$/gmu)];
    if (summaries.length !== 1 || !/\(\d+\)|\d+ total/u.test(summaries[0]![1]!))
      return undefined;
    const summary = summaries[0]![1]!;
    const count = (label: string) =>
      Number(new RegExp(`(\\d+) ${label}\\b`, "u").exec(summary)?.[1] ?? 0);
    const passed = count("passed"),
      failed = count("failed"),
      skipped = count("skipped") + count("todo");
    const total = Number(
      /\((\d+)\)|(\d+) total/u.exec(summary)?.slice(1).find(Boolean),
    );
    if (total === passed + failed + skipped)
      return { executed: passed + failed, passed, failed, skipped };
  }
  return undefined;
}

function nodeFileWorkerLabel(line: string) {
  const label = /^\s*[✔✖]\s+(.+?)\s+\([\d.]+(?:ms|s)\)(?:\s.*)?$/u.exec(line)?.[1] ??
    /^\s*(?:not )?ok \d+ - (.+?)(?:\s+#\s.*)?$/u.exec(line)?.[1];
  return Boolean(label && /\.[cm]?[jt]sx?$/u.test(label.trim()));
}
