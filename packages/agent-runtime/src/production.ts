import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { supplementalModelConfig } from "./supplemental-model-config.js";
import type {
  BasicLogger,
  CoreCheckpointConfig,
  CoreCompactionConfig,
  CoreSessionConfig,
  SessionUsageSummary,
} from "@cline/sdk";
import {
  getBlameTelemetry,
  sanitizeText,
  type TelemetrySeverity,
} from "@blame/telemetry";
import type {
  AgentRuntimeConfigExtension,
  AgentUsageSummary,
  AgentUsageTotals,
} from "./types.js";

export type ProductionConfig = {
  checkpointEnabled?: boolean;
  compactionEnabled?: boolean;
  compactionPreserveRecentTokens?: number;
  compactionStrategy?: "agentic" | "basic";
  configExtensions?: AgentRuntimeConfigExtension[];
  disableMcpSettingsTools?: boolean;
  maxInputTokens?: number;
  messageBuilderMaxToolResultChars?: number;
  messageBuilderMaxTotalTextBytes?: number;
  messageBuilderMinOutdatedRewriteBytes?: number;
  maxOutputTokens?: number;
  requestMaxOutputTokens?: number;
  maxParallelToolCalls?: number;
  maxSessionCostUsd?: number;
  maxTotalTokens?: number;
  pluginPaths?: string[];
};

export type ProductionSessionContext = {
  checkpointEnabled?: boolean;
  configExtensions?: string;
  disableMcpSettingsTools?: boolean;
  durationMs?: number;
  finishReason?: string;
  maxIterations?: number;
  mode?: string;
  modelId?: string;
  providerId?: string;
  pluginPathCount?: number;
  sessionId?: string;
  status?: string;
  storyId?: string | number;
};

type UsageSummary = AgentUsageSummary | SessionUsageSummary;
type UsageTotals = AgentUsageTotals | NonNullable<SessionUsageSummary["usage"]>;

const secretKeys = [
  "access",
  "apiKey",
  "authorization",
  "headers",
  "oauthCredentials",
  "refresh",
  "token",
];

const allowedLogKeys = new Set([
  "cacheReadTokens",
  "cacheWriteTokens",
  "capsuleHash",
  "ccrHashCount",
  "checkpointEnabled",
  "compressed",
  "compactedEventHash",
  "compressionRatio",
  "contextUtilizationRatio",
  "configExtensions",
  "cost",
  "disableMcpSettingsTools",
  "durationMs",
  "errorType",
  "estimatedInputTokens",
  "fallback",
  "inputTokens",
  "maxIterations",
  "maxInputTokens",
  "messageBuilderMaxToolResultChars",
  "messageBuilderMaxTotalTextBytes",
  "messageBuilderMinOutdatedRewriteBytes",
  "messageCount",
  "messageCountAfter",
  "messageCountBefore",
  "maxParallelToolCalls",
  "mode",
  "modelId",
  "outputTokens",
  "promptLength",
  "providerId",
  "pluginPathCount",
  "sessionId",
  "status",
  "storyId",
  "success",
  "tailMessages",
  "targetTokens",
  "toolName",
  "toolResultTokens",
  "totalCacheReadTokens",
  "totalCacheWriteTokens",
  "totalCost",
  "totalInputTokens",
  "totalOutputTokens",
  "tokensAfter",
  "tokensBefore",
  "tokensSaved",
  "transformsApplied",
  "triggerTokens",
]);

const stableStringLogKeys = new Set([
  "capsuleHash",
  "compactedEventHash",
  "errorType",
  "mode",
  "modelId",
  "providerId",
  "sessionId",
  "status",
  "storyId",
  "toolName",
]);

const stableStringPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export function loadProductionConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProductionConfig {
  return {
    checkpointEnabled: booleanValue(env.BLAME_AGENT_CHECKPOINTS_ENABLED, true),
    compactionEnabled: booleanValue(env.BLAME_AGENT_COMPACTION_ENABLED, true),
    compactionPreserveRecentTokens: positiveNumber(
      env.BLAME_AGENT_COMPACTION_PRESERVE_RECENT_TOKENS,
    ),
    compactionStrategy: compactionStrategy(env.BLAME_AGENT_COMPACTION_STRATEGY),
    configExtensions: configExtensions(env.BLAME_AGENT_CONFIG_EXTENSIONS),
    disableMcpSettingsTools: !booleanValue(
      env.BLAME_AGENT_MCP_SETTINGS_TOOLS_ENABLED,
      true,
    ),
    maxInputTokens: positiveNumber(env.BLAME_AGENT_MAX_INPUT_TOKENS),
    messageBuilderMaxToolResultChars: positiveNumber(
      env.BLAME_AGENT_MESSAGE_BUILDER_MAX_TOOL_RESULT_CHARS,
    ),
    messageBuilderMaxTotalTextBytes: positiveNumber(
      env.BLAME_AGENT_MESSAGE_BUILDER_MAX_TOTAL_TEXT_BYTES,
    ),
    messageBuilderMinOutdatedRewriteBytes: positiveNumber(
      env.BLAME_AGENT_MESSAGE_BUILDER_MIN_OUTDATED_REWRITE_BYTES,
    ),
    maxOutputTokens: positiveNumber(env.BLAME_AGENT_MAX_OUTPUT_TOKENS),
    requestMaxOutputTokens: requestOutputLimit(env.BLAME_AGENT_REQUEST_MAX_OUTPUT_TOKENS),
    maxParallelToolCalls: positiveNumber(
      env.BLAME_AGENT_MAX_PARALLEL_TOOL_CALLS,
      8,
    ),
    maxSessionCostUsd: positiveNumber(env.BLAME_AGENT_MAX_SESSION_COST_USD),
    maxTotalTokens: positiveNumber(env.BLAME_AGENT_MAX_TOTAL_TOKENS),
    pluginPaths: listValue(env.BLAME_AGENT_PLUGIN_PATHS),
  };
}

export function applyProductionEnvironment(
  config: ProductionConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  setDefaultEnvValue(
    env,
    "CLINE_MESSAGE_BUILDER_MAX_TOOL_RESULT_CHARS",
    config.messageBuilderMaxToolResultChars,
  );
  setDefaultEnvValue(
    env,
    "CLINE_MESSAGE_BUILDER_MAX_TOTAL_TEXT_BYTES",
    config.messageBuilderMaxTotalTextBytes,
  );
  setDefaultEnvValue(
    env,
    "CLINE_MESSAGE_BUILDER_MIN_OUTDATED_REWRITE_BYTES",
    config.messageBuilderMinOutdatedRewriteBytes,
  );
}

export function createProductionLogger(): BasicLogger {
  return {
    debug: (_message: string, metadata?: unknown) =>
      writeProductionLog("debug", "blame.agent.sdk.debug", metadata),
    log: (_message: string, metadata?: unknown) =>
      writeProductionLog("info", "blame.agent.sdk.log", metadata),
    error: (_message: string, metadata?: unknown) =>
      writeProductionLog("error", "blame.agent.sdk.error", metadata),
  };
}

function writeProductionLog(
  severity: TelemetrySeverity,
  eventName: string,
  metadata?: unknown,
) {
  const record = getBlameTelemetry().structuredLog(
    severity,
    eventName,
    safeLogPayload(metadata),
  );
  const serialized = JSON.stringify(record);
  if (severity === "error") console.error(serialized);
  else if (severity === "debug") console.debug(serialized);
  else console.info(serialized);
}

export function promptMetadata(prompt: string) {
  return {
    promptLength: prompt.length,
  };
}

// A failed tool call goes back to the model as its result, so the agent reads
// the error and keeps working; failures alone never end a run. Cline's loop
// detection (the same call repeated) still stops it, because it jumps straight
// to this limit, and maxIterations bounds everything else.
const consecutiveMistakeLimit = 1_000;

