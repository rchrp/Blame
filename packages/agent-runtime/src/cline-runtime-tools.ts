import { randomUUID } from "node:crypto";

import type { ClineCore, CoreCompactionConfig } from "@cline/sdk";

import {
  createDelegatedAgentConfigProvider,
  createSpawnAgentTool,
} from "@cline/sdk";

import { type AgentTool } from "./cline-initialization.js";

import { productionLogger } from "./cline-runtime-configuration.js";

import { asRecord, stringValue } from "./cline-runtime-events.js";

import { blockedCommandParts } from "./cline-tool-policy.js";

import { createFinishTaskTool } from "./harness/finish-task.js";

import {
  type LightCompletionNotification,
  type LightValidationActivity,
} from "./harness/light-completion.js";

import type { LightTaskContract } from "./harness/light-contracts.js";

import { type LightWorkspaceExecutor } from "./harness/light-executor.js";

import {
  lightReadToolNames,
  lightSemanticHarnessTools,
} from "./harness/light-tools.js";

import { type ProjectMemoryPersistence } from "./harness/project-memory.js";

import {
  previewContainerLogsTool,
  previewDevtoolsTool,
  previewInitializationRepairTool,
  type PreviewRuntimeContext,
  type PreviewToolRuntimeOptions,
} from "./preview-harness-tools.js";

import { reasoningConfig } from "./reasoning.js";

import { createConsultSpecialistTool } from "./specialist-consult-tool.js";

import { supplementalModelConfig } from "./supplemental-model-config.js";

import type {
  AgentApprovalRequest,
  AgentBackendConfig,
  PreviewManifest,
  ProjectInitializationDatabaseMode,
  ProjectRunConfiguration,
  StartDevelopmentSessionInput,
  StartSessionInput,
} from "./types.js";

export type ToolApprovalRequest = {
  toolName?: string;
  name?: string;
  sessionId?: string;
  reason?: string;
  input?: unknown;
};

export type RuntimeStartSessionInput = StartSessionInput & {
  clineDefaultTools?: boolean;
  compaction?: CoreCompactionConfig;
  enableAgentTeams?: boolean;
  enableBuiltInSkills?: boolean;
  enableSpecialistConsult?: boolean;
  enableSpawnAgent?: boolean;
  nativeCompletion?: boolean;
  taskObjective?: string;
  projectInitialization?: StartDevelopmentSessionInput["projectInitialization"];
};

export type RuntimeOptions = PreviewToolRuntimeOptions & {
  applyPreviewInitialization?(input: {
    databaseMode: ProjectInitializationDatabaseMode;
    reason: string;
    repairSessionId: string;
    previewManifest: PreviewManifest;
    runConfigurations: ProjectRunConfiguration[];
    scope?: string;
    storyId?: string;
    workspaceMode?: "local-container" | "cloud-mirror" | "direct";
    worktree: string;
  }): Promise<{ status: "applied" | "unavailable" }>;
  createCore?(backend?: AgentBackendConfig): Promise<ClineCore>;
  developmentHarness?: "blame" | "cline";
  openExternalUrl?(url: string): void;
  git?(cwd: string, args: string[]): Promise<string>;
  lightWorkspace?: LightWorkspaceExecutor;
  modelInactivityTimeoutMs?: number;
  projectMemoryPersistence?: ProjectMemoryPersistence;
};

export function runtimeTools(
  options: RuntimeOptions,
  worktree?: string,
  previewContext?: PreviewRuntimeContext,
  taskContract?: LightTaskContract,
  executor?: LightWorkspaceExecutor,
  completion?: {
    conversationId: string;
    onComplete(notification: LightCompletionNotification): void;
    onValidationActivity(activity: LightValidationActivity): Promise<void>;
  },
  previewMcpTools: AgentTool[] = [],
  initialTaskBriefing?: string,
) {
  void initialTaskBriefing;
  const tools = [
    ...lightSemanticHarnessTools(worktree, {
      executor,
      taskContract,
      ...(options.refreshPreviewDependencies && previewContext
        ? {
            refreshPreviewDependencies: () =>
              Promise.resolve(
                options.refreshPreviewDependencies!(previewContext),
              ),
          }
        : {}),
    }),
    ...(completion
      ? [
          createFinishTaskTool({
            conversationId: completion.conversationId,
            executor,
            taskContract,
            workspaceRoot: worktree ?? "",
            onComplete: completion.onComplete,
            onValidationActivity: completion.onValidationActivity,
          }),
        ]
      : []),
    previewDevtoolsTool(options, previewContext),
    previewInitializationRepairTool(options, previewContext),
    previewContainerLogsTool(options, previewContext),
    ...previewMcpTools,
  ].filter((tool): tool is AgentTool => Boolean(tool));
  return tools.length ? tools : undefined;
}

