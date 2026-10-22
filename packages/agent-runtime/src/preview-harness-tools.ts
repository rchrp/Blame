import type { CoreSessionConfig } from "@cline/sdk";
import { createMcpTools } from "@cline/sdk";
import { currentWorkspaceRevisionState } from "./harness/workspace-revisions.js";
import { sha256 } from "./harness/light-identity.js";

type AgentTool = NonNullable<CoreSessionConfig["extraTools"]>[number];
type ToolContext = Parameters<AgentTool["execute"]>[1];

export type PreviewDevtoolsTarget = {
  application?: {
    status: "ready" | "failed" | "unverified";
    httpStatus?: number;
    diagnostic?: string;
  };
  available: boolean;
  currentUrl?: string;
  error?: string;
  id?: string;
  lifecycle?: unknown;
  loading: boolean;
  visible?: boolean;
  message: string;
  reason: string;
  readiness?: {
    browser_ready: boolean;
    container_ready: boolean;
    application_ready: boolean;
  };
  revisions?: {
    source_revision_id: string;
    environment_revision_id: string;
    dependencies_ready: boolean;
  };
  scope?: string;
  status: "failed" | "ready" | "starting" | "stopped" | "unavailable";
};

export type PreviewRuntimeContext = {
  scope?: string;
  storyId?: string;
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
  worktree: string;
};

export type PreviewDependencyRefreshResult = {
  diagnostic?: string;
  readiness?: PreviewDevtoolsTarget["readiness"];
  revisions?: PreviewDevtoolsTarget["revisions"];
  status: "failed" | "not_running" | "ready";
};

export type PreviewInitializationRepairResult = {
  classification: string;
  reason: string;
  status: "applied" | "not_repairable" | "unavailable";
};

