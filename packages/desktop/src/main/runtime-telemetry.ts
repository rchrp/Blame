import {
  ATTR_BLAME_EXECUTION_STATUS,
  ATTR_BLAME_OPERATION_NAME,
  ATTR_BLAME_RUNTIME_DEPENDENCY_NAME,
  ATTR_BLAME_RUNTIME_DEPENDENCY_STATUS,
  ATTR_BLAME_RUNTIME_INITIAL_STATE,
  ATTR_BLAME_RUNTIME_NAME,
  ATTR_BLAME_RUNTIME_OPERATION,
  ATTR_BLAME_RUNTIME_PHASE,
  ATTR_BLAME_RUNTIME_PROBE_NAME,
  ATTR_BLAME_RUNTIME_READINESS_POLL_COUNT,
  ATTR_BLAME_RUNTIME_REPORT_STAGE,
  ATTR_BLAME_RUNTIME_STATE,
  ATTR_ERROR_TYPE,
  getBlameTelemetry,
  type BlameSpan,
  type Context,
  type StartSpanOptions,
  type TelemetryOutcome,
  type TelemetrySeverity,
} from "@blame/telemetry";

export type RuntimeTelemetryOperationName =
  | "ensure"
  | "repair"
  | "reset"
  | "status"
  | "uninstall";

export type RuntimeTelemetryPhaseName =
  | "lifecycle_command"
  | "readiness_wait"
  | "status_check";

export type RuntimeTelemetryProbeName =
  | "agent"
  | "binary"
  | "compose"
  | "connection"
  | "status";

export type RuntimeTelemetryState =
  | "broken"
  | "missing"
  | "ready"
  | "repairable"
  | "unknown"
  | "unsupported";

export type RuntimeTelemetryIssue = {
  name: string;
  status: string;
};

export type RuntimeTelemetryReport = {
  issues: RuntimeTelemetryIssue[];
  status: RuntimeTelemetryState;
};

export type RuntimeTelemetryOperation = {
  initial(report: RuntimeTelemetryReport): void;
  phase<T>(
    name: RuntimeTelemetryPhaseName,
    action: () => Promise<T>,
    outcome?: (result: T) => TelemetryOutcome,
  ): Promise<T>;
  probe<T>(
    dependency: string,
    name: RuntimeTelemetryProbeName,
    action: () => Promise<T>,
  ): Promise<T>;
  readinessPolls(count: number): void;
};

export type RuntimeTelemetryRecorder = {
  runOperation<T extends RuntimeTelemetryReport>(
    runtime: string,
    operation: RuntimeTelemetryOperationName,
    action: (observation: RuntimeTelemetryOperation) => Promise<T>,
  ): Promise<T>;
};

export type RuntimeTelemetrySpan = Pick<
  BlameSpan,
  "context" | "durationSeconds" | "end" | "recordError" | "setAttributes"
>;

export type RuntimeTelemetryClient = {
  count(
    name: string,
    value: number,
    attributes: Record<string, unknown>,
    activeContext: Context,
  ): void;
  log(
    severity: TelemetrySeverity,
    eventName: string,
    attributes: Record<string, unknown>,
    activeContext: Context,
  ): void;
  record(
    name: string,
    value: number,
    attributes: Record<string, unknown>,
    activeContext: Context,
  ): void;
  startSpan(name: string, options?: StartSpanOptions): RuntimeTelemetrySpan;
  withinSpan<T>(
    span: RuntimeTelemetrySpan,
    action: () => Promise<T>,
  ): Promise<T>;
};

type TimedChildKind = "phase" | "probe";

export class RuntimeTelemetry implements RuntimeTelemetryRecorder {
  private readonly telemetry: RuntimeTelemetryClient;

  constructor(telemetry: RuntimeTelemetryClient) {
    this.telemetry = telemetry;
  }

  runOperation<T extends RuntimeTelemetryReport>(
    runtime: string,
    operation: RuntimeTelemetryOperationName,
    action: (observation: RuntimeTelemetryOperation) => Promise<T>,
  ) {
    const observation = new ActiveRuntimeOperation(
      this.telemetry,
      boundedRuntimeName(runtime),
      operation,
    );
    return observation.run(action);
  }
}

class ActiveRuntimeOperation implements RuntimeTelemetryOperation {
  private initialState: RuntimeTelemetryState | undefined;
  private readonly operation: RuntimeTelemetryOperationName;
  private readinessPollCount: number | undefined;
  private readonly runtime: string;
  private readonly span: RuntimeTelemetrySpan;
  private readonly telemetry: RuntimeTelemetryClient;

  constructor(
    telemetry: RuntimeTelemetryClient,
    runtime: string,
    operation: RuntimeTelemetryOperationName,
  ) {
    this.operation = operation;
    this.runtime = runtime;
    this.telemetry = telemetry;
    this.span = telemetry.startSpan(`blame.runtime.${operation}`, {
      attributes: this.baseAttributes(),
    });
  }

