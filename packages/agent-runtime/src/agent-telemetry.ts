import { auditSdkUsage } from "./usage-audit.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CoreSessionEvent } from "@cline/sdk";
import {
  ATTR_BLAME_AGENT_ID,
  ATTR_BLAME_AGENT_ITERATION,
  ATTR_BLAME_AGENT_PARENT_ID,
  ATTR_BLAME_AGENT_ROLE,
  ATTR_BLAME_AGENT_STRATEGY,
  ATTR_BLAME_SHELL_CATEGORY,
  ATTR_BLAME_EXECUTION_ID,
  ATTR_BLAME_EXECUTION_KIND,
  ATTR_BLAME_INTERVENTION_TYPE,
  ATTR_BLAME_MULTI_AGENT_ENABLED,
  ATTR_BLAME_MULTI_AGENT_USED,
  ATTR_BLAME_OPERATION_NAME,
  ATTR_BLAME_OPERATION_STATUS,
  ATTR_BLAME_PROVIDER_AUTH_TYPE,
  ATTR_BLAME_STORY_ID,
  ATTR_BLAME_TOOL_CATEGORY,
  ATTR_BLAME_TOOL_NAME,
  ATTR_BLAME_TEST_STATUS,
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
  METRIC_GEN_AI_OPERATION_DURATION,
  METRIC_GEN_AI_TIME_TO_FIRST_CHUNK,
  METRIC_GEN_AI_TOKEN_USAGE,
  SpanKind,
  boundedMetricDimensionName,
  getExecutionRegistry,
  semanticGenAiProviderName,
  type BlameSpan,
  type Context,
  type ExecutionComponent,
  type ExecutionDescriptor,
} from "@blame/telemetry";
import type { AgentEvent, AgentUsageSummary } from "./types.js";
import {
  type AgentSessionTelemetry,
  type AgentTelemetryInput,
  asRecord,
  cohortAttributes,
  configuredAgentStrategy,
  metricDimensions,
  modelAttributes,
  type ModelSpanState,
  multiAgentEnabled,
  numericValue,
  stringValue,
  telemetry,
  toolMetricAttributes,
  type ToolSpanState,
  turnDuration,
  type UsageSnapshot,
} from "./agent-telemetry-state.js";
import { recordHarnessToolMetrics } from "./agent-telemetry-harness.js";
import {
  addUsage,
  emptyUsage,
  missingUsage,
  recordCost,
  recordModelUsage,
  recordTokenUsage,
  usageAttributes,
  usageDelta,
  usageSnapshot,
} from "./agent-telemetry-usage.js";

type CoreEventDetails = {
  agentKey: string;
  event: Record<string, unknown>;
  iteration?: number;
  payload: Record<string, unknown>;
  parentAgentKey: string;
  role: string;
};
const executions = getExecutionRegistry();
const businessExecutionScope = new AsyncLocalStorage<BusinessExecutionScope>();
const toolCallFinishPayload = { finishReason: "tool-calls" };

export class AgentTelemetry {
  private readonly sessions = new Map<string, AgentSessionTelemetry>();

  start(sessionId: string, input: AgentTelemetryInput) {
    const normalizedInput = normalizeTelemetryInput(input);
    const descriptor = executionDescriptor(sessionId, normalizedInput);
    const state = createSessionState(normalizedInput, descriptor);
    state.component = this.beginComponent(state);
    this.sessions.set(sessionId, state);
    telemetry.log(
      "info",
      "blame.agent.started",
      traceAttributes(state),
      state.component.span.context,
    );
  }

  setAuthentication(sessionId: string, authType: string | undefined) {
    const state = this.sessions.get(sessionId);
    const normalizedAuthType = providerAuthType(authType);
    if (!state || !normalizedAuthType) return;
    state.authType = normalizedAuthType;
    setDescriptorAttributes(state, {
      [ATTR_BLAME_PROVIDER_AUTH_TYPE]: normalizedAuthType,
    });
    executions.setAttributes(state.descriptor.executionId, {
      [ATTR_BLAME_PROVIDER_AUTH_TYPE]: normalizedAuthType,
    });
    if (!state.component) return;
    state.component.span.setAttributes({
      [ATTR_BLAME_PROVIDER_AUTH_TYPE]: normalizedAuthType,
    });
  }