export function appendProductionConfig<T extends CoreSessionConfig>(
  config: T,
  production: ProductionConfig = loadProductionConfig(),
): T {
  const configWithLimits = config as T & {
    maxConsecutiveMistakes?: number;
    maxParallelToolCalls?: number;
  };
  return {
    ...supplementalModelConfig(config),
    ...(production.requestMaxOutputTokens !== undefined ? { maxTokensPerTurn:
      Math.min(config.maxTokensPerTurn ?? production.requestMaxOutputTokens, production.requestMaxOutputTokens) } : {}),
    execution: {
      ...config.execution,
      loopDetection: config.execution?.loopDetection ?? {
        hardThreshold: 5,
        softThreshold: 3,
      },
      maxConsecutiveMistakes:
        config.execution?.maxConsecutiveMistakes ?? consecutiveMistakeLimit,
    },
    maxConsecutiveMistakes:
      configWithLimits.maxConsecutiveMistakes ?? consecutiveMistakeLimit,
    maxParallelToolCalls:
      configWithLimits.maxParallelToolCalls ??
      production.maxParallelToolCalls,
  };
}

function requestOutputLimit(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new Error("BLAME_AGENT_REQUEST_MAX_OUTPUT_TOKENS must be a positive integer.");
  return Number(value);
}

export function blameCheckpointConfig(
  config: ProductionConfig,
): CoreCheckpointConfig {
  return {
    enabled: config.checkpointEnabled ?? true,
  };
}

export function blameCompactionConfig(
  config: ProductionConfig,
): CoreCompactionConfig {
  return {
    enabled: config.compactionEnabled ?? true,
    ...(config.compactionPreserveRecentTokens
      ? { preserveRecentTokens: config.compactionPreserveRecentTokens }
      : {}),
    strategy: config.compactionStrategy ?? "agentic",
  };
}

export function runtimeConfigExtensions(config: ProductionConfig) {
  return config.configExtensions?.length ? config.configExtensions : undefined;
}

export function runtimePluginPaths(config: ProductionConfig, paths?: string[]) {
  const pluginPaths = [...(config.pluginPaths ?? []), ...(paths ?? [])];
  return pluginPaths.length ? Array.from(new Set(pluginPaths)) : undefined;
}

export function assertWorkspacePath(
  path: string,
  workspaceRoot: string,
  label: string,
) {
  const resolvedPath = resolve(path);
  const resolvedWorkspace = resolve(workspaceRoot);
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
  if (!isAbsolute(workspaceRoot))
    throw new Error("workspaceRoot must be an absolute path.");
  if (!isPathInside(resolvedPath, resolvedWorkspace)) {
    throw new Error(`${label} must stay inside workspaceRoot.`);
  }
}

export function assertRepositoryPath(path: string, label: string) {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
}

export function summarizeUsage(summary: UsageSummary | undefined) {
  const usage = summary?.aggregateUsage ?? summary?.usage;
  if (!usage) return {};
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cost: usageCost(usage),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalCacheReadTokens: usageTotalCacheReadTokens(usage),
    totalCacheWriteTokens: usageTotalCacheWriteTokens(usage),
    totalCost: usageTotalCost(usage),
    totalInputTokens: usageTotalInputTokens(usage),
    totalOutputTokens: usageTotalOutputTokens(usage),
  };
}

export function shouldAbortForUsage(
  summary: UsageSummary | undefined,
  config: ProductionConfig,
) {
  const usage = summary?.aggregateUsage ?? summary?.usage;
  if (!usage) return false;
  if (
    config.maxTotalTokens !== undefined &&
    totalTokens(usage) > config.maxTotalTokens
  )
    return true;
  if (
    config.maxSessionCostUsd !== undefined &&
    totalCost(usage) > config.maxSessionCostUsd
  )
    return true;
  if (
    config.maxInputTokens !== undefined &&
    usageTotalInputTokens(usage) > config.maxInputTokens
  )
    return true;
  if (
    config.maxOutputTokens !== undefined &&
    usageTotalOutputTokens(usage) > config.maxOutputTokens
  )
    return true;
  return false;
}