  run<T extends RuntimeTelemetryReport>(
    action: (observation: RuntimeTelemetryOperation) => Promise<T>,
  ) {
    return this.telemetry.withinSpan(this.span, async () => {
      try {
        const report = await action(this);
        this.complete(report);
        return report;
      } catch (error) {
        this.fail(error);
        throw error;
      }
    });
  }

  initial(report: RuntimeTelemetryReport) {
    this.initialState = boundedRuntimeState(report.status);
    this.span.setAttributes({
      [ATTR_BLAME_RUNTIME_INITIAL_STATE]: this.initialState,
    });
    this.recordIssues(report, "initial");
  }

  phase<T>(
    name: RuntimeTelemetryPhaseName,
    action: () => Promise<T>,
    outcome?: (result: T) => TelemetryOutcome,
  ) {
    return this.runTimedChild(
      "phase",
      name,
      { [ATTR_BLAME_RUNTIME_PHASE]: name },
      action,
      outcome,
    );
  }

  probe<T>(
    dependency: string,
    name: RuntimeTelemetryProbeName,
    action: () => Promise<T>,
  ) {
    return this.runTimedChild(
      "probe",
      name,
      {
        [ATTR_BLAME_RUNTIME_DEPENDENCY_NAME]: boundedDependency(dependency),
        [ATTR_BLAME_RUNTIME_PROBE_NAME]: name,
      },
      action,
    );
  }

  readinessPolls(count: number) {
    this.readinessPollCount = Math.max(0, Math.min(10_000, Math.floor(count)));
    this.span.setAttributes({
      [ATTR_BLAME_RUNTIME_READINESS_POLL_COUNT]: this.readinessPollCount,
    });
  }

  private async runTimedChild<T>(
    kind: TimedChildKind,
    name: string,
    attributes: Record<string, unknown>,
    action: () => Promise<T>,
    resolveOutcome: (result: T) => TelemetryOutcome = () => "succeeded",
  ) {
    const span = this.telemetry.startSpan(childSpanName(kind, name), {
      attributes: { ...this.baseAttributes(), ...attributes },
    });
    return this.telemetry.withinSpan(span, async () => {
      try {
        const result = await action();
        this.finishChild(span, kind, attributes, resolveOutcome(result));
        return result;
      } catch (error) {
        span.recordError(error);
        this.finishChild(span, kind, attributes, "failed");
        throw error;
      }
    });
  }

  private finishChild(
    span: RuntimeTelemetrySpan,
    kind: TimedChildKind,
    attributes: Record<string, unknown>,
    outcome: TelemetryOutcome,
  ) {
    const metricAttributes = this.outcomeAttributes(attributes, outcome);
    if (outcome === "failed") span.setAttributes(runtimeErrorAttributes);
    this.telemetry.count(
      `blame.runtime.${kind}.count`,
      1,
      metricAttributes,
      span.context,
    );
    this.telemetry.record(
      `blame.runtime.${kind}.duration`,
      span.durationSeconds(),
      metricAttributes,
      span.context,
    );
    span.end(outcome);
  }

  private complete(report: RuntimeTelemetryReport) {
    const state = boundedRuntimeState(report.status);
    const outcome = runtimeOperationOutcome(
      this.operation,
      this.runtime,
      state,
    );
    const attributes = this.outcomeAttributes(
      { [ATTR_BLAME_RUNTIME_STATE]: state },
      outcome,
    );
    this.span.setAttributes(attributes);
    this.recordOperationMetrics(attributes);
    this.recordReadinessPolls(attributes);
    this.recordFinalIssues(report, outcome);
    this.recordLog(outcome, attributes);
    this.span.end(outcome);
  }

  private recordFinalIssues(
    report: RuntimeTelemetryReport,
    outcome: TelemetryOutcome,
  ) {
    if (this.operation === "uninstall" && outcome === "succeeded") return;
    this.recordIssues(report, "final");
  }

  private fail(error: unknown) {
    this.span.recordError(error);
    const attributes = this.outcomeAttributes(
      { [ATTR_BLAME_RUNTIME_STATE]: "unknown" },
      "failed",
    );
    this.span.setAttributes(attributes);
    this.recordOperationMetrics(attributes);
    this.recordReadinessPolls(attributes);
    this.recordLog("failed", attributes);
    this.span.end("failed");
  }

  private recordOperationMetrics(attributes: Record<string, unknown>) {
    this.telemetry.count(
      "blame.runtime.operation.count",
      1,
      attributes,
      this.span.context,
    );
    this.telemetry.record(
      "blame.runtime.operation.duration",
      this.span.durationSeconds(),
      attributes,
      this.span.context,
    );
  }