  beginTurn(
    sessionId: string,
    executionId?: string,
    storyId?: string,
    complexityBucket?: string,
  ) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.component) this.finish(sessionId, "succeeded");
    state.input.taskComplexityBucket =
      boundedComplexityBucket(complexityBucket);
    state.descriptor = nextExecutionDescriptor(
      state.descriptor,
      executionId,
      storyId,
    );
    state.descriptor.attributes = {
      ...executionMetricAttributes(state.input),
      [ATTR_BLAME_PROVIDER_AUTH_TYPE]: state.authType,
    };
    resetTurn(state);
    state.component = this.beginComponent(state);
  }

  startModelRequest(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return;
    this.startModelSpan(state, leadDetails());
  }

  setRepositoryCohorts(
    sessionId: string,
    languages: string[] | undefined,
    fileCount: number | undefined,
  ) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    applyRepositoryCohorts(state.input, languages, fileCount);
    const attributes = cohortAttributes(state.input);
    setDescriptorAttributes(state, attributes);
    executions.setAttributes(state.descriptor.executionId, attributes);
    state.component?.span.setAttributes(attributes);
    setActiveSpanAttributes(state, attributes);
  }

  withinSession<T>(sessionId: string, operation: () => Promise<T>) {
    const state = this.sessions.get(sessionId);
    const activeSpan =
      state?.modelSpans.get("lead")?.span ?? state?.component?.span;
    return activeSpan
      ? telemetry.withinSpan(activeSpan, operation)
      : operation();
  }

  context(sessionId: string) {
    const state = this.sessions.get(sessionId);
    return (
      state?.modelSpans.get("lead")?.span.context ??
      state?.component?.span.context
    );
  }

  ready(sessionId: string, promptDeferred: boolean) {
    if (!promptDeferred) return;
    this.finish(sessionId, "succeeded");
  }

  restore(sourceSessionId: string, restoredSessionId: string) {
    const source = this.sessions.get(sourceSessionId);
    if (!source) return;
    this.finish(sourceSessionId, "succeeded");
    this.start(restoredSessionId, {
      ...source.input,
      executionId: source.descriptor.executionId,
      storyId: source.descriptor.storyId,
    });
    if (source.authType) {
      this.setAuthentication(restoredSessionId, source.authType);
    }
  }

  observeCoreEvent(sessionId: string, coreEvent: CoreSessionEvent) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return;
    const details = coreEventDetails(coreEvent);
    if (details.role === "teammate") this.markMultiAgent(state);
    this.updateIteration(state, details.agentKey, details.iteration);
    if (details.role === "teammate") this.startAgentSpan(state, details);
    this.observeCoreDetails(state, coreEvent.type, details);
  }

  observeEvent(sessionId: string, event: AgentEvent) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return;
    if (event.type === "text" || event.type === "reasoning") {
      this.startModelSpan(state, leadDetails());
      this.recordFirstAction(state);
      this.recordModelFirstChunk(state, "lead");
    }
    if (event.type === "error") this.fail(sessionId, event.payload);
    if (event.type === "done") this.finishFromPayload(sessionId, event.payload);
  }

  recordUsageSummary(sessionId: string, summary: AgentUsageSummary) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return;
    this.recordAggregateUsage(state, summary);
  }

  recordPostStopEvent(sessionId: string, tokens: number) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const attributes = metricDimensions(state);
    telemetry.count(
      "blame.harness.post_stop_events" as never,
      1,
      attributes,
      state.component?.span.context,
    );
    if (tokens > 0)
      telemetry.record(
        "blame.harness.post_stop_tokens" as never,
        tokens,
        attributes,
        state.component?.span.context,
      );
  }

  recordPostTerminalEvent(sessionId: string, tokens: number) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const attributes = metricDimensions(state);
    telemetry.count(
      "blame.harness.post_terminal_events" as never,
      1,
      attributes,
      state.component?.span.context,
    );
    if (tokens > 0)
      telemetry.record(
        "blame.harness.post_terminal_tokens" as never,
        tokens,
        attributes,
        state.component?.span.context,
      );
    telemetry.log(
      "error",
      "blame.harness.post_terminal_event",
      { ...attributes, tokens },
      state.component?.span.context,
    );
  }

  completeModelRequest(sessionId: string, payload?: unknown) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return undefined;
    this.finishModelSpans(state, finishStatus(asRecord(payload)), payload);
    return state.component.span.context;
  }

  humanIntervention(sessionId: string, kind: string) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return;
    const intervention = boundedInterventionType(kind);
    const attributes = {
      ...metricDimensions(state),
      [ATTR_BLAME_INTERVENTION_TYPE]: intervention,
    };
    telemetry.count(
      "blame.agent.human_intervention.count",
      1,
      attributes,
      state.component.span.context,
    );
    state.component.span.addEvent("blame.agent.human_intervention", {
      [ATTR_BLAME_INTERVENTION_TYPE]: intervention,
    });
  }

  recordQuality(
    sessionId: string,
    quality: { filesModified: number; testsAdded: number },
  ) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return;
    const attributes = metricDimensions(state);
    telemetry.record(
      "blame.agent.files_modified",
      quality.filesModified,
      attributes,
      state.component.span.context,
    );
    telemetry.record(
      "blame.agent.tests_added",
      quality.testsAdded,
      attributes,
      state.component.span.context,
    );
  }

  recordRevertedChange(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return;
    telemetry.count(
      "blame.agent.reverted_change.count",
      1,
      metricDimensions(state),
      state.component.span.context,
    );
  }

  cancel(sessionId: string) {
    this.finish(sessionId, "canceled");
  }

  fail(sessionId: string, error: unknown) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return;
    this.finishActiveSpans(state, "failed", error);
    countProviderError(
      metricDimensions(state),
      state.component.span.context,
      error,
    );
    this.recordCompletionMetrics(state, "failed", error);
    telemetry.log(
      "error",
      "blame.agent.failed",
      { ...traceAttributes(state), ...errorRecord(error) },
      state.component.span.context,
    );
    state.component.fail(error);
    state.component = undefined;
  }

  remove(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.component) this.finish(sessionId, "canceled");
    this.sessions.delete(sessionId);
  }

  shutdown() {
    for (const sessionId of this.sessions.keys()) this.cancel(sessionId);
    this.sessions.clear();
  }

  async runOperation<T>(
    input: AgentTelemetryInput,
    operationName: string,
    operation: () => Promise<T>,
    authType?: string,
  ) {
    const operationState = beginDetachedOperation(
      normalizeTelemetryInput(input),
      operationName,
      authType,
    );
    const { attributes, component, modelSpan } = operationState;
    try {
      const result = await telemetry.withinSpan(modelSpan, operation);
      finishDetachedOperation(component, modelSpan, attributes, result);
      return result;
    } catch (error) {
      failDetachedOperation(component, modelSpan, attributes, error);
      throw error;
    }
  }

  async runBusinessOperation<T>(
    input: AgentTelemetryInput,
    operationName: string,
    operation: () => Promise<T>,
  ) {
    const current = beginBusinessOperation(
      normalizeTelemetryInput(input),
      operationName,
    );
    try {
      const result = await runWithinBusinessScope(current, operation);
      finishBusinessOperation(current, "succeeded");
      return result;
    } catch (error) {
      finishBusinessOperation(current, "failed", error);
      throw error;
    }
  }

  async runCheckpointRestore<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ) {
    const state = this.sessions.get(sessionId);
    if (!state) return operation();
    const current = beginCheckpointOperation(state);
    try {
      const result = await telemetry.withinSpan(
        current.component.span,
        operation,
      );
      if (state.component)
        telemetry.count(
          "blame.harness.checkpoint_restorations" as never,
          1,
          metricDimensions(state),
          state.component.span.context,
        );
      finishBusinessOperation(current, "succeeded");
      return result;
    } catch (error) {
      finishBusinessOperation(current, "failed", error);
      throw error;
    }
  }

  recordOperationRetry(
    input: AgentTelemetryInput,
    operationName: string,
    error?: unknown,
  ) {
    const normalizedInput = normalizeTelemetryInput(input);
    telemetry.count("blame.agent.retry.count", 1, {
      ...detachedOperationAttributes(normalizedInput, operationName),
      [ATTR_ERROR_TYPE]: error ? "ModelError" : "AgentError",
    });
  }

  private beginComponent(state: AgentSessionTelemetry) {
    return executions.beginComponent(
      state.descriptor,
      "invoke_agent",
      {
        ...traceAttributes(state),
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
      },
      businessScopeParent(state.descriptor.executionId),
    );
  }

  private observeCoreDetails(
    state: AgentSessionTelemetry,
    coreType: string,
    details: CoreEventDetails,
  ) {
    if (isUsageEvent(details.event)) {
      this.recordUsage(state, details.event, details.agentKey);
    }
    if (isRetryEvent(details.event)) this.recordRetry(state, details);
    if (details.event.type === "iteration_start")
      telemetry.count(
        "blame.harness.model_turns",
        1,
        metricDimensions(state),
        state.component?.span.context,
      );
    if (details.event.type === "iteration_start")
      this.startModelSpan(state, details);
    const tool = toolDetails(coreType, details);
    if (tool?.name === "spawn_agent") this.markMultiAgent(state);
    if (tool?.phase === "started") this.startTool(state, details, tool);
    if (tool?.phase === "finished") this.finishTool(state, details, tool);
    if (isContentEvent(details.event)) this.observeContent(state, details);
    if (coreType === "chunk") this.observeChunk(state, details);
  }

  private observeContent(
    state: AgentSessionTelemetry,
    details: CoreEventDetails,
  ) {
    const contentType = stringValue(details.event.contentType);
    if (contentType !== "text" && contentType !== "reasoning") return;
    this.startModelSpan(state, details);
    this.recordFirstAction(state);
    this.recordModelFirstChunk(state, details.agentKey);
  }

  private observeChunk(
    state: AgentSessionTelemetry,
    details: CoreEventDetails,
  ) {
    if (details.payload.stream !== "agent") return;
    this.startModelSpan(state, details);
    this.recordFirstAction(state);
    this.recordModelFirstChunk(state, details.agentKey);
  }

  private startAgentSpan(
    state: AgentSessionTelemetry,
    details: CoreEventDetails,
  ) {
    if (state.agentSpans.has(details.agentKey) || !state.component) return;
    const parentTool = availableSpawnTool(state, details.parentAgentKey);
    const parent = parentTool?.span.context ?? state.component.span.context;
    const span = telemetry.startSpan(GEN_AI_OPERATION_INVOKE_AGENT, {
      attributes: agentSpanAttributes(state, details),
      parent,
    });
    state.agentSpans.set(details.agentKey, {
      parentAgentKey: details.parentAgentKey,
      parentTool: parentTool?.span,
      span,
    });
  }

  private startModelSpan(
    state: AgentSessionTelemetry,
    details: CoreEventDetails,
  ) {
    if (state.modelSpans.has(details.agentKey) || !state.component) return;
    const attributes = modelSpanAttributes(state, details);
    const span = telemetry.startSpan(
      `${GEN_AI_OPERATION_CHAT} ${state.input.modelId}`,
      {
        attributes,
        kind: SpanKind.CLIENT,
        parent:
          state.agentSpans.get(details.agentKey)?.span.context ??
          state.component.span.context,
      },
    );
    state.modelSpans.set(details.agentKey, {
      firstChunkRecorded: false,
      iteration: agentIteration(state, details),
      role: details.role,
      span,
      usage: emptyUsage(),
    });
  }

  private finishModelSpan(
    state: AgentSessionTelemetry,
    agentKey: string,
    payload?: Record<string, unknown>,
    outcome: "succeeded" | "failed" | "canceled" = "succeeded",
  ) {
    const current = state.modelSpans.get(agentKey);
    if (!current) return;
    state.modelSpans.delete(agentKey);
    completeModelSpan(state, current, payload, outcome);
  }

  private startTool(
    state: AgentSessionTelemetry,
    details: CoreEventDetails,
    tool: ToolDetails,
  ) {
    if (!state.component) return;
    this.finishModelSpan(state, details.agentKey, toolCallFinishPayload);
    const key = toolKey(details.agentKey, tool);
    if (state.toolSpans.has(key)) return;
    const category = toolCategory(tool.name, tool.input);
    const toolName = boundedToolName(tool.name);
    const attributes = toolAttributes(
      state,
      details,
      { ...tool, name: toolName },
      category,
    );
    const span = trackToolSpan(
      state,
      state.component,
      details,
      key,
      toolName,
      category,
      attributes,
    );
    this.recordToolStart(state);
    telemetry.count("blame.tool.call.count", 1, attributes, span.context);
  }

  private recordToolStart(state: AgentSessionTelemetry) {
    state.toolCallCount += 1;
    this.recordFirstAction(state);
  }

  private finishTool(
    state: AgentSessionTelemetry,
    details: CoreEventDetails,
    tool: ToolDetails,
  ) {
    const key = toolKey(details.agentKey, tool);
    const current = state.toolSpans.get(key);
    if (!current) return;
    const outcome = toolFailed(details.event) ? "failed" : "succeeded";
    if (current.name === "spawn_agent") {
      this.finishAgentsForTool(state, current.span, outcome);
    }
    recordHarnessToolMetrics(state, current, details.event, details.payload);
    state.toolSpans.delete(key);
    completeToolSpan(state, current, outcome);
  }

  private finishAgentsForTool(
    state: AgentSessionTelemetry,
    parentTool: BlameSpan,
    outcome: "succeeded" | "failed",
  ) {
    const roots = [...state.agentSpans]
      .filter(([, current]) => current.parentTool === parentTool)
      .map(([agentKey]) => agentKey);
    this.finishAgentKeys(state, descendantAgentKeys(state, roots), outcome);
  }

  private finishAgentKeys(
    state: AgentSessionTelemetry,
    agentKeys: Set<string>,
    outcome: "succeeded" | "failed" | "canceled",
  ) {
    for (const agentKey of leafOrderedAgentKeys(state, agentKeys)) {
      this.finishAgentSpan(state, agentKey, outcome);
    }
  }

  private finishAgentSpan(
    state: AgentSessionTelemetry,
    agentKey: string,
    outcome: "succeeded" | "failed" | "canceled",
  ) {
    const current = state.agentSpans.get(agentKey);
    if (!current) return;
    this.finishModelSpan(state, agentKey, undefined, outcome);
    this.finishAgentToolSpans(state, agentKey, outcome);
    state.agentSpans.delete(agentKey);
    if (outcome === "failed") {
      current.span.setAttributes({ [ATTR_ERROR_TYPE]: "AgentError" });
    }
    current.span.end(outcome);
  }

  private finishAgentToolSpans(
    state: AgentSessionTelemetry,
    agentKey: string,
    outcome: "succeeded" | "failed" | "canceled",
  ) {
    for (const [key, current] of state.toolSpans) {
      if (current.agentKey !== agentKey) continue;
      state.toolSpans.delete(key);
      completeToolSpan(state, current, outcome);
    }
  }

  private recordFirstAction(state: AgentSessionTelemetry) {
    if (state.firstActionRecorded || !state.component) return;
    state.firstActionRecorded = true;
    telemetry.record(
      "blame.agent.time_to_first_action",
      turnDuration(state),
      metricDimensions(state),
      state.component.span.context,
    );
  }

  private recordModelFirstChunk(
    state: AgentSessionTelemetry,
    agentKey: string,
  ) {
    const current = state.modelSpans.get(agentKey);
    if (!current || current.firstChunkRecorded) return;
    current.firstChunkRecorded = true;
    const duration = current.span.durationSeconds();
    telemetry.record(
      METRIC_GEN_AI_TIME_TO_FIRST_CHUNK,
      duration,
      modelAttributes(state, current.role, current.iteration),
      current.span.context,
    );
    telemetry.record(
      "blame.model.time_to_first_token",
      duration,
      modelAttributes(state, current.role, current.iteration),
      current.span.context,
    );
  }

  private recordRetry(state: AgentSessionTelemetry, details: CoreEventDetails) {
    state.retryCount += 1;
    const reason = retryReason(details.event);
    const attributes = {
      ...modelAttributes(state, details.role, agentIteration(state, details)),
      [ATTR_ERROR_TYPE]: retryErrorType(reason),
    };
    telemetry.count(
      "blame.agent.retry.count",
      1,
      attributes,
      state.component?.span.context,
    );
    telemetry.count(
      "blame.harness.model_retries",
      1,
      attributes,
      state.component?.span.context,
    );
    countProviderError(attributes, state.component?.span.context, {
      reason,
    });
    this.finishModelSpan(
      state,
      details.agentKey,
      { finishReason: reason },
      "failed",
    );
  }

  private markMultiAgent(state: AgentSessionTelemetry) {
    if (state.multiAgentUsed) return;
    state.multiAgentUsed = true;
    const attributes = { [ATTR_BLAME_MULTI_AGENT_USED]: true };
    setDescriptorAttributes(state, attributes);
    executions.setAttributes(state.descriptor.executionId, attributes);
    state.component?.span.setAttributes(attributes);
    setActiveSpanAttributes(state, attributes);
  }

  private recordUsage(
    state: AgentSessionTelemetry,
    value: unknown,
    agentKey: string,
  ) {
    if (!state.component) return;
    const next = usageSnapshot(value);
    const audit = auditSdkUsage(value);
    state.component.span.setAttributes({
      "blame.usage.completeness": audit.completeness,
      "blame.usage.normalization_version": audit.normalizationVersion,
      "blame.usage.cost_available": audit.cost !== null,
    });
    const previous = state.usageByAgent.get(agentKey) ?? emptyUsage();
    const delta = usageDelta(previous, next);
    state.usageByAgent.set(agentKey, next);
    state.usage = addUsage(state.usage, delta);
    recordModelUsage(state, agentKey, delta);
    recordTokenUsage(state, delta, state.component.span.context);
    if (delta.input > 0)
      telemetry.record(
        "blame.harness.context_tokens_per_turn",
        delta.input,
        metricDimensions(state),
        state.component.span.context,
      );
    recordCost(state, delta.cost, state.component.span.context);
    state.component.span.setAttributes(usageAttributes(state.usage));
  }

  private recordAggregateUsage(state: AgentSessionTelemetry, value: unknown) {
    if (!state.component) return;
    const next = usageSnapshot(value);
    if (state.usageByAgent.size === 0) {
      const delta = usageDelta(state.aggregateUsageCursor, next);
      state.aggregateUsageCursor = next;
      state.usage = addUsage(state.usage, delta);
      recordTokenUsage(state, delta, state.component.span.context);
      recordCost(state, delta.cost, state.component.span.context);
    } else {
      const missing = missingUsage(state.usage, next);
      state.usage = addUsage(state.usage, missing);
      recordTokenUsage(state, missing, state.component.span.context);
      recordCost(state, missing.cost, state.component.span.context);
    }
    state.component.span.setAttributes(usageAttributes(state.usage));
  }

  private updateIteration(
    state: AgentSessionTelemetry,
    agentKey: string,
    iteration?: number,
  ) {
    if (iteration === undefined) return;
    state.agentIterations.set(agentKey, iteration);
    state.iterations.add(`${agentKey}:${iteration}`);
    state.iteration = Math.max(state.iteration, iteration);
    updateModelIteration(state, agentKey, iteration);
    state.component?.span.setAttributes({
      [ATTR_BLAME_AGENT_ITERATION]: state.iteration,
    });
  }

  private finishFromPayload(sessionId: string, payload: unknown) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.finishFromPayloadForState(state, asRecord(payload), sessionId);
  }

  private finishFromPayloadForState(
    state: AgentSessionTelemetry,
    payload: Record<string, unknown>,
    sessionId = sessionIdForState(this.sessions, state),
  ) {
    const status = finishStatus(payload);
    if (status === "failed") this.fail(sessionId, payload);
    else if (status === "canceled") this.finish(sessionId, "canceled", payload);
    else this.finish(sessionId, "succeeded", payload);
  }

  private finish(
    sessionId: string,
    outcome: "succeeded" | "canceled",
    payload?: unknown,
  ) {
    const state = this.sessions.get(sessionId);
    if (!state?.component) return;
    const finishReason = normalizedFinishReason(payload, outcome);
    state.component.span.setAttributes({
      [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [finishReason],
    });
    this.finishActiveSpans(state, outcome, payload);
    state.component.span.setAttributes(usageAttributes(state.usage));
    this.recordCompletionMetrics(state, outcome);
    telemetry.log(
      "info",
      "blame.agent.completed",
      { ...traceAttributes(state), "blame.execution.status": outcome },
      state.component.span.context,
    );
    if (outcome === "canceled") state.component.cancel();
    else state.component.succeed();
    state.component = undefined;
  }

  private finishActiveSpans(
    state: AgentSessionTelemetry,
    outcome: "succeeded" | "failed" | "canceled",
    payload?: unknown,
  ) {
    this.finishAgentSpans(state, outcome);
    this.finishModelSpans(state, outcome, payload);
    this.finishToolSpans(state, outcome);
  }

  private finishAgentSpans(
    state: AgentSessionTelemetry,
    outcome: "succeeded" | "failed" | "canceled",
  ) {
    const agentKeys = new Set(state.agentSpans.keys());
    this.finishAgentKeys(state, agentKeys, outcome);
  }

  private finishModelSpans(
    state: AgentSessionTelemetry,
    outcome: "succeeded" | "failed" | "canceled",
    payload?: unknown,
  ) {
    for (const current of state.modelSpans.values()) {
      completeModelSpan(state, current, asRecord(payload), outcome);
    }
    state.modelSpans.clear();
  }

  private finishToolSpans(
    state: AgentSessionTelemetry,
    outcome: "succeeded" | "failed" | "canceled",
  ) {
    for (const current of state.toolSpans.values()) {
      completeToolSpan(state, current, outcome);
    }
    state.toolSpans.clear();
  }

  private recordCompletionMetrics(
    state: AgentSessionTelemetry,
    outcome: string,
    error?: unknown,
  ) {
    const attributes = {
      ...metricDimensions(state),
      [ATTR_BLAME_MULTI_AGENT_USED]: state.multiAgentUsed,
      "blame.execution.status": outcome,
      ...errorMetric(error),
    };
    const activeContext = state.component?.span.context;
    recordAgentOutcomeDistributions(state, attributes, activeContext);
  }
}