export function usageLimitMessage(
  summary: UsageSummary | undefined,
  config: ProductionConfig,
) {
  const usage = summary?.aggregateUsage ?? summary?.usage;
  if (!usage) return "Usage limit exceeded.";
  if (
    config.maxTotalTokens !== undefined &&
    totalTokens(usage) > config.maxTotalTokens
  ) {
    return `Total token limit exceeded (${config.maxTotalTokens})`;
  }
  if (
    config.maxSessionCostUsd !== undefined &&
    totalCost(usage) > config.maxSessionCostUsd
  ) {
    return `Cost limit exceeded ($${config.maxSessionCostUsd.toFixed(2)})`;
  }
  if (
    config.maxInputTokens !== undefined &&
    usageTotalInputTokens(usage) > config.maxInputTokens
  ) {
    return `Input token limit exceeded (${config.maxInputTokens})`;
  }
  if (
    config.maxOutputTokens !== undefined &&
    usageTotalOutputTokens(usage) > config.maxOutputTokens
  ) {
    return `Output token limit exceeded (${config.maxOutputTokens})`;
  }
  return "Usage limit exceeded.";
}

export function safeLogPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => allowedLogKeys.has(key) && !secretKeys.includes(key))
      .map(([key, field]) => [key, safeLogValue(key, field)])
      .filter(
        (entry): entry is [string, string | number | boolean] =>
          entry[1] !== undefined,
      ),
  );
}

function safeLogValue(
  key: string,
  value: unknown,
): string | number | boolean | undefined {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string" || !stableStringLogKeys.has(key))
    return undefined;
  const sanitizedValue = sanitizeText(value);
  if (stableStringPattern.test(sanitizedValue)) return sanitizedValue;
  return undefined;
}

function positiveNumber(value: string | undefined, fallback?: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value !== "false";
}

function compactionStrategy(value: string | undefined) {
  return value === "basic" ? "basic" : "agentic";
}

function configExtensions(value: string | undefined) {
  const allowed = new Set<AgentRuntimeConfigExtension>([
    "plugins",
    "rules",
    "skills",
    "workflows",
  ]);
  const values = listValue(value).filter(
    (entry): entry is AgentRuntimeConfigExtension =>
      allowed.has(entry as AgentRuntimeConfigExtension),
  );
  return values.length ? values : undefined;
}

function listValue(value: string | undefined) {
  if (!value) return [];
  return value
    .split(delimiter)
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function setDefaultEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  value: number | undefined,
) {
  if (value === undefined || env[key]) return;
  env[key] = String(value);
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function totalTokens(usage: UsageTotals) {
  return usageTotalInputTokens(usage) + usageTotalOutputTokens(usage);
}

function totalCost(usage: UsageTotals) {
  return usageTotalCost(usage);
}

function usageCost(usage: UsageTotals) {
  return "cost" in usage ? usage.cost : undefined;
}

function usageTotalCost(usage: UsageTotals) {
  return numberValue(usage.totalCost ?? usageCost(usage));
}

function usageTotalInputTokens(usage: UsageTotals) {
  return numberValue(
    "totalInputTokens" in usage ? usage.totalInputTokens : usage.inputTokens,
  );
}

function usageTotalOutputTokens(usage: UsageTotals) {
  return numberValue(
    "totalOutputTokens" in usage ? usage.totalOutputTokens : usage.outputTokens,
  );
}

function usageTotalCacheReadTokens(usage: UsageTotals) {
  return numberValue(
    "totalCacheReadTokens" in usage
      ? usage.totalCacheReadTokens
      : usage.cacheReadTokens,
  );
}

function usageTotalCacheWriteTokens(usage: UsageTotals) {
  return numberValue(
    "totalCacheWriteTokens" in usage
      ? usage.totalCacheWriteTokens
      : usage.cacheWriteTokens,
  );
}

function isPathInside(path: string, parent: string) {
  const pathRelativeToParent = relative(parent, path);
  return (
    pathRelativeToParent === "" ||
    (!pathRelativeToParent.startsWith("..") &&
      !isAbsolute(pathRelativeToParent))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
