export type BaselineManifest = {
  schema_version: "1";
  corpus_version: string;
  tasks: Array<{
    task_id: string;
    category: string;
    difficulty: string;
    language: string;
  }>;
  repository_commits: Record<string, string>;
  model: string;
  reasoning_effort: string;
  parameters: Record<string, unknown>;
  budgets: { tokens: number; duration_ms: number; iterations: number };
  versions: {
    // The Cline SDK version the archived baselines were measured with (their
    // schema; the engine records its own in `runtime`).
    cline: string;
    runtime: string;
    adapters: Record<string, string>;
  };
  environment: { platform: string; runtime: string };
  repetitions: number;
  seeds: number[];
  thresholds: ReleaseThresholds;
  raw_metrics_ref: string;
  calculation_method: string;
};

export type ReleaseThresholds = {
  minimum_tasks: number;
  minimum_live_repetitions: number;
  resolution_delta_lower_bound_points: number;
  solved_task_cost_upper_bound_ratio: number;
  first_correct_mutation_p95_upper_bound_ratio: number;
  duplicate_io_upper_bound_ratio: number;
};

export type AbsoluteGateCounters = {
  false_successes: number;
  writes_outside_worktree: number;
  incorrect_automatic_rebases: number;
  stale_evidence_as_fresh: number;
  business_events_after_terminal: number;
  atomic_groups_without_recovery: number;
  infrastructure_as_code_failure: number;
};

export type StatisticalComparison = {
  task_count: number;
  live_repetitions: number;
  resolution_delta_lower_bound_points: number;
  solved_task_cost_upper_bound_ratio: number;
  first_correct_mutation_p95_upper_bound_ratio: number;
  duplicate_io_ratio: number;
};

export type ReleaseGateDecision = {
  passed: boolean;
  failed_gates: string[];
};

export function initialReleaseThresholds(): ReleaseThresholds {
  return {
    minimum_tasks: 100,
    minimum_live_repetitions: 3,
    resolution_delta_lower_bound_points: -2,
    solved_task_cost_upper_bound_ratio: 1.05,
    first_correct_mutation_p95_upper_bound_ratio: 1.1,
    duplicate_io_upper_bound_ratio: 0.01,
  };
}

export function evaluateReleaseGates(
  manifest: BaselineManifest,
  absolute: AbsoluteGateCounters,
  statistical: StatisticalComparison,
): ReleaseGateDecision {
  const absoluteFailures = Object.entries(absolute)
    .filter(([, count]) => count !== 0)
    .map(([name]) => name);
  const statisticalFailures = failedStatisticalGates(
    statistical,
    manifest.thresholds,
  );
  const failedGates = [...absoluteFailures, ...statisticalFailures];
  return { passed: failedGates.length === 0, failed_gates: failedGates };
}

function failedStatisticalGates(
  value: StatisticalComparison,
  thresholds: ReleaseThresholds,
) {
  return [
    value.task_count < thresholds.minimum_tasks ? "minimum_tasks" : undefined,
    value.live_repetitions < thresholds.minimum_live_repetitions
      ? "minimum_live_repetitions"
      : undefined,
    value.resolution_delta_lower_bound_points <=
    thresholds.resolution_delta_lower_bound_points
      ? "resolution_delta"
      : undefined,
    value.solved_task_cost_upper_bound_ratio >
    thresholds.solved_task_cost_upper_bound_ratio
      ? "solved_task_cost"
      : undefined,
    value.first_correct_mutation_p95_upper_bound_ratio >
    thresholds.first_correct_mutation_p95_upper_bound_ratio
      ? "first_correct_mutation_p95"
      : undefined,
    value.duplicate_io_ratio >= thresholds.duplicate_io_upper_bound_ratio
      ? "duplicate_io"
      : undefined,
  ].filter((value): value is string => Boolean(value));
}