type ToolDetails = {
  id?: string;
  input?: unknown;
  name: string;
  phase: "started" | "finished";
};

type DetachedOperation = {
  attributes: Record<string, unknown>;
  component: ExecutionComponent;
  modelSpan: BlameSpan;
};

type BusinessOperation = {
  attributes: Record<string, unknown>;
  component: ExecutionComponent;
  executionId: string;
  operationName: string;
};

type BusinessExecutionScope = {
  executionId: string;
  parent: Context;
};

function beginBusinessOperation(
  input: AgentTelemetryInput,
  operationName: string,
): BusinessOperation {
  const descriptor = executionDescriptor(randomUUID(), input);
  const attributes = {
    ...executionMetricAttributes(input),
    [ATTR_BLAME_OPERATION_NAME]: operationName,
  };
  const component = executions.beginComponent(
    descriptor,
    `blame.${operationName}`,
    attributes,
    businessScopeParent(descriptor.executionId),
  );
  return {
    attributes,
    component,
    executionId: descriptor.executionId,
    operationName,
  };
}

function runWithinBusinessScope<T>(
  current: BusinessOperation,
  operation: () => Promise<T>,
) {
  const scope = {
    executionId: current.executionId,
    parent: current.component.span.context,
  };
  return businessExecutionScope.run(scope, () =>
    telemetry.withinSpan(current.component.span, operation),
  );
}

