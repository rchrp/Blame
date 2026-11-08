import { randomUUID } from "node:crypto";
import { previewEnvironmentTool } from "./preview-environment-tool.js";
import { attachmentTools } from "./attachment-tools.js";

import type { ClineCore, CoreCompactionConfig } from "@cline/sdk";

import {
  createDelegatedAgentConfigProvider,
  createSpawnAgentTool,
} from "@cline/sdk";

import { type AgentTool } from "./cline-initialization.js";

import { productionLogger } from "./cline-runtime-configuration.js";

import { asRecord, stringValue } from "./cline-runtime-events.js";

import { blockedCommandParts } from "./cline-tool-policy.js";

import {
  createFinishTaskTool,
  type FinishTaskScreenshots,
} from "./harness/finish-task.js";
import { sessionScreenshotIds } from "./preview-screenshots.js";
import {
  componentPreviewFilePatterns,
  componentPreviewPathspecs,
  componentPreviewTool,
} from "./component-preview-tool.js";

import {
  type LightCompletionNotification,
  type LightValidationActivity,
} from "./harness/light-completion.js";

import type {
  LightCommandCredentials,
  LightTaskContract,
} from "./harness/light-contracts.js";
import type { AgentPersonalization, ResponseStyle } from "./personalization.js";

import { type LightWorkspaceExecutor } from "./harness/light-executor.js";

import { withGithubCli } from "./harness/github-cli.js";

import {
  lightReadToolNames,
  lightSemanticHarnessTools,
} from "./harness/light-tools.js";

import { type ProjectMemoryPersistence } from "./harness/project-memory.js";

import {
  previewContainerLogsTool,
  previewDevtoolsTool,
  previewInitializationRepairTool,
  projectAppTool,
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
  // A compacted working context to resume from (manual compaction).
  initialCompactionState?: import("@cline/sdk").SessionCompactionState;
  clineDefaultTools?: boolean;
  compaction?: CoreCompactionConfig;
  // Tools a conversation adds, and the ones it keeps (see conversation-purpose).
  conversationTools?: AgentTool[];
  toolFilter?: (name: string) => boolean;
  enableAgentTeams?: boolean;
  enableBuiltInSkills?: boolean;
  enableSpecialistConsult?: boolean;
  enableSpawnAgent?: boolean;
  nativeCompletion?: boolean;
  personalization?: AgentPersonalization;
  taskObjective?: string;
  projectInitialization?: StartDevelopmentSessionInput["projectInitialization"];
};

export type RuntimeOptions = PreviewToolRuntimeOptions & {
  renderWebPage?: import('./web-research-types.js').RenderWebPage;
  // A readable copy of a workspace the runtime cannot read directly.
  projectScanRoot?: import("./project-initialization.js").ProjectScanRootProvider;
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
  // Runs the GitHub CLI on this computer for Open PR; gh by default.
  gh?(cwd: string, args: string[]): Promise<string>;
  lightWorkspace?: LightWorkspaceExecutor;
  /**
   * The credentials the desktop grants a session's commands when they run in
   * this process (cloud sessions): a GitHub App token limited to the
   * project's repository, or none.
   */
  commandCredentials?(sessionId: string): Promise<LightCommandCredentials>;
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
    responseStyle?: () => ResponseStyle;
  },
  previewMcpTools: AgentTool[] = [],
  initialTaskBriefing?: string,
) {
  void initialTaskBriefing;
  const componentPreview = componentPreviewTool(options, previewContext);
  const tools = [
    ...attachmentTools(worktree, executor),
    ...lightSemanticHarnessTools(worktree, {
      executor,
      taskContract,
      ...cloudCommandCredentials(options, previewContext, taskContract, executor),
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
            responseStyle: completion.responseStyle,
            screenshots: finishScreenshots(
              options,
              completion.conversationId,
              previewContext,
            ),
            ...(componentPreview && worktree
              ? {
                  cleanup: () =>
                    finishComponentPreviews(
                      options,
                      worktree,
                      completion.conversationId,
                    ),
                }
              : {}),
            taskContract,
            workspaceRoot: worktree ?? "",
            onComplete: completion.onComplete,
            onValidationActivity: completion.onValidationActivity,
          }),
        ]
      : []),
    previewDevtoolsTool(options, previewContext),
    componentPreview,
    ...(previewContext?.workspaceMode === "direct"
      ? // The project's own app: no managed container to repair or read.
        [projectAppTool(options, previewContext)]
      : [
          previewInitializationRepairTool(options, previewContext),
          previewContainerLogsTool(options, previewContext),
          previewEnvironmentTool(options, previewContext),
        ]),
    ...previewMcpTools,
  ].filter((tool): tool is AgentTool => Boolean(tool));
  return tools.length ? tools : undefined;
}
// Cloud sessions run the agent's commands in this process, on the host: they
// ask the desktop for the session's credentials before each one, and get the
// gh Blame provides with them. Managed runtime requests get theirs from the
// desktop on the way, and the runtime's own gh.
function cloudCommandCredentials(
  options: RuntimeOptions,
  previewContext: PreviewRuntimeContext | undefined,
  taskContract: LightTaskContract | undefined,
  executor: LightWorkspaceExecutor | undefined,
) {
  const sessionId = taskContract?.session_id;
  const credentials = options.commandCredentials;
  if (
    executor ||
    !credentials ||
    !sessionId ||
    previewContext?.workspaceMode !== "cloud-mirror"
  )
    return {};
  return {
    commandCredentials: async () => withGithubCli(await credentials(sessionId)),
  };
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
    "read_attachment",
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
    createSpawnTool: (onSubAgentEvent) =>
      specialistSpawnTool(options, onSubAgentEvent),
    storyId: options.input.storyId,
    timeoutMs: adaptiveSpecialistTimeoutMs(
      specialistReasoningEffort(options.input.reasoningEffort),
    ),
  });
}

