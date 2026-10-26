import {
  type AgentSessionTelemetry,
  asRecord,
  metricDimensions,
  numericValue,
  stringValue,
  telemetry,
  toolMetricAttributes,
  type ToolSpanState,
  turnDuration,
} from "./agent-telemetry-state.js";

export function recordHarnessToolMetrics(
  state: AgentSessionTelemetry,
  current: ToolSpanState,
  event: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const attributes = toolMetricAttributes(state, current);
  const output = asRecord(event.output ?? payload.output);
  const body = asRecord(output.data ?? output.output ?? output);
  const data: Record<string, unknown> = {
    ...body,
    ...(body.status === undefined ? { status: output.status } : {}),
    ...(body.category === undefined ? { category: output.category } : {}),
  };
  const metricContext = { attributes, current, data, state };
  if (output.status === "blocked" && output.category === "environment")
    recordHarnessCount(metricContext, "blame.harness.unavailable_capabilities");
  current.span.setAttributes(harnessTraceAttributes(data));
  if (navigationReadTool(current.name)) recordReadMetrics(metricContext);
  if (semanticEditTool(current.name)) recordEditMetrics(metricContext);
  if (externalReadTool(current.name)) recordExternalReadMetrics(metricContext);
  if (current.name === "consult_specialist")
    recordHarnessValue(
      metricContext,
      "blame.harness.specialist_duration",
      current.span.durationSeconds(),
    );
  if (
    current.name === "consult_specialist" &&
    stringValue(data.reason) === "SPECIALIST_TIMEOUT"
  ) {
    recordHarnessCount(metricContext, "blame.harness.specialist_timeouts");
    current.span.addEvent("blame.harness.alert", {
      alert: "SPECIALIST_TIMEOUT",
    });
  }
  if (current.name === "run_task") recordRunMetrics(metricContext);
}

function recordExternalReadMetrics(context: HarnessMetricContext) {
  recordHarnessCount(context, "blame.harness.external_reads");
  const governor = asRecord(context.data.governor);
  const status = stringValue(context.data.status);
  if (status === "already_available")
    recordHarnessCount(context, "blame.harness.external_read_cache_hits");
  if (status === "already_available" || status === "retry_suppressed")
    recordHarnessCount(context, "blame.harness.external_read_suppressed");
  const returned = numericValue(governor.external_read_returned_bytes);
  if (returned !== undefined)
    recordHarnessValue(
      context,
      "blame.harness.external_read_returned_bytes",
      returned,
    );
}

type HarnessMetricContext = {
  attributes: Record<string, unknown>;
  current: ToolSpanState;
  data: Record<string, unknown>;
  state: AgentSessionTelemetry;
};

function recordReadMetrics(context: HarnessMetricContext) {
  recordHarnessCount(context, "blame.harness.reads");
  const readBytes = readContentBytes(context.data);
  recordHarnessValue(context, "blame.harness.read_requested_bytes", readBytes);
  if (readBytes > 0)
    recordHarnessValue(context, "blame.harness.read_bytes", readBytes);
  recordHarnessValue(context, "blame.harness.new_read_bytes", readBytes);
  const returnedBytes =
    stringValue(context.data.status) === "already_in_context" ? 0 : readBytes;
  recordHarnessValue(
    context,
    "blame.harness.read_returned_bytes",
    returnedBytes,
  );
  if (readBytes > 0)
    recordHarnessValue(
      context,
      "blame.harness.read_return_ratio",
      returnedBytes / readBytes,
    );
  recordHarnessValue(
    context,
    "blame.harness.read_suppressed_bytes",
    Math.max(0, readBytes - returnedBytes),
  );
  if (stringValue(context.data.status) === "already_in_context")
    recordHarnessCount(context, "blame.harness.deduplicated_reads");
  if (stringValue(context.data.status) === "already_in_context")
    recordHarnessCount(context, "blame.harness.duplicate_read_count");
  recordHarnessValue(
    context,
    "blame.harness.symbol_target_ratio",
    stringValue(context.data.view) === "symbol" ? 1 : 0,
  );
}

function readContentBytes(data: Record<string, unknown>) {
  return [data.content, data.body, data.signature, data.imports]
    .filter((value): value is string => typeof value === "string")
    .reduce((total, value) => total + Buffer.byteLength(value), 0);
}

function recordEditMetrics(context: HarnessMetricContext) {
  const status = stringValue(context.data.status);
  if (context.data.changed === true) {
    recordFirstEdit(context);
    recordHarnessCount(context, "blame.harness.direct_edits");
  }
  if (status === "blocked" && context.data.category === "input")
    recordHarnessCount(context, "blame.harness.edit_conflict_count");
}

function harnessTraceAttributes(data: Record<string, unknown>) {
  return compactAttributes({
    harness_category: stringValue(data.category),
    harness_status: stringValue(data.status),
    harness_view: stringValue(data.view),
  });
}

function semanticEditTool(name: string) {
  return name === "edit_code";
}

function navigationReadTool(name: string) {
  return name === "read_code" || name === "search_code";
}

function externalReadTool(name: string) {
  return [
    "consult_specialist",
    "fetch_web_content",
    "search_web",
    "read_web_page",
    "get_preview_container_logs",
    "get_preview_devtools",
  ].includes(name);
}

function compactAttributes(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function recordFirstEdit(context: HarnessMetricContext) {
  const state = context.state;
  if (state.firstEditRecorded || !state.component) return;
  state.firstEditRecorded = true;
  telemetry.record(
    "blame.harness.time_to_first_edit",
    turnDuration(state),
    metricDimensions(state),
    state.component.span.context,
  );
  recordHarnessValue(
    context,
    "blame.harness.first_edit_iteration",
    context.current.iteration,
  );
  recordHarnessValue(
    context,
    "blame.harness.tokens_before_first_edit",
    state.usage.input + state.usage.output,
  );
  if (state.usage.input + state.usage.output > 250_000)
    context.current.span.addEvent("blame.harness.alert", {
      alert: "TOKENS_BEFORE_FIRST_MUTATION_EXCEEDED",
      tokens: state.usage.input + state.usage.output,
    });
}

function recordRunMetrics(context: HarnessMetricContext) {
  recordHarnessValue(
    context,
    "blame.harness.run_task_duration",
    context.current.span.durationSeconds(),
  );
  recordHarnessValue(
    context,
    "blame.harness.time_to_verifiable_result",
    turnDuration(context.state),
  );
  if (!context.data.run_ref || !context.data.complete_log)
    recordHarnessCount(context, "blame.harness.missing_run_artifacts");
  const execution = asRecord(context.data.execution);
  const resolution = asRecord(execution.package_manager_resolution);
  if (stringValue(resolution.strategy) === "compatible_same_major")
    recordHarnessCount(
      context,
      "blame.harness.package_manager_compatible_resolutions",
    );
}

function recordHarnessCount(
  context: HarnessMetricContext,
  name: string,
  value = 1,
) {
  telemetry.count(
    name as Parameters<typeof telemetry.count>[0],
    value,
    context.attributes,
    context.current.span.context,
  );
}

function recordHarnessValue(
  context: HarnessMetricContext,
  name: string,
  value: number,
) {
  telemetry.record(
    name as Parameters<typeof telemetry.record>[0],
    value,
    context.attributes,
    context.current.span.context,
  );
}