function businessScopeParent(executionId: string) {
  const scope = businessExecutionScope.getStore();
  return scope?.executionId === executionId ? scope.parent : undefined;
}

function finishBusinessOperation(
  current: BusinessOperation,
  outcome: "succeeded" | "failed",
  error?: unknown,
) {
  recordBusinessOperation(
    current.component,
    current.operationName,
    current.attributes,
    outcome,
    error,
  );
}

function beginCheckpointOperation(
  state: AgentSessionTelemetry,
): BusinessOperation {
  const operationName = "checkpoint.restore";
  const attributes = {
    ...metricDimensions(state),
    [ATTR_BLAME_INTERVENTION_TYPE]: "checkpoint_restore",
    [ATTR_BLAME_OPERATION_NAME]: operationName,
  };
  const component = executions.beginComponent(
    state.descriptor,
    "blame.checkpoint.restore",
    attributes,
    state.component?.span.context,
  );
  recordCheckpointMetrics(attributes, component.span.context);
  component.span.addEvent("blame.agent.human_intervention", {
    [ATTR_BLAME_INTERVENTION_TYPE]: "checkpoint_restore",
  });
  return {
    attributes,
    component,
    executionId: state.descriptor.executionId,
    operationName,
  };
}

function recordCheckpointMetrics(
  attributes: Record<string, unknown>,
  activeContext: Context,
) {
  telemetry.count(
    "blame.agent.human_intervention.count",
    1,
    attributes,
    activeContext,
  );
  telemetry.count(
    "blame.agent.reverted_change.count",
    1,
    attributes,
    activeContext,
  );
}

function createSessionState(
  input: AgentTelemetryInput,
  descriptor: ExecutionDescriptor,
): AgentSessionTelemetry {
  return {
    agentIterations: new Map(),
    agentSpans: new Map(),
    aggregateUsageCursor: emptyUsage(),
    descriptor,
    authType: undefined,
    firstActionRecorded: false,
    firstEditRecorded: false,
    input,
    iteration: 0,
    iterations: new Set(),
    modelSpans: new Map(),
    multiAgentUsed: false,
    retryCount: 0,
    toolCallCount: 0,
    toolSpans: new Map(),
    turnStartedAt: performance.now(),
    usage: emptyUsage(),
    usageByAgent: new Map(),
  };
}