export function readOnlyRuntimeTools(
  options: RuntimeOptions,
  worktree: string,
  previewContext: PreviewRuntimeContext,
  taskContract: LightTaskContract,
  executor?: LightWorkspaceExecutor,
  initialTaskBriefing?: string,
) {
  const allowedTools = new Set([
    ...lightReadToolNames,
    "get_preview_devtools",
    "get_preview_container_logs",
  ]);
  return (
    runtimeTools(
      options,
      worktree,
      previewContext,
      taskContract,
      executor,
      undefined,
      [],
      initialTaskBriefing,
    ) ?? []
  ).filter((tool) => allowedTools.has(tool.name));
}

export function runtimeConsultSpecialistTool(options: {
  credential: {
    apiKey: string;
    baseUrl: string | null;
  };
  input: RuntimeStartSessionInput;
  initialTaskBriefing?: string;
  objective?: string;
  readOnlyTools: AgentTool[];
}) {
  return createConsultSpecialistTool({
    capsule: specialistCapsuleProvider(options),
    objective: options.objective,
    spawnTool: specialistSpawnTool(options),
    storyId: options.input.storyId,
    timeoutMs: adaptiveSpecialistTimeoutMs(
      specialistReasoningEffort(options.input.reasoningEffort),
    ),
  });
}

function specialistSpawnTool(options: {
  credential: { apiKey: string; baseUrl: string | null };
  input: RuntimeStartSessionInput;
  readOnlyTools: AgentTool[];
}) {
  const configProvider = createDelegatedAgentConfigProvider(
    supplementalModelConfig({
      providerId: options.input.providerId,
      modelId: options.input.modelId,
      apiKey: options.credential.apiKey,
      baseUrl: options.credential.baseUrl ?? undefined,
      ...reasoningConfig(
        specialistReasoningEffort(options.input.reasoningEffort),
      ),
      cwd: options.input.cwd,
      maxIterations: 16,
    }),
  );
  const spawnTool = createSpawnAgentTool({
    configProvider,
    defaultMaxIterations: 16,
    subAgentTools: options.readOnlyTools,
    toolPolicies: Object.fromEntries(
      options.readOnlyTools.map((tool) => [
        tool.name,
        { enabled: true, autoApprove: true },
      ]),
    ),
    logger: productionLogger,
  });
  return spawnTool;
}

function specialistCapsuleProvider(options: {
  input: RuntimeStartSessionInput;
  initialTaskBriefing?: string;
  objective?: string;
}) {
  return async (consultation: { task: string }) => {
    const briefing = options.initialTaskBriefing
      ? `<runtime_task_briefing>\n${options.initialTaskBriefing}\n</runtime_task_briefing>`
      : undefined;
    const request = JSON.stringify({
      objective: options.objective,
      specialistTask: consultation.task,
    });
    return [`<specialist_request>${request}</specialist_request>`, briefing]
      .filter(Boolean)
      .join("\n\n");
  };
}

function specialistReasoningEffort(
  effort: RuntimeStartSessionInput["reasoningEffort"],
) {
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

function adaptiveSpecialistTimeoutMs(reasoningEffort: unknown) {
  const effort = String(reasoningEffort ?? "").toLowerCase();
  if (effort === "ultra") return 360_000;
  if (effort === "max") return 300_000;
  if (effort === "xhigh") return 240_000;
  if (effort === "high") return 180_000;
  if (effort === "medium") return 120_000;
  return 90_000;
}

export function toApprovalRequest(
  request: ToolApprovalRequest,
  toolName: string,
): AgentApprovalRequest {
  return {
    id: randomUUID(),
    sessionId: request.sessionId,
    toolName,
    reason: request.reason,
    input: request.input,
  };
}

export function blockedToolReason(toolName: string, input: unknown) {
  if (toolName !== "run_commands") return undefined;
  const command = stringValue(asRecord(input).command);
  if (!command) return undefined;
  return blockedCommandParts.some((part) => command.includes(part))
    ? "Command blocked by security policy"
    : undefined;
}