function specialistSpawnTool(
  options: {
    credential: { apiKey: string; baseUrl: string | null };
    input: RuntimeStartSessionInput;
    readOnlyTools: AgentTool[];
  },
  onSubAgentEvent?: (event: unknown) => void,
) {
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
    ...(onSubAgentEvent ? { onSubAgentEvent } : {}),
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

// Screenshots this conversation took in this process, then, for a
// resumed conversation, those the desktop app stored for it.
function finishScreenshots(
  options: RuntimeOptions,
  conversationId: string,
  previewContext?: PreviewRuntimeContext,
): FinishTaskScreenshots {
  return {
    async unknown(ids, context) {
      const sessionId =
        context.sessionId ?? context.conversationId ?? conversationId;
      const known = sessionScreenshotIds(sessionId);
      const missing = ids.filter((id) => !known.has(id));
      if (!missing.length || !options.previewScreenshotKnown) return missing;
      const found = await Promise.all(
        missing.map((id) =>
          Promise.resolve(
            options.previewScreenshotKnown!({
              id,
              scope: previewContext?.scope,
              sessionId,
            }),
          ).catch(() => false),
        ),
      );
      return missing.filter((_, index) => !found[index]);
    },
  };
}

// finish_task removes the preview files, then stops the component preview
// server: stopping a cloud preview's server also sends their removal to its
// sandbox. A failure is reported in the answer, never blocks the finish.
export async function finishComponentPreviews(
  options: Pick<RuntimeOptions, "componentPreview" | "git">,
  worktree: string,
  sessionId: string,
) {
  const removed = options.git
    ? await removePreviewScratch(options.git, worktree)
    : undefined;
  const stopped = await Promise.resolve(
    options.componentPreview?.({ action: "stop", sessionId, worktree }),
  ).then(
    () => undefined,
    (error: unknown) =>
      `The component preview server did not stop: ${error instanceof Error ? error.message : String(error)}`,
  );
  return [removed, stopped].filter(Boolean).join("\n") || undefined;
}

// Temporary component previews never outlive the task: finish_task removes
// them and says how many it removed. Tracked files are never touched, nor
// files the project itself ignores, such as a framework's build output.
export async function removePreviewScratch(
  git: (cwd: string, args: string[]) => Promise<string>,
  worktree: string,
) {
  const listed = (output: string) => output.split("\0").filter(Boolean);
  const [untracked, ignored] = await Promise.all([
    git(worktree, [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ...componentPreviewPathspecs,
    ]).then(listed),
    git(worktree, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      ...componentPreviewPathspecs,
    ]).then(listed),
  ]);
  const ours = ignored.length
    ? await ignoredByPreviewRules(git, worktree, ignored)
    : [];
  const files = [...new Set([...untracked, ...ours])];
  if (!files.length) return undefined;
  for (let index = 0; index < files.length; index += 200)
    await git(worktree, [
      "clean",
      "-f",
      "-x",
      "--",
      ...files.slice(index, index + 200).map((file) => `:(literal)${file}`),
    ]);
  return `Removed ${files.length} temporary preview ${files.length === 1 ? "file" : "files"}.`;
}

// Keeps the ignored files whose deciding rule is one of the preview patterns.
async function ignoredByPreviewRules(
  git: (cwd: string, args: string[]) => Promise<string>,
  worktree: string,
  files: string[],
) {
  const result: string[] = [];
  for (const file of files.slice(0, 500)) {
    const output = await git(worktree, [
      "check-ignore",
      "-v",
      "--",
      file,
    ]).catch(() => "");
    // source:line:pattern<TAB>path
    const pattern = output.match(/^.*:\d+:(.*)\t/u)?.[1];
    if (pattern && componentPreviewFilePatterns.includes(pattern))
      result.push(file);
  }
  return result;
}