function normalizeTelemetryInput(input: AgentTelemetryInput) {
  return {
    ...input,
    modelId: boundedCohortName(input.modelId),
    providerId: semanticGenAiProviderName(input.providerId),
    repositoryLanguage: repositoryLanguage(
      input.repositoryLanguage ? [input.repositoryLanguage] : undefined,
    ),
    repositorySizeBucket: boundedRepositorySizeBucket(
      input.repositorySizeBucket,
    ),
    taskComplexityBucket: boundedComplexityBucket(input.taskComplexityBucket),
  };
}

export function boundedCohortName(value: string) {
  return boundedMetricDimensionName(value);
}

export function boundedToolName(value: string) {
  const toolName = boundedMetricDimensionName(value);
  return /^[A-Za-z][A-Za-z0-9._:/-]{0,95}$/.test(toolName) ? toolName : "other";
}

export function boundedInterventionType(value: string) {
  return interventionTypes.has(value) ? value : "other";
}

export function providerAuthType(value: string | undefined) {
  return value && providerAuthTypes.has(value)
    ? value
    : value
      ? "other"
      : undefined;
}

function resetTurn(state: AgentSessionTelemetry) {
  state.agentIterations.clear();
  state.agentSpans.clear();
  state.aggregateUsageCursor = emptyUsage();
  state.firstActionRecorded = false;
  state.firstEditRecorded = false;
  state.iteration = 0;
  state.iterations.clear();
  state.multiAgentUsed = false;
  state.retryCount = 0;
  state.toolCallCount = 0;
  state.turnStartedAt = performance.now();
  state.usage = emptyUsage();
  state.usageByAgent.clear();
}

function setActiveSpanAttributes(
  state: AgentSessionTelemetry,
  attributes: Record<string, unknown>,
) {
  for (const current of state.agentSpans.values()) {
    current.span.setAttributes(attributes);
  }
  for (const current of state.modelSpans.values()) {
    current.span.setAttributes(attributes);
  }
  for (const current of state.toolSpans.values()) {
    current.span.setAttributes(attributes);
  }
}

function setDescriptorAttributes(
  state: AgentSessionTelemetry,
  attributes: Record<string, unknown>,
) {
  state.descriptor.attributes = {
    ...state.descriptor.attributes,
    ...attributes,
  };
}

function executionDescriptor(sessionId: string, input: AgentTelemetryInput) {
  return {
    attributes: executionMetricAttributes(input),
    executionId:
      input.executionId?.trim() ||
      businessExecutionScope.getStore()?.executionId ||
      sessionId,
    storyId: input.storyId,
  };
}

export function nextExecutionDescriptor(
  descriptor: ExecutionDescriptor,
  executionId?: string,
  storyId?: string,
) {
  return {
    ...descriptor,
    executionId: executionId?.trim() || descriptor.executionId,
    storyId: storyId?.trim() || descriptor.storyId,
  };
}

function traceAttributes(state: AgentSessionTelemetry) {
  return {
    ...modelAttributes(state, "lead"),
    [ATTR_BLAME_EXECUTION_ID]: state.descriptor.executionId,
    [ATTR_BLAME_MULTI_AGENT_ENABLED]: multiAgentEnabled(state.input),
    [ATTR_BLAME_MULTI_AGENT_USED]: state.multiAgentUsed,
    [ATTR_BLAME_STORY_ID]: state.descriptor.storyId,
  };
}

function modelMetricAttributes(
  state: AgentSessionTelemetry,
  role: string,
  iteration: number,
  outcome: "succeeded" | "failed" | "canceled",
  response: Record<string, unknown>,
) {
  return {
    ...modelAttributes(state, role, iteration),
    ...response,
    [ATTR_BLAME_OPERATION_STATUS]: outcome,
    ...(outcome === "failed" ? { [ATTR_ERROR_TYPE]: "ModelError" } : {}),
  };
}

function completeModelSpan(
  state: AgentSessionTelemetry,
  current: ModelSpanState,
  payload: Record<string, unknown> | undefined,
  outcome: "succeeded" | "failed" | "canceled",
) {
  const response = responseAttributes(payload, outcome);
  current.span.setAttributes(response);
  if (outcome === "failed") {
    current.span.setAttributes({ [ATTR_ERROR_TYPE]: "ModelError" });
  }
  const attributes = modelMetricAttributes(
    state,
    current.role,
    current.iteration,
    outcome,
    response,
  );
  recordModelMetrics(current, attributes);
  current.span.end(outcome);
}

function recordModelMetrics(
  current: ModelSpanState,
  attributes: Record<string, unknown>,
) {
  telemetry.count(
    "blame.model.request.count",
    1,
    attributes,
    current.span.context,
  );
  telemetry.record(
    METRIC_GEN_AI_OPERATION_DURATION,
    current.span.durationSeconds(),
    attributes,
    current.span.context,
  );
}

function executionMetricAttributes(input: AgentTelemetryInput) {
  return {
    ...cohortAttributes(input),
    [ATTR_BLAME_AGENT_ROLE]: "lead",
    [ATTR_BLAME_AGENT_STRATEGY]: configuredAgentStrategy(input),
    [ATTR_BLAME_EXECUTION_KIND]: "agent",
    [ATTR_BLAME_MULTI_AGENT_ENABLED]: multiAgentEnabled(input),
    [ATTR_BLAME_MULTI_AGENT_USED]: false,
    [ATTR_GEN_AI_PROVIDER_NAME]: input.providerId,
    [ATTR_GEN_AI_REQUEST_MODEL]: input.modelId,
  };
}

function applyRepositoryCohorts(
  input: AgentTelemetryInput,
  languages: string[] | undefined,
  fileCount: number | undefined,
) {
  const language = repositoryLanguage(languages);
  const sizeBucket = repositorySizeBucket(fileCount);
  if (language) input.repositoryLanguage = language;
  if (sizeBucket) input.repositorySizeBucket = sizeBucket;
}

export function repositoryLanguage(languages: string[] | undefined) {
  const normalizedLanguages = new Set<string>();
  for (const language of languages ?? []) {
    const candidate = language.trim().toLowerCase();
    const normalized = repositoryLanguageAliases.get(candidate) ?? candidate;
    normalizedLanguages.add(
      repositoryLanguages.has(normalized) ? normalized : "other",
    );
  }
  if (normalizedLanguages.size === 0) return undefined;
  if (normalizedLanguages.size > 1) return "mixed";
  return normalizedLanguages.values().next().value;
}

export function repositorySizeBucket(fileCount: number | undefined) {
  if (fileCount === undefined || !Number.isFinite(fileCount)) return undefined;
  if (fileCount < 100) return "small";
  if (fileCount < 1_000) return "medium";
  if (fileCount < 10_000) return "large";
  return "very_large";
}

function boundedComplexityBucket(value: string | undefined) {
  return value && complexityBuckets.has(value) ? value : undefined;
}

function boundedRepositorySizeBucket(value: string | undefined) {
  return value && repositorySizeBuckets.has(value) ? value : undefined;
}

const repositoryLanguages = new Set([
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "go",
  "html",
  "java",
  "javascript",
  "kotlin",
  "mixed",
  "php",
  "python",
  "ruby",
  "rust",
  "shell",
  "swift",
  "typescript",
  "vue",
]);
const repositoryLanguageAliases = new Map([
  ["c#", "csharp"],
  ["c++", "cpp"],
  ["cs", "csharp"],
  ["jsx", "javascript"],
  ["sh", "shell"],
  ["tsx", "typescript"],
]);
const complexityBuckets = new Set(["small", "medium", "large"]);
const interventionTypes = new Set(["abort", "feedback", "tool_approval"]);
const providerAuthTypes = new Set(["api-key", "oauth"]);
const repositorySizeBuckets = new Set([
  "small",
  "medium",
  "large",
  "very_large",
]);