  private recordReadinessPolls(attributes: Record<string, unknown>) {
    if (this.readinessPollCount === undefined) return;
    this.telemetry.record(
      "blame.runtime.readiness.polls",
      this.readinessPollCount,
      attributes,
      this.span.context,
    );
  }

  private recordIssues(
    report: RuntimeTelemetryReport,
    stage: "initial" | "final",
  ) {
    for (const issue of report.issues.slice(0, 8)) {
      this.telemetry.count(
        "blame.runtime.dependency.issue.count",
        1,
        issueAttributes(this.baseAttributes(), report.status, issue, stage),
        this.span.context,
      );
    }
  }

  private recordLog(
    outcome: TelemetryOutcome,
    attributes: Record<string, unknown>,
  ) {
    this.telemetry.log(
      outcome === "failed" ? "error" : "info",
      "blame.runtime.operation.completed",
      attributes,
      this.span.context,
    );
  }

  private baseAttributes() {
    return {
      [ATTR_BLAME_OPERATION_NAME]: `blame.runtime.${this.operation}`,
      [ATTR_BLAME_RUNTIME_INITIAL_STATE]: this.initialState,
      [ATTR_BLAME_RUNTIME_NAME]: this.runtime,
      [ATTR_BLAME_RUNTIME_OPERATION]: this.operation,
    };
  }

  private outcomeAttributes(
    attributes: Record<string, unknown>,
    outcome: TelemetryOutcome,
  ) {
    return {
      ...this.baseAttributes(),
      ...attributes,
      [ATTR_BLAME_EXECUTION_STATUS]: outcome,
      ...(outcome === "failed" ? runtimeErrorAttributes : {}),
    };
  }
}

function runtimeOperationOutcome(
  operation: RuntimeTelemetryOperationName,
  runtime: string,
  state: RuntimeTelemetryState,
): TelemetryOutcome {
  if (operation === "status") return "succeeded";
  if (operation === "uninstall") {
    return runtime === "blame-native" || state === "missing"
      ? "succeeded"
      : "failed";
  }
  return state === "ready" ? "succeeded" : "failed";
}

function issueAttributes(
  base: Record<string, unknown>,
  state: RuntimeTelemetryState,
  issue: RuntimeTelemetryIssue,
  stage: "initial" | "final",
) {
  return {
    ...base,
    [ATTR_BLAME_RUNTIME_DEPENDENCY_NAME]: boundedDependency(issue.name),
    [ATTR_BLAME_RUNTIME_DEPENDENCY_STATUS]: boundedDependencyStatus(
      issue.status,
    ),
    [ATTR_BLAME_RUNTIME_REPORT_STAGE]: stage,
    [ATTR_BLAME_RUNTIME_STATE]: boundedRuntimeState(state),
  };
}

function boundedRuntimeName(value: string) {
  return runtimeNames.has(value) ? value : "other";
}

function boundedRuntimeState(value: string): RuntimeTelemetryState {
  return runtimeStates.has(value)
    ? (value as RuntimeTelemetryState)
    : "unknown";
}

function boundedDependency(value: string) {
  return runtimeDependencies.has(value) ? value : "other";
}

function boundedDependencyStatus(value: string) {
  return dependencyStatuses.has(value) ? value : "other";
}

function childSpanName(kind: TimedChildKind, name: string) {
  return kind === "phase"
    ? `blame.runtime.${name}`
    : `blame.runtime.probe.${name}`;
}

function createRuntimeTelemetryClient(): RuntimeTelemetryClient {
  const telemetry = getBlameTelemetry();
  return {
    count: (name, value, attributes, activeContext) =>
      telemetry.count(name, value, attributes, activeContext),
    log: (severity, eventName, attributes, activeContext) =>
      telemetry.log(severity, eventName, attributes, activeContext),
    record: (name, value, attributes, activeContext) =>
      telemetry.record(name, value, attributes, activeContext),
    startSpan: (name, options) => telemetry.startSpan(name, options),
    withinSpan: (span, action) =>
      telemetry.withinSpan(span as BlameSpan, action),
  };
}

const runtimeErrorAttributes = { [ATTR_ERROR_TYPE]: "RuntimeError" };
const runtimeNames = new Set(["blame-lima", "blame-native", "blame-wsl2"]);
const runtimeStates = new Set([
  "broken",
  "missing",
  "ready",
  "repairable",
  "unknown",
  "unsupported",
]);
const runtimeDependencies = new Set([
  "blame-runtime",
  "cline-sdk",
  "docker",
  "docker-compose",
  "git",
]);
const dependencyStatuses = new Set(["missing", "unavailable", "unsupported"]);

export const runtimeTelemetry = new RuntimeTelemetry(
  createRuntimeTelemetryClient(),
);