type PreviewDevtoolsToolDescriptor = {
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

type PreviewDevtoolsTargetInput = PreviewRuntimeContext & {
  signal?: AbortSignal;
  waitFor: "none" | "ready";
};

type PreviewDevtoolsProviderInput = PreviewRuntimeContext & {
  signal?: AbortSignal;
};

type PreviewDevtoolsCallInput = PreviewDevtoolsProviderInput & {
  arguments?: Record<string, unknown>;
  toolName: string;
};

type PreviewContainerLogsInput = PreviewRuntimeContext & {
  service?: string;
  signal?: AbortSignal;
  tailLines?: number;
};

export type PreviewToolRuntimeOptions = {
  previewContainerLogs?(
    input: PreviewContainerLogsInput,
  ): Promise<unknown> | unknown;
  previewDevtools?(
    input: PreviewDevtoolsTargetInput,
  ):
    | Promise<PreviewDevtoolsTarget | undefined>
    | PreviewDevtoolsTarget
    | undefined;
  previewDevtoolsCall?(
    input: PreviewDevtoolsCallInput,
  ): Promise<unknown> | unknown;
  previewDevtoolsTools?(
    input: PreviewDevtoolsProviderInput,
  ):
    | Promise<readonly PreviewDevtoolsToolDescriptor[]>
    | readonly PreviewDevtoolsToolDescriptor[];
  refreshPreviewDependencies?(
    input: PreviewDevtoolsProviderInput,
  ): Promise<PreviewDependencyRefreshResult> | PreviewDependencyRefreshResult;
  repairPreviewInitialization?(
    input: PreviewDevtoolsProviderInput,
  ):
    | Promise<PreviewInitializationRepairResult>
    | PreviewInitializationRepairResult;
};

type PreviewToolsLogger = {
  log(message: string, payload?: Record<string, unknown>): void;
};

type PreviewSessionContextInput = {
  previewDevtoolsScope?: string;
  storyId?: string;
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
  workspaceRoot: string;
};

export function previewRuntimeContext(
  input: PreviewSessionContextInput,
): PreviewRuntimeContext {
  return {
    ...(input.previewDevtoolsScope
      ? { scope: input.previewDevtoolsScope }
      : {}),
    ...(input.storyId ? { storyId: input.storyId } : {}),
    ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
    worktree: input.workspaceRoot,
  };
}

export async function previewDevtoolsMcpTools(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext,
  logger: PreviewToolsLogger,
): Promise<AgentTool[]> {
  if (!preview.scope || !mcpAvailable(options)) return [];
  try {
    return await createMcpTools({
      maxRetries: 0,
      nameTransform: ({ toolName }: { toolName: string }) =>
        `preview_devtools__${toolName}`,
      provider: previewMcpProvider(options, preview),
      retryable: false,
      serverName: "preview-devtools",
      timeoutMs: 20_000,
    });
  } catch (error) {
    logger.log("Preview DevTools MCP tools unavailable", {
      error: errorMessage(error),
    });
    return [];
  }
}

function mcpAvailable(options: PreviewToolRuntimeOptions) {
  return Boolean(
    options.previewDevtools &&
    options.previewDevtoolsCall &&
    options.previewDevtoolsTools,
  );
}

function previewMcpProvider(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext,
) {
  return {
    async listTools() {
      return options.previewDevtoolsTools!(preview);
    },
    async callTool(request: {
      arguments?: Record<string, unknown>;
      context?: ToolContext;
      toolName: string;
    }) {
      const signal = request.context?.signal;
      const target = await options.previewDevtools?.({
        ...preview,
        signal,
        waitFor: "none",
      });
      if (!target || target.status !== "ready" || !target.available)
        return previewNotReadyResult(target);
      const evidence = await currentPreviewEvidence(preview, target);
      if (evidence.status !== "passed")
        return previewEvidenceUnavailableResult();
      const result = await callPreviewTool(options, preview, request, signal);
      return attachPreviewEvidence(result, evidence);
    },
  };
}

async function callPreviewTool(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext,
  request: { arguments?: Record<string, unknown>; toolName: string },
  signal?: AbortSignal,
) {
  const input = {
    ...preview,
    arguments: request.arguments,
    signal,
    toolName: request.toolName,
  };
  try {
    return await options.previewDevtoolsCall!(input);
  } catch (error) {
    if (!transientDevtoolsFailure(error) || signal?.aborted) throw error;
    return previewToolUnavailableResult(error);
  }
}

function previewToolUnavailableResult(error: unknown) {
  return {
    content: [
      {
        type: "text",
        text: `Preview DevTools is temporarily unavailable: ${errorMessage(error)}`,
      },
    ],
    isError: false,
    outcome: "unavailable",
    reason: "PREVIEW_DEVTOOLS_TRANSIENT_FAILURE",
    recommendation:
      "Continue with local validation. Retry browser inspection only after managed preview state changes; do not start replacement infrastructure.",
    retryable: false,
  };
}

function previewNotReadyResult(target: PreviewDevtoolsTarget | undefined) {
  const status = target?.status ?? "unavailable";
  return {
    content: [
      {
        type: "text",
        text: target?.message ?? "Preview readiness evidence is unavailable.",
      },
    ],
    isError: false,
    outcome: "unavailable",
    reason: target?.reason ?? "PREVIEW_NOT_READY",
    recommendation: previewDevtoolsRecommendation(status),
    retryable: status === "starting",
  };
}

function previewEvidenceUnavailableResult() {
  return {
    content: [
      {
        type: "text",
        text: "Application readiness is unavailable for the current source and environment revisions.",
      },
    ],
    isError: false,
    outcome: "unavailable",
    reason: "PREVIEW_REVISION_EVIDENCE_UNAVAILABLE",
    retryable: false,
  };
}

function transientDevtoolsFailure(error: unknown) {
  return /econnreset|navigation|session closed|target closed|temporar|timed?\s*out|(?:connection|transport|channel) (?:closed|disconnected)|not connected|server (?:closed|disconnected|terminated)|scoped preview page is no longer available/iu.test(
    errorMessage(error),
  );
}

function attachPreviewEvidence(result: unknown, evidence: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return result;
  const value = result as Record<string, unknown>;
  return {
    ...value,
    _meta: { ...recordValue(value._meta), previewReadyEvidence: evidence },
  };
}

export function previewDevtoolsTool(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext | undefined,
): AgentTool | undefined {
  if (!options.previewDevtools || !preview) return undefined;
  return {
    name: "get_preview_devtools",
    description:
      "Inspect browser, container, and application readiness for this session's Blame preview. Readiness requires an exploitable HTTP response, no blocking compiler diagnostic, usable dependencies, and the current source and environment revisions. For a stopped or starting local preview, waitFor=ready follows managed startup until it succeeds or reports an explicit failure. Once running, application readiness is bounded to 2 seconds. Failed, hidden, and unopened browser states return immediately.",
    inputSchema: previewDevtoolsInputSchema(),
    execute: (input: unknown, context: ToolContext) =>
      executePreviewDevtoolsTool(options, preview, input, context.signal),
  };
}

export function previewInitializationRepairTool(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext | undefined,
): AgentTool | undefined {
  if (!options.repairPreviewInitialization || !preview) return undefined;
  return {
    name: "repair_preview_initialization",
    description:
      "Reconcile this story's managed preview manifest with newly introduced runtime dependencies or services, such as a database. Use only when preview diagnostics indicate that the persisted initialization topology is obsolete. Blame diagnoses, validates, applies, and restarts the managed preview.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => options.repairPreviewInitialization!(preview),
  };
}

function previewDevtoolsInputSchema() {
  return {
    type: "object",
    properties: {
      waitFor: {
        type: "string",
        enum: ["none", "ready"],
        default: "none",
        description:
          "Use none to return the current state immediately. Use ready to start or follow a managed preview until startup succeeds or explicitly fails; the running application's readiness probe is limited to 2 seconds.",
      },
    },
    additionalProperties: false,
  };
}

async function executePreviewDevtoolsTool(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext,
  input: unknown,
  signal?: AbortSignal,
) {
  const target = await options.previewDevtools?.(
    previewDevtoolsInput(input, preview, signal),
  );
  if (!target) throw new Error("Preview state is unavailable.");
  const previewReadyEvidence = await currentPreviewEvidence(preview, target);
  return {
    ...target,
    preview_ready_evidence: previewReadyEvidence,
    recommendation: previewDevtoolsRecommendation(target.status),
    usage: target.available
      ? "Use the preview_devtools__* tools directly; Blame scopes every call to this preview page."
      : undefined,
  };
}

async function currentPreviewEvidence(
  preview: PreviewRuntimeContext,
  target: PreviewDevtoolsTarget,
) {
  try {
    const current = await currentWorkspaceRevisionState(preview.worktree);
    const revisionMatch = sameRevisionPair(current, target.revisions);
    const passed =
      target.status === "ready" &&
      target.available &&
      target.readiness?.application_ready === true &&
      current.dependencies_ready &&
      revisionMatch;
    return {
      status: passed ? ("passed" as const) : ("unavailable" as const),
      scope: "preview_application" as const,
      application_health: target.application?.status ?? "unverified",
      source_revision_id: current.source_revision_id,
      environment_revision_id: current.environment_revision_id,
      preview_revision_match: revisionMatch,
      evidence_ref: `preview-application-ready://${sha256(
        `${current.source_revision_id}\0${current.environment_revision_id}\0${target.status}`,
      )}`,
    };
  } catch {
    return {
      status: "unavailable" as const,
      scope: "preview_application" as const,
      application_health: "unverified" as const,
      source_revision_id: undefined,
      environment_revision_id: undefined,
      preview_revision_match: false,
      evidence_ref: `preview-application-ready://${sha256(`${preview.worktree}\0unavailable`)}`,
    };
  }
}

function sameRevisionPair(
  current: Awaited<ReturnType<typeof currentWorkspaceRevisionState>>,
  preview: PreviewDevtoolsTarget["revisions"],
) {
  return (
    preview?.dependencies_ready === true &&
    preview.source_revision_id === current.source_revision_id &&
    preview.environment_revision_id === current.environment_revision_id
  );
}

function previewDevtoolsInput(
  input: unknown,
  preview: PreviewRuntimeContext,
  signal?: AbortSignal,
): PreviewDevtoolsTargetInput {
  return {
    ...preview,
    signal,
    waitFor: recordValue(input).waitFor === "ready" ? "ready" : "none",
  };
}

function previewDevtoolsRecommendation(
  status: PreviewDevtoolsTarget["status"],
) {
  if (status === "starting") {
    return "Call again with waitFor=ready only if blocking for startup is useful; otherwise continue other work.";
  }
  if (status === "stopped")
    return "The managed preview is stopped. Call once with waitFor=ready when visual evidence matters; do not start a replacement server, database, or container.";
  if (status === "failed") {
    return "Inspect managed preview logs once. If project changes made the persisted runtime topology obsolete, call repair_preview_initialization; otherwise continue with local validation. Do not create replacement infrastructure manually.";
  }
  if (status === "unavailable") {
    return "Preview evidence is unavailable. Continue with local validation and report the limitation; do not start manual infrastructure.";
  }
  return "The application and its revision pair are ready. Take a scoped DOM snapshot for UI assertions.";
}

export function previewContainerLogsTool(
  options: PreviewToolRuntimeOptions,
  preview?: PreviewRuntimeContext,
): AgentTool | undefined {
  if (!options.previewContainerLogs || !preview) return undefined;
  return {
    name: "get_preview_container_logs",
    description:
      "Get state-aware logs for this session's Blame preview. Stopped previews return immediately without a container query. Local previews return available compose services, recent stdout and stderr, or the archived setup log; managed previews identify the live log stream. Defaults to the first preview service and 120 tail lines.",
    inputSchema: previewContainerLogsInputSchema(),
    execute: (input: unknown, context: ToolContext) =>
      executePreviewContainerLogs(options, preview, input, context.signal),
  };
}

async function executePreviewContainerLogs(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext,
  input: unknown,
  signal?: AbortSignal,
) {
  try {
    return await options.previewContainerLogs?.({
      ...preview,
      ...previewContainerLogsInput(input),
      signal,
    });
  } catch (error) {
    return {
      outcome: "failed",
      reason: "PREVIEW_LOG_READ_FAILED",
      recommendation:
        "Continue with local validation. Retry logs only after preview state changes.",
      isError: true,
      output: { error: errorMessage(error) },
    };
  }
}

function previewContainerLogsInputSchema() {
  return {
    type: "object",
    properties: {
      service: {
        type: "string",
        description:
          "Optional compose service name to read logs for. When omitted, Blame selects the first preview service, matching the preview drawer.",
      },
      tailLines: {
        type: "number",
        description:
          "Maximum number of recent log lines to return from live containers. Defaults to 120 and is capped at 1000.",
      },
    },
    additionalProperties: false,
  };
}

function previewContainerLogsInput(input: unknown) {
  const record = recordValue(input);
  const service = stringValue(record.service);
  return {
    ...(service ? { service } : {}),
    tailLines: boundedNumber(record.tailLines, 1, 1000) ?? 120,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