function modelSpanAttributes(
  state: AgentSessionTelemetry,
  details: CoreEventDetails,
) {
  return {
    ...modelAttributes(state, details.role, agentIteration(state, details)),
    [ATTR_BLAME_AGENT_ID]: details.agentKey,
    [ATTR_BLAME_MULTI_AGENT_USED]: state.multiAgentUsed,
  };
}

function agentSpanAttributes(
  state: AgentSessionTelemetry,
  details: CoreEventDetails,
) {
  return {
    ...modelAttributes(state, details.role, agentIteration(state, details)),
    [ATTR_BLAME_AGENT_ID]: details.agentKey,
    [ATTR_BLAME_AGENT_PARENT_ID]: details.parentAgentKey,
    [ATTR_BLAME_MULTI_AGENT_USED]: true,
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
  };
}

function availableSpawnTool(
  state: AgentSessionTelemetry,
  parentAgentKey: string,
) {
  const assigned = new Set(
    [...state.agentSpans.values()].map((current) => current.parentTool),
  );
  const candidates = [...state.toolSpans.values()].filter(
    (current) =>
      current.agentKey === parentAgentKey && current.name === "spawn_agent",
  );
  return (
    candidates.find((current) => !assigned.has(current.span)) ??
    candidates[candidates.length - 1]
  );
}

function descendantAgentKeys(state: AgentSessionTelemetry, roots: string[]) {
  const agentKeys = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [agentKey, current] of state.agentSpans) {
      if (!agentKeys.has(current.parentAgentKey) || agentKeys.has(agentKey))
        continue;
      agentKeys.add(agentKey);
      changed = true;
    }
  }
  return agentKeys;
}

function leafOrderedAgentKeys(
  state: AgentSessionTelemetry,
  agentKeys: Set<string>,
) {
  const pending = new Set(
    [...agentKeys].filter((agentKey) => state.agentSpans.has(agentKey)),
  );
  const ordered: string[] = [];
  while (pending.size > 0) {
    const leaf = [...pending].find(
      (agentKey) => !hasPendingChild(state, pending, agentKey),
    );
    const next = leaf ?? pending.values().next().value;
    if (!next) break;
    ordered.push(next);
    pending.delete(next);
  }
  return ordered;
}

function hasPendingChild(
  state: AgentSessionTelemetry,
  pending: Set<string>,
  agentKey: string,
) {
  return [...pending].some(
    (candidate) => state.agentSpans.get(candidate)?.parentAgentKey === agentKey,
  );
}

function agentIteration(
  state: AgentSessionTelemetry,
  details: CoreEventDetails,
) {
  return details.iteration ?? state.agentIterations.get(details.agentKey) ?? 0;
}

function updateModelIteration(
  state: AgentSessionTelemetry,
  agentKey: string,
  iteration: number,
) {
  const current = state.modelSpans.get(agentKey);
  if (!current) return;
  current.iteration = iteration;
  current.span.setAttributes({ [ATTR_BLAME_AGENT_ITERATION]: iteration });
}

function recordAgentOutcomeDistributions(
  state: AgentSessionTelemetry,
  attributes: Record<string, unknown>,
  activeContext?: Context,
) {
  const values: Array<[string, number]> = [
    ["blame.agent.iterations_per_execution", state.iterations.size],
    ["blame.agent.tool_calls_per_execution", state.toolCallCount],
    ["blame.agent.retries_per_execution", state.retryCount],
  ];
  for (const [name, value] of values) {
    telemetry.record(name, value, attributes, activeContext);
  }
}

function toolAttributes(
  state: AgentSessionTelemetry,
  details: CoreEventDetails,
  tool: ToolDetails,
  category: string,
) {
  return {
    ...modelAttributes(state, details.role, agentIteration(state, details)),
    [ATTR_BLAME_AGENT_ID]: details.agentKey,
    [ATTR_BLAME_MULTI_AGENT_USED]: state.multiAgentUsed,
    [ATTR_BLAME_SHELL_CATEGORY]: commandCategory(tool.name, tool.input),
    [ATTR_BLAME_TOOL_CATEGORY]: category,
    [ATTR_BLAME_TOOL_NAME]: tool.name,
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_EXECUTE_TOOL,
    [ATTR_GEN_AI_TOOL_CALL_ID]: tool.id,
    [ATTR_GEN_AI_TOOL_NAME]: tool.name,
  };
}

function startToolSpan(
  parent: Context,
  toolName: string,
  attributes: Record<string, unknown>,
) {
  return telemetry.startSpan(`${GEN_AI_OPERATION_EXECUTE_TOOL} ${toolName}`, {
    attributes,
    parent,
  });
}

function trackToolSpan(
  state: AgentSessionTelemetry,
  component: ExecutionComponent,
  details: CoreEventDetails,
  key: string,
  name: string,
  category: string,
  attributes: Record<string, unknown>,
) {
  const parent =
    state.agentSpans.get(details.agentKey)?.span.context ??
    component.span.context;
  const span = startToolSpan(parent, name, attributes);
  state.toolSpans.set(key, {
    agentKey: details.agentKey,
    category,
    iteration: agentIteration(state, details),
    name,
    role: details.role,
    span,
  });
  return span;
}

function completeToolSpan(
  state: AgentSessionTelemetry,
  current: ToolSpanState,
  outcome: "succeeded" | "failed" | "canceled",
) {
  const attributes = {
    ...toolMetricAttributes(state, current),
    ...(outcome === "failed" ? { [ATTR_ERROR_TYPE]: "ToolError" } : {}),
  };
  recordToolDuration(current, attributes);
  recordTestOutcome(current, outcome, attributes);
  if (outcome === "failed") recordToolFailure(current, attributes);
  current.span.end(outcome);
}

function recordToolDuration(
  current: ToolSpanState,
  attributes: Record<string, unknown>,
) {
  telemetry.record(
    "blame.tool.duration",
    current.span.durationSeconds(),
    attributes,
    current.span.context,
  );
}

function recordTestOutcome(
  current: ToolSpanState,
  outcome: "succeeded" | "failed" | "canceled",
  attributes: Record<string, unknown>,
) {
  if (current.category !== "test") return;
  const status = outcome === "succeeded" ? "passed" : outcome;
  telemetry.record(
    "blame.test.duration",
    current.span.durationSeconds(),
    attributes,
    current.span.context,
  );
  telemetry.count(
    "blame.test.run.count",
    1,
    { ...attributes, [ATTR_BLAME_TEST_STATUS]: status },
    current.span.context,
  );
}

function recordToolFailure(
  current: ToolSpanState,
  attributes: Record<string, unknown>,
) {
  current.span.setAttributes({ [ATTR_ERROR_TYPE]: "ToolError" });
  telemetry.count(
    "blame.tool.failure.count",
    1,
    attributes,
    current.span.context,
  );
}

export function coreEventDetails(
  coreEvent: CoreSessionEvent,
): CoreEventDetails {
  const payload = asRecord(coreEvent.payload);
  const event =
    coreEvent.type === "agent_event" ? asRecord(payload.event) : payload;
  const parentAgentId =
    stringValue(event.parentAgentId) ?? stringValue(payload.parentAgentId);
  const agentId =
    stringValue(event.agentId) ??
    stringValue(payload.teamAgentId) ??
    stringValue(payload.agentId);
  const teammate = payload.teamRole === "teammate" || Boolean(parentAgentId);
  return {
    agentKey: agentId ?? parentAgentId ?? (teammate ? "teammate" : "lead"),
    event,
    iteration: numericValue(event.iteration),
    payload,
    parentAgentKey: parentAgentId ?? "lead",
    role: teammate ? "teammate" : "lead",
  };
}

function toolDetails(
  coreType: string,
  details: CoreEventDetails,
): ToolDetails | undefined {
  const source = details.event;
  const contentType = stringValue(source.contentType);
  const hookName = stringValue(details.payload.hookEventName);
  if (contentType !== "tool" && coreType !== "hook") return undefined;
  const name =
    stringValue(source.toolName) ?? stringValue(details.payload.toolName);
  if (!name) return undefined;
  const phase = toolPhase(stringValue(source.type), hookName);
  if (!phase) return undefined;
  const call = asRecord(source.toolCall);
  return {
    id:
      stringValue(call.id) ??
      stringValue(source.toolCallId) ??
      stringValue(source.contentId),
    input: call.input ?? source.input,
    name,
    phase,
  };
}

function toolPhase(type?: string, hookName?: string) {
  if (type === "content_start" || hookName === "tool_call")
    return "started" as const;
  if (type === "content_end" || hookName === "tool_result")
    return "finished" as const;
  return undefined;
}

function toolKey(agentKey: string, tool: ToolDetails) {
  return `${agentKey}:${tool.id ?? tool.name}`;
}

function toolCategory(name: string, input: unknown) {
  if (name === "spawn_agent") return "agent";
  if (name === "run_commands")
    return containsTestCommand(input) ? "test" : "shell";
  if (["editor", "apply_patch"].includes(name)) return "file_write";
  if (["read_files", "search_codebase"].includes(name)) return "file_read";
  return "other";
}

function containsTestCommand(input: unknown) {
  const serialized = safeSerialization(input).slice(0, 4_096);
  return /(?:^|[\s"'])(?:test|tests|pytest|vitest|jest|japa|mocha|cargo test|go test|node --test)(?:[\s"']|$)/i.test(
    serialized,
  );
}

export function commandCategory(toolName: string, input: unknown) {
  if (toolName !== "run_commands") return undefined;
  const command = safeSerialization(input).slice(0, 4_096).toLowerCase();
  if (containsTestCommand(input)) return "test";
  if (/\bgit\b/.test(command)) return "git";
  if (/\b(?:docker|podman|compose)\b/.test(command)) return "container";
  if (isInstallCommand(command)) return "install";
  if (/\b(?:build|compile|tsc)\b/.test(command)) return "build";
  if (/\b(?:npm|pnpm|yarn|bun|pip|poetry|cargo|mvn|gradle)\b/.test(command))
    return "package_manager";
  return "other";
}

function isInstallCommand(command: string) {
  return /\b(?:install|add|fetch|sync)\b/.test(command);
}

function safeSerialization(value: unknown) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isContentEvent(event: Record<string, unknown>) {
  const type = stringValue(event.type);
  return type === "content_start" || type === "content_end";
}

function isUsageEvent(event: Record<string, unknown>) {
  return stringValue(event.type) === "usage";
}

export function isRetryEvent(event: Record<string, unknown>) {
  const type = stringValue(event.type);
  const status = stringValue(event.status);
  const reason = stringValue(event.reason);
  return (
    type === "retry" ||
    status === "retrying" ||
    (type === "notice" && event.noticeType === "recovery") ||
    retryReasons.has(reason ?? "")
  );
}

function retryReason(event: Record<string, unknown>) {
  return (
    stringValue(event.reason) ?? stringValue(event.status) ?? "model_retry"
  );
}

function retryErrorType(reason: string) {
  if (reason === "api_error") return "ProviderApiError";
  if (reason === "tool_execution_failed") return "ToolError";
  return "ModelError";
}

export function toolFailed(event: Record<string, unknown>) {
  const status = stringValue(event.status);
  return (
    event.isError === true ||
    Boolean(stringValue(event.error)) ||
    status === "failed" ||
    status === "error"
  );
}

function finishStatus(payload: Record<string, unknown>) {
  const status = rawFinishReason(payload)?.toLowerCase();
  if (
    status &&
    [
      "failed",
      "error",
      "max-iterations",
      "max_iterations",
      "mistake-limit",
      "mistake_limit",
    ].includes(status)
  )
    return "failed";
  if (status && ["cancelled", "canceled", "aborted"].includes(status))
    return "canceled";
  return "succeeded";
}

function rawFinishReason(value: unknown) {
  const payload = asRecord(value);
  return (
    stringValue(payload.finishReason) ??
    stringValue(payload.status) ??
    stringValue(payload.reason)
  );
}

export function responseAttributes(
  payload: Record<string, unknown> = {},
  outcome: "succeeded" | "failed" | "canceled" = "succeeded",
) {
  const responseModel =
    stringValue(payload.responseModel) ?? stringValue(payload.model);
  const model = responseModel
    ? boundedMetricDimensionName(responseModel)
    : undefined;
  const reason = normalizedFinishReason(payload, outcome);
  return {
    [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [reason],
    [ATTR_GEN_AI_RESPONSE_MODEL]: model,
  };
}

function normalizedFinishReason(
  value: unknown,
  outcome: "succeeded" | "failed" | "canceled",
) {
  const reason = rawFinishReason(value)?.trim().toLowerCase();
  if (!reason) return outcomeFinishReason(outcome);
  if (
    ["stop", "completed", "complete", "success", "succeeded"].includes(reason)
  )
    return "stop";
  if (["tool-calls", "tool_calls"].includes(reason)) return "tool-calls";
  if (["length", "max_tokens", "max-tokens"].includes(reason))
    return "max-tokens";
  if (["content-filter", "content_filter"].includes(reason))
    return "content-filter";
  if (["cancelled", "canceled", "aborted"].includes(reason)) return "aborted";
  if (["failed", "error", "mistake-limit", "mistake_limit"].includes(reason))
    return "error";
  if (["max-iterations", "max_iterations"].includes(reason))
    return "max-iterations";
  return outcome === "succeeded" ? "other" : outcomeFinishReason(outcome);
}

function outcomeFinishReason(outcome: "succeeded" | "failed" | "canceled") {
  if (outcome === "failed") return "error";
  if (outcome === "canceled") return "aborted";
  return "stop";
}

const retryReasons = new Set([
  "api_error",
  "completion_without_submit",
  "invalid_tool_call",
  "tool_execution_failed",
]);

function countProviderError(
  attributes: Record<string, unknown>,
  activeContext: Context | undefined,
  error: unknown,
) {
  const errorType = providerErrorType(error);
  if (!errorType) return;
  telemetry.count(
    "blame.provider.error.count",
    1,
    { ...attributes, [ATTR_ERROR_TYPE]: errorType },
    activeContext,
  );
}

export function providerErrorType(error: unknown) {
  const signal = providerErrorSignal(error);
  if (/rate.?limit|too many requests|\b429\b/.test(signal))
    return "ProviderRateLimitError";
  if (/authentication|unauthorized|invalid api key|\b40[13]\b/.test(signal))
    return "ProviderAuthenticationError";
  if (/timeout|timed out|etimedout/.test(signal)) return "ProviderTimeoutError";
  if (/econn|enotfound|overload|unavailable|\b5\d\d\b/.test(signal))
    return "ProviderUnavailableError";
  if (/api_error|api(?:connection|status)?error|\bapi\b|provider/.test(signal))
    return "ProviderApiError";
  return undefined;
}

function providerErrorSignal(error: unknown) {
  const record = asRecord(error);
  const nested = asRecord(record.error);
  const values = [
    error instanceof Error ? error.name : undefined,
    error instanceof Error ? error.message : undefined,
    ...providerSignalValues(record),
    ...providerSignalValues(nested),
  ];
  return values.filter(Boolean).join(" ").toLowerCase();
}

function providerSignalValues(record: Record<string, unknown>) {
  return ["code", "message", "name", "reason", "status", "type"].map((key) =>
    signalValue(record[key]),
  );
}

function signalValue(value: unknown) {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

function errorRecord(error: unknown) {
  return {
    [ATTR_ERROR_TYPE]: providerErrorType(error) ?? "AgentError",
  };
}

function errorMetric(error: unknown) {
  return error
    ? { [ATTR_ERROR_TYPE]: providerErrorType(error) ?? "AgentError" }
    : {};
}

function sessionIdForState(
  sessions: Map<string, AgentSessionTelemetry>,
  state: AgentSessionTelemetry,
) {
  for (const [sessionId, candidate] of sessions) {
    if (candidate === state) return sessionId;
  }
  return "";
}

function leadDetails(): CoreEventDetails {
  return {
    agentKey: "lead",
    event: {},
    payload: {},
    parentAgentKey: "lead",
    role: "lead",
  };
}

function detachedOperationAttributes(
  input: AgentTelemetryInput,
  operationName: string,
  authType?: string,
) {
  return {
    [ATTR_BLAME_AGENT_ROLE]: "lead",
    [ATTR_BLAME_AGENT_STRATEGY]: configuredAgentStrategy(input),
    [ATTR_BLAME_EXECUTION_KIND]: "agent",
    [ATTR_BLAME_MULTI_AGENT_ENABLED]: multiAgentEnabled(input),
    [ATTR_BLAME_MULTI_AGENT_USED]: false,
    [ATTR_BLAME_OPERATION_NAME]: operationName,
    [ATTR_BLAME_PROVIDER_AUTH_TYPE]: providerAuthType(authType),
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
    [ATTR_GEN_AI_PROVIDER_NAME]: input.providerId,
    [ATTR_GEN_AI_REQUEST_MODEL]: input.modelId,
  };
}

function beginDetachedOperation(
  input: AgentTelemetryInput,
  operationName: string,
  authType?: string,
): DetachedOperation {
  const descriptor = executionDescriptor(randomUUID(), input);
  const attributes = detachedOperationAttributes(
    input,
    operationName,
    authType,
  );
  const component = executions.beginComponent(
    descriptor,
    "invoke_agent",
    attributes,
    businessScopeParent(descriptor.executionId),
  );
  const modelAttributes = detachedModelAttributes(input, attributes);
  const modelSpan = startDetachedModelSpan(input, modelAttributes, component);
  return { attributes: modelAttributes, component, modelSpan };
}

function detachedModelAttributes(
  input: AgentTelemetryInput,
  attributes: Record<string, unknown>,
) {
  return {
    ...attributes,
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_CHAT,
    [ATTR_GEN_AI_REQUEST_MODEL]: input.modelId,
  };
}

function startDetachedModelSpan(
  input: AgentTelemetryInput,
  attributes: Record<string, unknown>,
  component: ExecutionComponent,
) {
  return telemetry.startSpan(`${GEN_AI_OPERATION_CHAT} ${input.modelId}`, {
    attributes,
    kind: SpanKind.CLIENT,
    parent: component.span.context,
  });
}

function finishDetachedOperation(
  component: ExecutionComponent,
  modelSpan: BlameSpan,
  attributes: Record<string, unknown>,
  result: unknown,
) {
  const usage = usageSnapshot(result);
  const response = responseAttributes(asRecord(result));
  const metricAttributes = {
    ...attributes,
    ...response,
    [ATTR_BLAME_OPERATION_STATUS]: "succeeded",
  };
  modelSpan.setAttributes({
    ...response,
    ...usageAttributes(usage),
  });
  recordDetachedModelMetrics(modelSpan, metricAttributes);
  recordDetachedUsage(usage, metricAttributes, modelSpan.context);
  modelSpan.end("succeeded");
  component.succeed();
}

function recordDetachedModelMetrics(
  modelSpan: BlameSpan,
  attributes: Record<string, unknown>,
) {
  telemetry.count(
    "blame.model.request.count",
    1,
    attributes,
    modelSpan.context,
  );
  telemetry.record(
    METRIC_GEN_AI_OPERATION_DURATION,
    modelSpan.durationSeconds(),
    attributes,
    modelSpan.context,
  );
}

function failDetachedOperation(
  component: ExecutionComponent,
  modelSpan: BlameSpan,
  attributes: Record<string, unknown>,
  error: unknown,
) {
  const failureAttributes = {
    ...attributes,
    ...responseAttributes({}, "failed"),
    [ATTR_BLAME_OPERATION_STATUS]: "failed",
    [ATTR_ERROR_TYPE]: "ModelError",
  };
  modelSpan.setAttributes(failureAttributes);
  telemetry.count(
    "blame.model.request.count",
    1,
    failureAttributes,
    modelSpan.context,
  );
  telemetry.record(
    METRIC_GEN_AI_OPERATION_DURATION,
    modelSpan.durationSeconds(),
    failureAttributes,
    modelSpan.context,
  );
  countProviderError(failureAttributes, modelSpan.context, error);
  modelSpan.recordError(error).setAttributes(failureAttributes).end("failed");
  component.fail(error);
}

function recordDetachedUsage(
  usage: UsageSnapshot,
  attributes: Record<string, unknown>,
  activeContext: Context,
) {
  recordDetachedTokens(usage, attributes, activeContext);
  recordDetachedValue(
    "blame.gen_ai.cache_read_token.usage",
    usage.cacheRead,
    attributes,
    activeContext,
  );
  recordDetachedValue(
    "blame.gen_ai.cache_creation_token.usage",
    usage.cacheCreated,
    attributes,
    activeContext,
  );
  recordDetachedCost(usage.cost, attributes, activeContext);
}

function recordDetachedTokens(
  usage: UsageSnapshot,
  attributes: Record<string, unknown>,
  activeContext: Context,
) {
  for (const [type, value] of tokenEntries(usage)) {
    if (value <= 0) continue;
    telemetry.record(
      METRIC_GEN_AI_TOKEN_USAGE,
      value,
      { ...attributes, "gen_ai.token.type": type },
      activeContext,
    );
  }
}

function recordDetachedValue(
  name: string,
  value: number,
  attributes: Record<string, unknown>,
  activeContext: Context,
) {
  if (value <= 0) return;
  telemetry.record(name, value, attributes, activeContext);
}

function recordDetachedCost(
  cost: number,
  attributes: Record<string, unknown>,
  activeContext: Context,
) {
  if (cost <= 0) return;
  telemetry.count(
    "blame.gen_ai.estimated_cost",
    cost,
    attributes,
    activeContext,
  );
}

function tokenEntries(usage: UsageSnapshot): Array<[string, number]> {
  return [
    ["input", usage.input],
    ["output", usage.output],
  ];
}

function recordBusinessOperation(
  component: ExecutionComponent,
  operationName: string,
  baseAttributes: Record<string, unknown>,
  outcome: "succeeded" | "failed",
  error?: unknown,
) {
  const attributes = {
    ...baseAttributes,
    [ATTR_BLAME_OPERATION_NAME]: operationName,
    "blame.execution.status": outcome,
    ...errorMetric(error),
  };
  telemetry.count(
    `blame.${operationName}.count`,
    1,
    attributes,
    component.span.context,
  );
  telemetry.record(
    `blame.${operationName}.duration`,
    component.span.durationSeconds(),
    attributes,
    component.span.context,
  );
  if (outcome === "failed") component.fail(error);
  else component.succeed();
}
