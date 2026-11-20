import { randomUUID } from "node:crypto";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { imageAwareCompaction } from "./image-compaction.js";
import { contextLimitConfig } from "./context-limit-config.js";
import { compactSessionContext } from "./manual-compaction.js";
import {
  defaultPersonalization,
  normalizePersonalization,
  personalizationUpdateNote,
  type AgentPersonalization,
} from "./personalization.js";

import type { ExecutionTerminalReason } from "@blame/harness-core";
import {
  extractClineFreeModelLimitResetTime,
  getClinePassSubscriptionUrl,
  isClineFreeModelLimitError,
  isClineFreeModelLimitMessage,
  isClineModelNotFoundMessage,
  isClineNotSubscribedError,
  isClineNotSubscribedMessage,
  isClineOrgIndividualInferenceSubscriptionError,
  isClineOrgIndividualInferenceSubscriptionMessage,
  isClinePassLimitError,
  isClinePassLimitMessage,
} from "@cline/llms";
import type {
  ClineCore,
  ClineCoreStartInput,
  CoreSessionEvent,
  ContentBlock,
  Message,
  OAuthPrompt,
  OAuthProviderInterface,
  OAuthServerListeningInfo,
} from "@cline/sdk";

import type { RepairProjectInitializationTask } from "./engine/task-protocol.js";
import {
  combinedTaskBriefing,
  type AgentTool,
  type RuntimeClineResult,
  type RuntimeSessionSummary,
} from "./cline-initialization.js";
import {
  backendKey,
  blameNativePluginPath,
  clineDefaultToolPolicies,
  coreBackendOptions,
  extensionContext,
  productionLogger,
  toolPolicies,
  withConfigExtensions,
} from "./cline-runtime-configuration.js";
import {
  asRecord,
  clineSessionSpawnAgentPhase,
  clineSessionToolEvent,
  completionFailureEvent,
  doneResultPayload,
  duplicateEventSignature,
  errorMessage,
  errorType,
  eventLogPayload,
  eventTokenCount,
  eventUsageSummary,
  incompleteResultStatus,
  lightTerminalState,
  nextSpawnAgentActiveCount,
  normalizeAgentUsageSummary,
  normalizeEvent,
  normalizedToolPhase,
  numberValue,
  removeOldEventSignatures,
  resultStatus,
  retryableModelTransportFailure,
  sendResultLogPayload,
  shouldDisplayClineSessionEvent,
  streamingAgentEvent,
  stringValue,
  terminalLifecycleState,
  terminalProductMessage,
  terminalStateFromResult,
  terminalToolEvent,
  transportFailureEventMessage,
} from "./cline-runtime-events.js";
import {
  appendLog,
  sessionLogPath,
  startLogPath,
} from "./runtime-log.js";
import {
  pullRequestAvailability,
  readPullRequestState,
  runHostGh,
} from "./pull-request.js";
import {
  buildDevelopmentSystemPrompt,
  clineDefaultSystemPrompt,
  developmentUserInput,
  newAttachmentDirectory,
} from "./cline-runtime-prompts.js";
import {
  blockedToolReason,
  readOnlyRuntimeTools,
  runtimeConsultSpecialistTool,
  runtimeTools,
  toApprovalRequest,
  type RuntimeOptions,
  type RuntimeStartSessionInput,
  type ToolApprovalRequest,
} from "./cline-runtime-tools.js";
import { writeTools } from "./cline-tool-policy.js";
import {
  deleteProviderCredential,
  listProjectMemories,
  fetchCatalogModel,
  listProviders,
  resolveProviderCredential,
  saveOAuthCredential,
  saveProjectMemory,
  saveProviderCredential,
} from "./cloud-api.js";
import { USER_REJECTED_TOOL_REASON } from "@cline/shared";
import {
  clineOAuthProvider,
  forceOAuthRefresh,
  ocaOAuthProvider,
  openAICodexOAuthProvider,
  supportedClineOAuthProvider,
  toBlameOAuthCredentials,
} from "./cline-oauth-providers.js";
import {
  knownModelInfo,
  loadCatalogModel,
} from "./supplemental-model-config.js";
import {
  claudeCodeCredential,
  claudeCodeStatus,
  closeClaudeCodeBridge,
  connectClaudeCode,
} from "./claude-code/claude-code-provider.js";
import { readClaudeCodeUsage, readCodexUsage } from "./subscription-usage.js";
import { createContextProjectionExtension } from "./context-projection.js";
import {
  appendInitialTaskBriefing,
  createInitialTaskBriefing,
} from "./harness/initial-task-briefing.js";
import {
  type LightCompletionNotification,
  type LightValidationActivity,
} from "./harness/light-completion.js";
import { type FinalReply, unverifiedReply } from "./harness/light-finish-service.js";
import {
  managedLightWorkspaceExecutor,
  writeSessionJournal,
  type LightWorkspaceExecutor,
  type SessionJournalInput,
} from "./harness/light-executor.js";
import { sha256 } from "./harness/light-identity.js";
import { findDirectStoryFiles } from "./direct-story-files.js";
import {
  selectProjectMemory,
  type ProjectMemoryPersistence,
  type ProjectMemorySelection,
} from "./harness/project-memory.js";
import {
  RunLifecycleRegistry,
  completionAwareTerminalState,
  type RunTerminalState,
} from "./harness/run-lifecycle.js";
import {
  previewDevtoolsMcpTools,
  previewRuntimeContext,
  type PreviewRuntimeContext,
} from "./preview-harness-tools.js";
import { githubMcpTools } from "./github-mcp-tools.js";
import type { ProductionSessionContext } from "./production.js";
import {
  appendProductionConfig,
  applyProductionEnvironment,
  assertWorkspacePath,
  blameCheckpointConfig,
  blameCompactionConfig,
  loadProductionConfig,
  promptMetadata,
  runtimeConfigExtensions,
  runtimePluginPaths,
  shouldAbortForUsage,
  summarizeUsage,
  usageLimitMessage,
} from "./production.js";
import { loadPrompt } from "./prompt-loader.js";
import { createProviderCompatibleFetch } from "./provider-schema-compatibility.js";
import { reasoningConfig } from "./reasoning.js";
import { scanSecurityAuditRepository } from "./security-audit-scan.js";
import { developmentSpecialistConsultEnabled } from "./specialist-agents.js";
import { sessionStoryHistoryTools } from "./story-history-tools.js";
import type { RuntimeCredentialInput } from "./runtime-credential.js";
import {
  conversationSessionOptions,
  conversationWorkspace,
} from "./conversation-purpose.js";
import type {
  AgentApprovalRequest,
  AgentBackendConfig,
  AgentEvent,
  AgentRuntimeEvents,
  AgentRuntimePrewarmInput,
  AgentUsageSummary,
  CompactSessionInput,
  CompactSessionResult,
  ApiConnection,
  CompareCheckpointInput,
  CompareCheckpointResult,
  DirectStoryFilesInput,
  ConnectClaudeCodeInput,
  SubscriptionUsageInput,
  LoginOAuthProviderInput,
  MapSecurityAuditInput,
  PullRequestAvailabilityInput,
  PullRequestStateInput,
  ResolveApprovalInput,
  RestoreCheckpointInput,
  RestoreCheckpointResult,
  SaveProviderCredentialInput,
  SendDevelopmentSessionInput,
  SendSessionInput,
  StartDevelopmentSessionInput,
  StartSessionInput,
} from "./types.js";
import { BlameUserInstructionServices, skillScopeSystemPrompt } from "./user-instruction-services.js";
import { webResearchTools, webResearchGuidance } from './web-research-tools.js';
import { assertRepositoryPath, setGitRunner } from "./runtime-git.js";

export {
  backendKey,
  blameNativePluginPath,
  clineDefaultToolPolicies,
  coreBackendOptions,
} from "./cline-runtime-configuration.js";

export {
  buildDevelopmentSystemPrompt,
  developmentUserInput,
} from "./cline-runtime-prompts.js";

export {
  duplicateEventSignature,
  nextSpawnAgentActiveCount,
  normalizeClineAgentPayload,
  retryableModelTransportFailure,
  shouldDisplayClineSessionEvent,
  terminalToolEvent,
} from "./cline-runtime-events.js";
const openAICompatibleProviderID = "openai-compatible";
const runtimePrewarmSessionId = "blame-runtime-prewarm";
const stoppedApprovalReason =
  "This tool call was not executed because the session stopped before the user answered.";
const cloudProjectMemoryPersistence: ProjectMemoryPersistence = {
  list: listProjectMemories,
  save: saveProjectMemory,
};

type ToolApprovalResult = {
  approved: boolean;
  /** Model-facing reason; Cline appends its rejection guidance. */
  reason?: string;
};

type PendingApproval = {
  request: AgentApprovalRequest;
  resolve(result: ToolApprovalResult): void;
};

type DevelopmentPreviewInitialization = NonNullable<
  StartDevelopmentSessionInput["projectInitialization"]
>;

type DevelopmentPreviewState = {
  initialization: DevelopmentPreviewInitialization;
};

type SessionTermination = {
  cline: ClineCore;
  display?: boolean;
  event?: AgentEvent;
  executionId: string;
  reason: string;
  sessionId: string;
  terminalState: RunTerminalState;
  terminalReason?: ExecutionTerminalReason;
};

type SessionTerminationAttempt =
  | { status: "stopped" }
  | { error?: unknown; status: "pending" };

type SessionInactivityWatchdog = {
  cline: ClineCore;
  executionId: string;
  idleWindows: number;
  timeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
};

type SessionTransportRecovery = {
  attempts: number;
  executionId: string;
  iterationOffset?: number;
  message: string;
};

const defaultModelInactivityTimeoutMs = 180_000;
const maximumTransportRecoveryAttempts = 1;
const transportRecoveryPrompt =
  "<runtime_recovery>The provider stream closed before the response completed. Continue from the persisted session state without repeating completed reads or mutations, then resume the interrupted next action.</runtime_recovery>";

export class BlameAgentRuntime {
  private clines = new Map<string, Promise<ClineCore>>();
  private sessionBackendKeys = new Map<string, string>();
  private unsubscribers = new Map<string, () => void>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private alwaysAllowedTools = new Set<string>();
  private autoApprovedWriteToolSessions = new Set<string>();
  private sessionLogFiles = new Map<string, string>();
  private sessionLogWrites = new Map<string, Promise<void>>();
  private sessionReleases = new Map<string, Promise<void>>();
  private sessionJournalExecutors = new Map<string, LightWorkspaceExecutor>();
  private sessionContexts = new Map<string, ProductionSessionContext>();
  private sessionApiConnections = new Map<string, ApiConnection>();
  private sessionStartInputs = new Map<string, ClineCoreStartInput>();
  // What each session's agent was last told; a change goes out with the next message.
  private sessionPersonalization = new Map<string, AgentPersonalization>();
  private clineDefaultSessions = new Set<string>();
  private sessionEventSignatures = new Map<string, Map<string, number>>();
  private sessionExecutionIds = new Map<string, string>();
  private sessionToolInputs = new Map<string, unknown>();
  private sessionToolSequences = new Map<string, number>();
  private sessionCompletedToolIds = new Map<string, Set<string>>();
  private sessionSubmittedSummaries = new Map<string, FinalReply>();
  private sessionNativeFinish = new Map<
    string,
    (summary: string) => Promise<unknown>
  >();
  private sessionMemoryWrites = new Map<string, Promise<void>>();
  private sessionDeferredTaskBriefings = new Map<string, string>();
  private sessionTerminalDrains = new Map<string, Promise<void>>();
  private sessionTerminations = new Map<
    string,
    { executionId: string; promise: Promise<boolean> }
  >();
  private sessionTerminationWatchdogs = new Map<string, Promise<void>>();
  private sessionInactivityWatchdogs = new Map<
    string,
    SessionInactivityWatchdog
  >();
  private sessionActiveTools = new Map<string, Set<string>>();
  private sessionInactivityTimeouts = new Map<string, number>();
  private sessionTransportRecoveries = new Map<
    string,
    SessionTransportRecovery
  >();
  private sessionIterations = new Map<string, number>();
  private sessionSpawnAgentActiveCounts = new Map<string, number>();
  private sessionUsageSignatures = new Map<string, string>();
  private readonly runLifecycles = new RunLifecycleRegistry();
  private readonly userInstructionServices = new BlameUserInstructionServices();
  private structuredEventSessions = new Set<string>();
  private readonly productionConfig = loadProductionConfig();
  private readonly events?: AgentRuntimeEvents;
  private readonly options: RuntimeOptions;

  constructor(events?: AgentRuntimeEvents, options: RuntimeOptions = {}) {
    this.events = events;
    this.options = options;
    if (options.git) {
      setGitRunner(options.git);
    }
    applyProductionEnvironment(this.productionConfig);
    void import("@cline/sdk").catch(() => undefined);
  }

  providers = {
    list: (connection: ApiConnection) => listProviders(connection),
    saveCredential: (
      connection: ApiConnection,
      input: SaveProviderCredentialInput,
    ) => saveProviderCredential(connection, input),
    deleteCredential: (connection: ApiConnection, id: string) =>
      deleteProviderCredential(connection, { id }),
    loginOAuth: (input: LoginOAuthProviderInput) => this.loginOAuth(input),
    claudeCodeStatus: () => claudeCodeStatus(),
    connectClaudeCode: (input: ConnectClaudeCodeInput) =>
      connectClaudeCode(input),
    subscriptionUsage: async (input: SubscriptionUsageInput) =>
      input.providerId === "claude-code"
        ? readClaudeCodeUsage()
        : input.providerId === "openai-codex"
          ? readCodexUsage((await this.runtimeCredential(input)).oauthCredentials)
          : null,
  };

  prewarm = (input: AgentRuntimePrewarmInput) =>
    this.prewarmRuntimeBackend(input);

  sessions = {
    start: (input: StartSessionInput) => this.startSession(input),
    startDevelopment: (input: StartDevelopmentSessionInput) =>
      this.startDevelopmentSession(input),
    send: (input: SendSessionInput) => this.sendSession(input),
    sendDevelopment: (input: SendDevelopmentSessionInput) =>
      this.sendDevelopmentSession(input),
    abort: (sessionId: string) => this.abortSession(sessionId),
    compareCheckpoint: (input: CompareCheckpointInput) =>
      this.compareCheckpoint(input),
    list: () => this.listSessions(),
    messages: (sessionId: string) => this.readMessages(sessionId),
    restoreCheckpoint: (input: RestoreCheckpointInput) =>
      this.restoreCheckpoint(input),
    usage: (sessionId: string) => this.readUsage(sessionId),
    compact: (input: CompactSessionInput) => this.compactSession(input),
    unsubscribe: (sessionId: string) => this.unsubscribeSession(sessionId),
    releaseWorkspace: (workspace: string) =>
      this.releaseWorkspaceSessions(workspace),
  };

  approvals = {
    resolve: (input: ResolveApprovalInput) => this.resolveApproval(input),
  };

  securityAudits = {
    map: (input: MapSecurityAuditInput) => this.mapSecurityAudit(input),
  };

  pullRequestAvailability = (input: PullRequestAvailabilityInput) => {
    assertRepositoryPath(input.repositoryRoot, "repositoryRoot");
    return pullRequestAvailability(input.repositoryRoot, this.gh);
  };

  pullRequestState = (input: PullRequestStateInput) => {
    assertRepositoryPath(input.repositoryRoot, "repositoryRoot");
    return readPullRequestState(input.repositoryRoot, input.url, this.gh);
  };

  directStoryFiles = (input: DirectStoryFilesInput) => {
    assertRepositoryPath(input.root, "root");
    return findDirectStoryFiles(input);
  };

  async shutdown() {
    const sessionIds = await this.activeSessionIds();
    await Promise.allSettled(
      sessionIds.map((sessionId) => this.abortSession(sessionId, false)),
    );
    await Promise.all(
      sessionIds.map((sessionId) => this.unsubscribeSession(sessionId)),
    );
    this.resolvePendingApprovals();
    this.sessionLogFiles.clear();
    this.sessionLogWrites.clear();
    this.sessionReleases.clear();
    this.sessionTerminalDrains.clear();
    this.sessionTerminations.clear();
    this.sessionTerminationWatchdogs.clear();
    this.sessionContexts.clear();
    this.sessionJournalExecutors.clear();
    this.sessionEventSignatures.clear();
    this.sessionApiConnections.clear();
    this.sessionToolSequences.clear();
    await Promise.allSettled(this.sessionMemoryWrites.values());
    this.sessionMemoryWrites.clear();
    await this.disposeCore();
    await closeClaudeCodeBridge();
    this.userInstructionServices.stopAll();
  }

  private async core(backend?: AgentBackendConfig) {
    const key = backendKey(backend);
    const current = this.clines.get(key);
    if (current) return current;
    const next = this.createCore(backend);
    this.clines.set(key, next);
    return next;
  }

  private async createCore(backend?: AgentBackendConfig) {
    if (this.options.createCore) return this.options.createCore(backend);
    const module = await import("@cline/sdk");
    return module.ClineCore.create({
      ...coreBackendOptions(backend),
      clientName: "blame",
      toolPolicies: toolPolicies(false),
      capabilities: {
        requestToolApproval: (request: ToolApprovalRequest) =>
          this.requestApproval(request),
      },
      fetch: createProviderCompatibleFetch(globalThis.fetch, {
        requestMaxOutputTokens: this.productionConfig.requestMaxOutputTokens,
      }),
      logger: productionLogger,
    });
  }

  private async prewarmRuntimeBackend(input: AgentRuntimePrewarmInput) {
    if (input.backend.mode !== "remote") return;
    const cline = await this.core(input.backend);
    try {
      await cline.start({
        config: {
          apiKey: "blame-runtime-prewarm",
          checkpoint: { enabled: false },
          cwd: input.cwd,
          enableAgentTeams: false,
          enableSpawnAgent: true,
          enableTools: true,
          maxIterations: 1,
          mode: "act",
          modelId: "gpt-4.1",
          providerId: "openai-native",
          sessionId: runtimePrewarmSessionId,
          systemPrompt:
            "Initialize the Cline runtime without sending a prompt.",
          workspaceRoot: input.workspaceRoot,
        },
        interactive: true,
        source: "blame-runtime-prewarm",
        toolPolicies: toolPolicies(true),
      });
    } finally {
      await Promise.allSettled([
        cline.stop(runtimePrewarmSessionId),
        cline.abort(runtimePrewarmSessionId, "Blame runtime prewarm complete"),
      ]);
      await cline.delete(runtimePrewarmSessionId).catch(() => undefined);
    }
  }

  private async sessionCore(sessionId: string) {
    const key = this.sessionBackendKeys.get(sessionId);
    const current = key ? this.clines.get(key) : undefined;
    return current ?? this.core();
  }

  private attachedSession(sessionId: string | null | undefined) {
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) return undefined;
    if (!this.sessionContexts.has(normalizedSessionId)) return undefined;
    if (!this.unsubscribers.has(normalizedSessionId)) return undefined;
    const state = this.runLifecycles.state(normalizedSessionId)?.state;
    if (state === "cancelling") {
      throw new Error(
        "The previous execution is still stopping; no new model call was made.",
      );
    }
    if (state && state !== "running") return undefined;
    return { sessionId: normalizedSessionId };
  }

  private async startSession(input: RuntimeStartSessionInput) {
    assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
    const requestedSessionId = input.sessionId?.trim();
    const sessionId = requestedSessionId || createBlameSessionId();
    const executionId =
      input.executionId?.trim() || `${sessionId}:initial-execution`;
    const startLogFile = startLogPath(input.cwd);
    await appendLog(startLogFile, "start requested", startContext(input));
    const startedAt = Date.now();
    const projectMemoryPromise = this.loadProjectMemory(input);
    try {
      const [credential] = await Promise.all([
        resolveProviderCredential(input.apiConnection, {
          providerId: input.providerId,
          label: credentialLabel(input),
        }),
        loadCatalogModel(
          () =>
            fetchCatalogModel(
              input.apiConnection,
              input.providerId,
              input.modelId,
            ),
          input.providerId,
          input.modelId,
        ),
      ]);
      await appendLog(startLogFile, "credential resolved", {
        providerId: credential.providerId,
        authMethod: credential.authMethod,
        hasBaseUrl: !!credential.baseUrl,
      });
      const resolvedCredential = await claudeCodeCredential(
        await this.refreshOAuthCredential(input.apiConnection, credential, {
          force: forceOAuthRefresh(credential.providerId),
        }),
        {
          backend: input.backend,
          reasoningEffort: input.reasoningEffort,
          scope: sessionId,
        },
      );
      await appendLog(startLogFile, "credential refreshed", {
        providerId: resolvedCredential.providerId,
        authMethod: resolvedCredential.authMethod,
        hasBaseUrl: !!resolvedCredential.baseUrl,
        expires: resolvedCredential.oauthCredentials?.expires,
      });
      await this.syncClineOAuthProviderSettings(resolvedCredential);
      if (resolvedCredential.authMethod === "oauth") {
        await appendLog(startLogFile, "cline oauth settings synced", {
          providerId: resolvedCredential.providerId,
          accountId: resolvedCredential.oauthCredentials?.accountId,
          email: resolvedCredential.oauthCredentials?.email,
          expires: resolvedCredential.oauthCredentials?.expires,
        });
      }
      const cline = await this.core(input.backend);
      await appendLog(startLogFile, "cline core ready");
      const sessionLogFile = sessionLogPath(input.cwd, sessionId);
      await this.subscribeSession(sessionId, input.backend);
      this.sessionExecutionIds.set(sessionId, executionId);
      this.runLifecycles.begin(sessionId, executionId);
      this.sessionBackendKeys.set(sessionId, backendKey(input.backend));
      this.sessionLogFiles.set(sessionId, sessionLogFile);
      this.sessionPersonalization.set(
        sessionId,
        normalizePersonalization(input.personalization),
      );
      this.sessionContexts.set(sessionId, sessionContext(input, sessionId));
      if (input.autoApproveWriteTools) {
        this.autoApprovedWriteToolSessions.add(sessionId);
      }
      const autoSendPrompt = input.autoSendPrompt !== false;
      const pluginPaths = input.clineDefaultTools
        ? undefined
        : runtimePluginPaths(this.productionConfig, input.pluginPaths);
      const skillPluginPaths = [
        ...(input.enableBuiltInSkills ? [blameNativePluginPath()] : []),
        ...(pluginPaths ?? []),
      ];
      const userInstructionService = input.enableBuiltInSkills
        ? await this.userInstructionServices.start({
            cwd: input.cwd,
            pluginPaths: skillPluginPaths,
            sessionId,
            workspaceRoot: input.workspaceRoot,
          })
        : undefined;
      const requestedConfigExtensions =
        input.configExtensions ??
        runtimeConfigExtensions(this.productionConfig);
      const configExtensions = input.enableBuiltInSkills
        ? withConfigExtensions(requestedConfigExtensions, "skills", "plugins")
        : requestedConfigExtensions;
      const taskObjective = input.taskObjective ?? input.prompt;
      const taskContract = {
        environment: {
          isolated: input.isolatedEnvironment === true,
          managedPreview: Boolean(input.previewDevtoolsScope),
        },
        acceptance_criteria: [taskObjective],
        ...(input.requiredChecks ? { required_checks: structuredClone(input.requiredChecks) } : {}),
        effect_requirement: "none" as const,
        session_id: sessionId,
        ...(input.storyId ? { story_id: input.storyId } : {}),
        objective: taskObjective,
      };
      const lightExecutor = managedLightWorkspaceExecutor(
        this.options.lightWorkspace,
        {
          backendMode: input.backend?.mode,
          workspaceMode: input.workspaceMode,
        },
      );
      if (lightExecutor)
        this.sessionJournalExecutors.set(sessionId, lightExecutor);
      this.sessionInactivityTimeouts.set(
        sessionId,
        adaptiveModelInactivityTimeoutMs(
          input.reasoningEffort,
          this.options.modelInactivityTimeoutMs,
        ),
      );
      const [initialTaskBriefing, projectMemory] = await Promise.all([
        input.nativeCompletion
          ? createInitialTaskBriefing({
              executor: lightExecutor,
              taskContract,
              workspaceRoot: input.workspaceRoot,
            })
          : undefined,
        projectMemoryPromise,
      ]);
      const taskBriefing = combinedTaskBriefing(
        initialTaskBriefing,
        projectMemory?.briefing,
      );
      if (!autoSendPrompt && taskBriefing)
        this.sessionDeferredTaskBriefings.set(sessionId, taskBriefing);
      if (projectMemory)
        this.publishProjectMemoryMetrics(sessionId, projectMemory);
      const previewContext = previewRuntimeContext(input);
      const previewOptions = this.developmentPreviewOptions(input);
      const previewMcpTools = input.clineDefaultTools
        ? []
        : await previewDevtoolsMcpTools(
            previewOptions,
            previewContext,
            productionLogger,
          );
      const githubTools = input.clineDefaultTools
        ? []
        : await githubMcpTools(this.options, sessionId, productionLogger);
      const standardTools = input.clineDefaultTools
        ? undefined
        : runtimeTools(
            previewOptions,
            input.workspaceRoot,
            previewContext,
            taskContract,
            lightExecutor,
            input.nativeCompletion
              ? {
                  conversationId: sessionId,
                  onComplete: (notification) =>
                    this.recordNativeCompletion(sessionId, notification, input),
                  onValidationActivity: (activity) =>
                    this.publishNativeValidationActivity(sessionId, activity),
                  responseStyle: () =>
                    this.sessionPersonalization.get(sessionId)?.responseStyle ??
                    defaultPersonalization.responseStyle,
                }
              : undefined,
            previewMcpTools,
            taskBriefing,
          );
      const finish = standardTools?.find((tool) => tool.name === "finish_task");
      if (finish)
        this.sessionNativeFinish.set(sessionId, async (summary) =>
          finish.execute({ summary }, {
            sessionId,
            conversationId: sessionId,
            toolCallId: "native-finish",
          } as Parameters<typeof finish.execute>[1]),
        );
      else this.sessionNativeFinish.delete(sessionId);
      const specialistTool = input.enableSpecialistConsult
        ? runtimeConsultSpecialistTool({
            credential: resolvedCredential,
            input,
            initialTaskBriefing: taskBriefing,
            objective: input.taskObjective ?? input.prompt,
            readOnlyTools: readOnlyRuntimeTools(
              previewOptions,
              input.workspaceRoot,
              previewContext,
              taskContract,
              lightExecutor,
              taskBriefing,
            ),
          })
        : undefined;
      const extraTools = [
        ...webResearchTools(input.apiConnection, this.options.renderWebPage),
        ...(standardTools ?? []),
        ...githubTools,
        ...(specialistTool ? [specialistTool] : []),
        ...sessionStoryHistoryTools(input, this.options.git),
        ...(input.conversationTools ?? []),
      ].filter((tool) => input.toolFilter?.(tool.name) ?? true);
      const systemPrompt =
        (input.systemPrompt ?? loadPrompt("default-agent-system")) + webResearchGuidance +
        (input.nativeCompletion && !input.clineDefaultTools
          ? skillScopeSystemPrompt(
              userInstructionService,
              extraTools.map((tool) => tool.name),
            )
          : "");
      const requestedCompaction =
        input.compaction ?? blameCompactionConfig(this.productionConfig);
      const compactionConfig = input.clineDefaultTools
        ? requestedCompaction
        : imageAwareCompaction(
            requestedCompaction,
            input.providerId,
            input.modelId,
          );
      const contextProjectionExtension =
        input.nativeCompletion && compactionConfig.enabled !== false
          ? createContextProjectionExtension({
              emit: (metrics) =>
                this.events?.emit(
                  this.withExecutionId(sessionId, {
                    type: "notice",
                    sessionId,
                    payload: {
                      kind: "context_composed",
                      metrics,
                      phase: "completed",
                    },
                  }),
                ),
              systemPrompt,
              tools: extraTools,
            })
          : undefined;
      const startInput = {
        ...(autoSendPrompt
          ? {
              prompt: appendInitialTaskBriefing(input.prompt, taskBriefing),
            }
          : {}),
        ...(input.initialMessages?.length
          ? { initialMessages: input.initialMessages }
          : {}),
        ...(input.initialMessages?.length && input.initialCompactionState
          ? { initialCompactionState: input.initialCompactionState }
          : {}),
        ...(autoSendPrompt && input.userImages?.length
          ? { userImages: input.userImages }
          : {}),
        ...(autoSendPrompt && input.userFiles?.length
          ? { userFiles: input.userFiles }
          : {}),
        config: {
          ...appendProductionConfig({
            sessionId,
            providerId: input.providerId,
            modelId: input.modelId,
            apiKey: resolvedCredential.apiKey,
            baseUrl: resolvedCredential.baseUrl ?? undefined,
            ...reasoningConfig(input.reasoningEffort),
            ...contextLimitConfig(input),
            systemPrompt,
            cwd: input.cwd,
            workspaceRoot: input.workspaceRoot,
            checkpoint: {
              enabled:
                input.checkpointEnabled ??
                blameCheckpointConfig(this.productionConfig).enabled,
            },
            mode: input.mode ?? "act",
            maxIterations: input.maxIterations,
            disableMcpSettingsTools:
              input.disableMcpSettingsTools ??
              this.productionConfig.disableMcpSettingsTools,
            ...(pluginPaths ? { pluginPaths } : {}),
            ...(contextProjectionExtension
              ? { extensions: [contextProjectionExtension] }
              : {}),
            compaction: compactionConfig,
            enableTools: true,
            enableSpawnAgent: input.enableSpawnAgent ?? false,
            enableAgentTeams: input.enableAgentTeams ?? false,
            extensionContext: extensionContext(input),
            ...(extraTools.length ? { extraTools } : {}),
          }),
        },
        localRuntime: {
          ...(configExtensions ? { configExtensions } : {}),
          ...(userInstructionService ? { userInstructionService } : {}),
          ...(pluginPaths ? { pluginPaths } : {}),
        },
        interactive: !autoSendPrompt,
        source: "blame-desktop",
        toolPolicies: input.clineDefaultTools
          ? clineDefaultToolPolicies()
          : toolPolicies(!!input.autoApproveWriteTools, [
              ...previewMcpTools.map(({ name }) => name),
              // Read-only: GitHub's MCP server only exposes read tools.
              ...githubTools.map(({ name }) => name),
              ...(previewOptions.repairPreviewInitialization
                ? ["repair_preview_initialization"]
                : []),
            ]),
      } as const;
      this.sessionStartInputs.set(sessionId, startInput);
      if (input.clineDefaultTools) this.clineDefaultSessions.add(sessionId);
      if (input.autoApproveWriteTools) {
        this.emitSessionNotice(
          sessionId,
          "Development session write tools auto-approved.",
        );
      }
      if (autoSendPrompt) {
        this.armSessionInactivityWatchdog(sessionId, executionId, cline);
        void (cline.start(startInput) as Promise<RuntimeClineResult>)
          .then((session) =>
            this.completeSessionStart(
              startLogFile,
              startedAt,
              input,
              session,
              sessionLogFile,
              cline,
              executionId,
            ),
          )
          .catch((error: unknown) =>
            this.failSessionStart(startLogFile, startedAt, sessionId, error),
          );
        await this.logSession(sessionId, "session subscribed");
        this.emitSessionNotice(sessionId, `Cline debug log: ${sessionLogFile}`);
        return { sessionId };
      }
      const session = (await cline.start(startInput)) as RuntimeClineResult;
      this.sessionBackendKeys.set(session.sessionId, backendKey(input.backend));
      await appendLog(startLogFile, "session created", {
        durationMs: Date.now() - startedAt,
        sessionId: session.sessionId,
        logFile: sessionLogFile,
      });
      await this.logSession(session.sessionId, "session created", {
        ...startContext(input),
        logFile: sessionLogFile,
      });
      await this.logSession(session.sessionId, "session subscribed");
      this.emitSessionNotice(
        session.sessionId,
        `Cline debug log: ${sessionLogFile}`,
      );
      if (input.autoSendPrompt === false) {
        await this.logSession(session.sessionId, "prompt deferred", {
          ...promptMetadata(input.prompt),
        });
      }
      return session;
    } catch (error) {
      await appendLog(startLogFile, "start failed", {
        durationMs: Date.now() - startedAt,
        errorType: errorType(error),
        message: errorMessage(error),
        status: "failed",
      });
      this.userInstructionServices.stop(sessionId);
      if (this.sessionExecutionIds.get(sessionId) === executionId)
        await this.unsubscribeSession(sessionId);
      throw error;
    }
  }

  private async completeSessionStart(
    startLogFile: string,
    startedAt: number,
    input: StartSessionInput,
    session: RuntimeClineResult,
    sessionLogFile: string,
    cline: ClineCore,
    executionId: string,
  ) {
    const sessionId = session.sessionId;
    await appendLog(startLogFile, "session created", {
      durationMs: Date.now() - startedAt,
      sessionId,
      logFile: sessionLogFile,
    });
    await this.logSession(sessionId, "session created", {
      ...startContext(input),
      logFile: sessionLogFile,
    });
    await this.completeSessionStartResult(cline, session, executionId);
  }

  private async completeSessionStartResult(
    cline: ClineCore,
    session: RuntimeClineResult,
    executionId: string,
  ) {
    const { sessionId, result } = session;
    await this.sessionTerminalDrains.get(sessionId);
    if (!this.runLifecycles.canInvoke(sessionId, executionId)) return;
    const failure = this.sessionResultFailure(sessionId, executionId, result);
    if (
      failure &&
      this.shouldRecoverTransportFailure(sessionId, executionId, failure)
    ) {
      await this.resumeTransportInterruption(cline, sessionId, executionId);
      return;
    }
    this.sessionTransportRecoveries.delete(sessionId);
    if (!failure) return;
    await this.terminateSessionExecution({
      cline,
      display: true,
      event: this.sessionFailureEvent(sessionId, executionId, failure),
      executionId,
      reason: "Cline start returned a failure",
      sessionId,
      terminalState: terminalStateFromResult(result),
    });
  }

  private async failSessionStart(
    startLogFile: string,
    startedAt: number,
    sessionId: string,
    error: unknown,
  ) {
    this.clearSessionInactivityWatchdog(sessionId);
    this.sessionTransportRecoveries.delete(sessionId);
    const message = errorMessage(error);
    await appendLog(startLogFile, "start failed", {
      durationMs: Date.now() - startedAt,
      errorType: errorType(error),
      message,
      status: "failed",
    });
    await this.recordSessionJournalTerminal(sessionId, "failed").catch(
      () => undefined,
    );
    const executionId = this.sessionExecutionIds.get(sessionId);
    if (
      !executionId ||
      this.runLifecycles.finish(
        sessionId,
        executionId,
        "failed",
        undefined,
        "runtime_crash",
      )
    )
      this.emitSessionError(sessionId, message, error, executionId);
    this.userInstructionServices.stop(sessionId);
  }

  private async sendSession(input: SendSessionInput) {
    const executionId =
      input.executionId?.trim() ??
      `${input.sessionId}:execution:${randomUUID()}`;
    const lifecycle = this.runLifecycles.begin(input.sessionId, executionId);
    if (lifecycle.execution_id !== executionId || lifecycle.state !== "running")
      throw new Error(
        "The previous execution is still stopping; no new model call was made.",
      );
    this.sessionSubmittedSummaries.delete(input.sessionId);
    this.sessionExecutionIds.set(input.sessionId, executionId);
    const cline = await this.sessionCore(input.sessionId);
    return this.sendPrompt(
      cline,
      input.sessionId,
      input.prompt,
      {
        userFiles: input.userFiles,
        userImages: input.userImages,
      },
      executionId,
    );
  }

  private async sendDevelopmentSession(input: SendDevelopmentSessionInput) {
    const developmentInput = await developmentUserInput(
      {
        ...input,
        apiConnection: this.sessionApiConnections.get(input.sessionId),
      },
      this.attachmentDirectory(input.sessionId),
      this.sessionAttachmentStorage(input.sessionId),
    );
    await this.writeSessionJournal(input.sessionId, {
      kind: "request",
      id:
        input.executionId ??
        `user-message://${sha256(developmentInput.prompt)}`,
      text: developmentInput.prompt,
    });
    const briefing = this.sessionDeferredTaskBriefings.get(input.sessionId);
    this.sessionDeferredTaskBriefings.delete(input.sessionId);
    const personalizationNote = this.personalizationNote(input);
    return this.sendSession({
      sessionId: input.sessionId,
      executionId: input.executionId,
      userImages: developmentInput.userImages,
      prompt: [
        personalizationNote,
        appendInitialTaskBriefing(developmentInput.prompt, briefing),
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  // The note a changed setting adds ahead of the next message, applied from
  // that turn on and never in the middle of one.
  private personalizationNote(input: SendDevelopmentSessionInput) {
    if (!input.personalization) return "";
    const next = normalizePersonalization(input.personalization);
    const previous =
      this.sessionPersonalization.get(input.sessionId) ??
      defaultPersonalization;
    this.sessionPersonalization.set(input.sessionId, next);
    return personalizationUpdateNote(previous, next);
  }

  private async abortSession(sessionId: string, humanInitiated = true) {
    const cline = await this.sessionCore(sessionId);
    const executionId =
      this.sessionExecutionIds.get(sessionId) ?? `${sessionId}:execution`;
    const lifecycle = this.runLifecycles.state(sessionId);
    if (
      lifecycle &&
      ["cancelled", "failed", "succeeded"].includes(lifecycle.state)
    )
      return;
    await this.terminateSessionExecution({
      cline,
      executionId,
      reason: humanInitiated
        ? "User aborted from Blame"
        : "Blame runtime requested termination",
      sessionId,
      terminalState: "cancelled",
      terminalReason: humanInitiated ? "user" : "shutdown",
    });
  }

  private armSessionInactivityWatchdog(
    sessionId: string,
    executionId: string,
    cline: ClineCore,
  ) {
    this.clearSessionInactivityWatchdog(sessionId);
    const watchdog: SessionInactivityWatchdog = {
      cline,
      executionId,
      idleWindows: 0,
      timeoutMs:
        this.sessionInactivityTimeouts.get(sessionId) ??
        this.options.modelInactivityTimeoutMs ??
        defaultModelInactivityTimeoutMs,
    };
    this.sessionInactivityWatchdogs.set(sessionId, watchdog);
    watchdog.timer = this.inactivityTimer(
      sessionId,
      executionId,
      watchdog.timeoutMs,
    );
  }

  private touchSessionInactivityWatchdog(
    sessionId: string,
    executionId: string,
  ) {
    const watchdog = this.sessionInactivityWatchdogs.get(sessionId);
    if (!watchdog || watchdog.executionId !== executionId) return;
    if (this.sessionActiveTools.get(sessionId)?.size) return;
    if (watchdog.timer) clearTimeout(watchdog.timer);
    watchdog.idleWindows = 0;
    watchdog.timer = this.inactivityTimer(
      sessionId,
      executionId,
      watchdog.timeoutMs,
    );
  }

  private observeSessionActivity(
    sessionId: string,
    executionId: string,
    toolPhase?: "started" | "finished",
    toolCallId = "anonymous-tool",
  ) {
    const watchdog = this.sessionInactivityWatchdogs.get(sessionId);
    if (!watchdog || watchdog.executionId !== executionId) return;
    if (!toolPhase)
      return this.touchSessionInactivityWatchdog(sessionId, executionId);
    const activeTools =
      this.sessionActiveTools.get(sessionId) ?? new Set<string>();
    if (toolPhase === "started") activeTools.add(toolCallId);
    else activeTools.delete(toolCallId);
    if (activeTools.size) {
      this.sessionActiveTools.set(sessionId, activeTools);
      return this.pauseSessionInactivityWatchdog(sessionId, executionId);
    }
    this.sessionActiveTools.delete(sessionId);
    this.touchSessionInactivityWatchdog(sessionId, executionId);
  }

  private pauseSessionInactivityWatchdog(
    sessionId: string,
    executionId: string,
  ) {
    const watchdog = this.sessionInactivityWatchdogs.get(sessionId);
    if (!watchdog || watchdog.executionId !== executionId || !watchdog.timer)
      return;
    clearTimeout(watchdog.timer);
    watchdog.timer = undefined;
  }

  private inactivityTimer(
    sessionId: string,
    executionId: string,
    timeoutMs: number,
  ) {
    const timeout = setTimeout(
      () => void this.failInactiveSession(sessionId, executionId),
      timeoutMs,
    );
    timeout.unref?.();
    return timeout;
  }

  private clearSessionInactivityWatchdog(
    sessionId: string,
    executionId?: string,
  ) {
    const watchdog = this.sessionInactivityWatchdogs.get(sessionId);
    if (!watchdog || (executionId && watchdog.executionId !== executionId))
      return;
    if (watchdog.timer) clearTimeout(watchdog.timer);
    this.sessionInactivityWatchdogs.delete(sessionId);
    this.sessionActiveTools.delete(sessionId);
  }

  private async failInactiveSession(sessionId: string, executionId: string) {
    const watchdog = this.sessionInactivityWatchdogs.get(sessionId);
    if (!watchdog || watchdog.executionId !== executionId) return;
    if (!this.runLifecycles.canInvoke(sessionId, executionId)) return;
    const timeoutMs = watchdog.timeoutMs;
    if (watchdog.idleWindows === 0) {
      watchdog.idleWindows = 1;
      watchdog.timer = this.inactivityTimer(sessionId, executionId, timeoutMs);
      await this.logSession(sessionId, "model inactivity warning", {
        executionId,
        timeoutMs,
      });
      this.emitSessionNotice(
        sessionId,
        `The model has been silent for ${Math.ceil(timeoutMs / 1_000)} seconds. Blame is preserving the run and waiting for one final response window.`,
      );
      return;
    }
    const message = `Agent model produced no activity for ${Math.ceil(timeoutMs / 1_000)} seconds.`;
    await this.logSession(sessionId, "model inactivity timeout", {
      executionId,
      timeoutMs,
    });
    await this.terminateSessionExecution({
      cline: watchdog.cline,
      display: true,
      event: this.withExecutionId(
        sessionId,
        {
          type: "error",
          sessionId,
          payload: { code: "model_inactivity_timeout", message },
        },
        executionId,
      ),
      executionId,
      reason: "Model inactivity timeout",
      sessionId,
      terminalState: "failed",
      terminalReason: "model_inactivity_timeout",
    });
  }

  private async terminateSessionExecution(input: SessionTermination) {
    this.clearSessionInactivityWatchdog(input.sessionId, input.executionId);
    this.sessionTransportRecoveries.delete(input.sessionId);
    const existing = this.sessionTerminations.get(input.sessionId);
    if (existing?.executionId === input.executionId) return existing.promise;
    const lifecycle =
      this.runLifecycles.state(input.sessionId) ??
      this.runLifecycles.begin(input.sessionId, input.executionId);
    if (
      lifecycle?.execution_id !== input.executionId ||
      ["cancelled", "failed", "succeeded"].includes(lifecycle.state)
    )
      return true;
    if (lifecycle.state === "running")
      this.runLifecycles.stopping(input.sessionId, input.executionId);
    const promise = this.performSessionTermination(input);
    this.sessionTerminations.set(input.sessionId, {
      executionId: input.executionId,
      promise,
    });
    return promise;
  }

  private async performSessionTermination(input: SessionTermination) {
    const result = await this.stopCoreSession(input, 1_800);
    if (result.status === "stopped") {
      await this.finalizeSessionTermination(input);
      return true;
    }
    this.runLifecycles.terminationPending(input.sessionId, input.executionId);
    await this.logSession(input.sessionId, "run termination pending", {
      ...(result.error === undefined
        ? { reason: "TERMINATION_TIMEOUT" }
        : { error: errorMessage(result.error) }),
      ...this.runLifecycles.state(input.sessionId),
    });
    this.startTerminationWatchdog(input);
    return false;
  }

  private async stopCoreSession(
    input: SessionTermination,
    timeoutMs: number,
  ): Promise<SessionTerminationAttempt> {
    const stopping = Promise.resolve().then(() =>
      input.cline.stop(input.sessionId),
    );
    const aborting = Promise.resolve().then(() =>
      input.cline.abort(input.sessionId, input.reason),
    );
    void aborting.catch((error: unknown) =>
      this.logSession(input.sessionId, "tool cancellation failed", {
        error: errorMessage(error),
      }),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("termination-timeout");
    const result = await Promise.race([
      stopping.then(
        () => ({ status: "stopped" as const }),
        (error: unknown) => ({ error, status: "pending" as const }),
      ),
      new Promise<typeof timedOut>(
        (resolve) => (timeout = setTimeout(() => resolve(timedOut), timeoutMs)),
      ),
    ]);
    if (timeout) clearTimeout(timeout);
    return result === timedOut ? { status: "pending" } : result;
  }

  private startTerminationWatchdog(input: SessionTermination) {
    const existing = this.sessionTerminationWatchdogs.get(input.sessionId);
    if (existing) return;
    const watchdog = this.runTerminationWatchdog(input);
    this.sessionTerminationWatchdogs.set(input.sessionId, watchdog);
    const clear = () => {
      if (this.sessionTerminationWatchdogs.get(input.sessionId) === watchdog)
        this.sessionTerminationWatchdogs.delete(input.sessionId);
    };
    void watchdog.then(clear, clear);
  }

  private async runTerminationWatchdog(input: SessionTermination) {
    let cycle = 0;
    while (true) {
      cycle += 1;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const lifecycle = this.runLifecycles.state(input.sessionId);
        if (
          lifecycle?.execution_id !== input.executionId ||
          ["cancelled", "failed", "succeeded"].includes(lifecycle.state)
        )
          return;
        const result = await this.stopCoreSession(input, 750);
        if (result.status === "stopped") {
          await this.finalizeSessionTermination(input);
          return;
        }
        await this.logSession(
          input.sessionId,
          "run termination watchdog retry",
          {
            attempt,
            cycle,
            ...(result.error === undefined
              ? { reason: "TERMINATION_TIMEOUT" }
              : { error: errorMessage(result.error) }),
            ...lifecycle,
          },
        );
      }
      if (await this.disposeUnresponsiveCore(input, cycle)) {
        await this.finalizeSessionTermination(input);
        return;
      }
      await this.logSession(
        input.sessionId,
        "run termination watchdog pending",
        {
          attempts: cycle * 3,
          escalation: "CORE_DISPOSE_RETRY_SCHEDULED",
          ...this.runLifecycles.state(input.sessionId),
        },
      );
      await terminationWatchdogPause(1_000);
    }
  }

  private async disposeUnresponsiveCore(
    input: SessionTermination,
    cycle: number,
  ) {
    const backendKey = this.sessionBackendKeys.get(input.sessionId);
    if (backendKey) {
      const registered = this.clines.get(backendKey);
      if (registered) {
        const core = await registered.catch(() => undefined);
        if (core === input.cline) this.clines.delete(backendKey);
      }
    }
    const disposing = Promise.resolve().then(() =>
      input.cline.dispose(
        `Termination watchdog escalation for ${input.sessionId}`,
      ),
    );
    const result = await settleWithTimeout(disposing, 1_500);
    await this.logSession(input.sessionId, "run termination core disposal", {
      cycle,
      status: result.status,
      ...(result.status === "failed"
        ? { error: errorMessage(result.error) }
        : {}),
      ...this.runLifecycles.state(input.sessionId),
    });
    return result.status === "completed";
  }

  private async finalizeSessionTermination(input: SessionTermination) {
    const lifecycle = this.runLifecycles.state(input.sessionId);
    if (
      lifecycle?.execution_id !== input.executionId ||
      ["cancelled", "failed", "succeeded"].includes(lifecycle.state)
    )
      return;
    let nativeFailure: string | undefined;
    if (
      input.terminalState === "succeeded" &&
      !this.sessionSubmittedSummaries.has(input.sessionId)
    ) {
      const finish = this.sessionNativeFinish.get(input.sessionId);
      if (finish) {
        const reply = stringValue(asRecord(input.event?.payload).text);
        try {
          await finish(reply ?? "Task completed.");
        } catch (error) {
          // The run is over: a refused reply stays, with why it is unverified.
          if (reply?.trim()) this.sessionSubmittedSummaries.set(input.sessionId, unverifiedReply(reply, errorMessage(error)));
          else nativeFailure = errorMessage(error);
        }
      }
    }
    const notification = this.sessionSubmittedSummaries.get(input.sessionId);
    const completion = notification?.completion;
    const terminalState = nativeFailure
      ? "failed"
      : completionAwareTerminalState(input.terminalState, completion);
    await this.recordSessionJournalTerminal(input.sessionId, terminalState);
    const event = nativeFailure
      ? this.sessionFailureEvent(
          input.sessionId,
          input.executionId,
          nativeFailure,
        )
      : terminalState === input.terminalState
        ? input.event && this.withSubmittedSummary(input.sessionId, input.event)
        : completionFailureEvent(input.sessionId, notification);
    if (event) await this.handleSessionEvent(input.sessionId, event);
    if (
      !this.runLifecycles.finish(
        input.sessionId,
        input.executionId,
        terminalState,
        completion,
        terminalState === input.terminalState
          ? input.terminalReason
          : "code_failure",
      )
    )
      return;
    await this.logSession(input.sessionId, "run lifecycle terminal", {
      ...this.runLifecycles.state(input.sessionId),
    });
    if (event && input.display) this.events?.emit(event);
    const termination = this.sessionTerminations.get(input.sessionId);
    if (termination?.executionId === input.executionId)
      this.sessionTerminations.delete(input.sessionId);
  }

  private async releaseWorkspaceSessions(workspace: string) {
    const sessionIds = workspaceSessionIds(this.sessionLogFiles, workspace);
    await Promise.allSettled(
      sessionIds.map((sessionId) => this.abortSession(sessionId, false)),
    );
    await Promise.all(
      sessionIds.map((sessionId) => this.unsubscribeSession(sessionId)),
    );
  }

  private async compareCheckpoint(
    input: CompareCheckpointInput,
  ): Promise<CompareCheckpointResult> {
    const cline = await this.sessionCore(input.sessionId);
    return cline.compareCheckpoint(input);
  }

  private async restoreCheckpoint(
    input: RestoreCheckpointInput,
  ): Promise<RestoreCheckpointResult> {
    const cline = await this.sessionCore(input.sessionId);
    const restoreMessages = input.restore?.messages ?? false;
    const start = restoreMessages
      ? this.restoreCheckpointStartInput(input.sessionId)
      : undefined;
    const result = await cline.restore({
      checkpointRunCount: input.checkpointRunCount,
      cwd: input.cwd,
      restore: {
        messages: restoreMessages,
        omitCheckpointMessageFromSession:
          input.restore?.omitCheckpointMessageFromSession,
        workspace: input.restore?.workspace ?? true,
      },
      ...(start ? { start } : {}),
      sessionId: input.sessionId,
    });
    await this.attachRestoredCheckpointSession(
      input.sessionId,
      result.sessionId,
      start,
      cline,
    );
    return result;
  }

  private restoreCheckpointStartInput(sessionId: string) {
    const start = this.sessionStartInputs.get(sessionId);
    if (!start) {
      throw new Error(
        "Unable to restore Cline messages for a session started before this app session.",
      );
    }
    const restoredSessionId = createBlameSessionId();
    return {
      ...start,
      config: {
        ...start.config,
        sessionId: restoredSessionId,
      },
    };
  }

  private async attachRestoredCheckpointSession(
    sourceSessionId: string,
    restoredSessionId: string | undefined,
    start: ClineCoreStartInput | undefined,
    cline: ClineCore,
  ) {
    if (!restoredSessionId || !start) return;
    if (restoredSessionId === sourceSessionId) return;
    if (!this.unsubscribers.has(restoredSessionId)) {
      await this.subscribeCoreSession(restoredSessionId, cline);
    }
    const backendKeyValue = this.sessionBackendKeys.get(sourceSessionId);
    if (backendKeyValue)
      this.sessionBackendKeys.set(restoredSessionId, backendKeyValue);
    const cwd = start.config.cwd;
    if (cwd) {
      this.sessionLogFiles.set(
        restoredSessionId,
        sessionLogPath(cwd, restoredSessionId),
      );
    }
    const context = this.sessionContexts.get(sourceSessionId);
    if (context) {
      this.sessionContexts.set(restoredSessionId, {
        ...context,
        sessionId: restoredSessionId,
      });
    }
    this.sessionStartInputs.set(restoredSessionId, start);
    const journalExecutor = this.sessionJournalExecutors.get(sourceSessionId);
    if (journalExecutor)
      this.sessionJournalExecutors.set(restoredSessionId, journalExecutor);
    const inactivityTimeout =
      this.sessionInactivityTimeouts.get(sourceSessionId);
    if (inactivityTimeout)
      this.sessionInactivityTimeouts.set(restoredSessionId, inactivityTimeout);
    const apiConnection = this.sessionApiConnections.get(sourceSessionId);
    if (apiConnection) {
      this.sessionApiConnections.set(restoredSessionId, apiConnection);
    }
    if (this.autoApprovedWriteToolSessions.has(sourceSessionId)) {
      this.autoApprovedWriteToolSessions.add(restoredSessionId);
    }
  }

  private async listSessions() {
    const lists = await Promise.all(
      Array.from(this.clines.values()).map(async (cline) => {
        try {
          return await (await cline).list(50);
        } catch {
          return [];
        }
      }),
    );
    if (lists.length) return lists.flat();
    const cline = await this.core();
    return cline.list(50);
  }

  private async readMessages(sessionId: string) {
    const cline = await this.sessionCore(sessionId);
    return cline.readLiveMessages(sessionId);
  }

  private async resumeMessages(
    sessionId: string | null | undefined,
    backend?: AgentBackendConfig,
  ) {
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) return undefined;
    try {
      const messages = await (
        await this.core(backend)
      ).readLiveMessages(normalizedSessionId);
      return messages.length ? messages : undefined;
    } catch {
      return undefined;
    }
  }

  // A manual compaction of this session, kept for its next resume.
  private async resumeCompactionState(
    sessionId: string | null | undefined,
    backend?: AgentBackendConfig,
  ) {
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) return undefined;
    try {
      return await (
        await this.core(backend)
      ).readSessionCompactionState(normalizedSessionId);
    } catch {
      return undefined;
    }
  }

  private async compactSession(
    input: CompactSessionInput,
  ): Promise<CompactSessionResult> {
    const sessionId = input.sessionId.trim();
    const state = this.runLifecycles.state(sessionId)?.state;
    if (state === "running" || state === "cancelling") {
      throw new Error("Wait for the agent to finish before compacting.");
    }
    const credential = await this.refreshOAuthCredential(
      input.apiConnection,
      await resolveProviderCredential(input.apiConnection, {
        providerId: input.providerId,
        label: credentialLabel(input),
      }),
      { force: forceOAuthRefresh(input.providerId) },
    );
    await this.syncClineOAuthProviderSettings(credential);
    const cline = this.sessionBackendKeys.has(sessionId)
      ? await this.sessionCore(sessionId)
      : await this.core(input.backend);
    return compactSessionContext({
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl ?? undefined,
      cline,
      compaction: blameCompactionConfig(this.productionConfig),
      maxInputTokens: input.maxInputTokens,
      modelId: input.modelId,
      modelInfo: knownModelInfo(input.providerId, input.modelId),
      providerId: input.providerId,
      sessionId,
    });
  }

  private async readUsage(
    sessionId: string,
  ): Promise<AgentUsageSummary | undefined> {
    const cline = await this.sessionCore(sessionId);
    return normalizeAgentUsageSummary(
      await cline.getAccumulatedUsage(sessionId),
    );
  }

  private async mapSecurityAudit(input: MapSecurityAuditInput) {
    assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
    return scanSecurityAuditRepository(input.workspaceRoot, this.options.git);
  }

  private async runtimeCredential(input: RuntimeCredentialInput) {
    const credential = await resolveProviderCredential(input.apiConnection, {
      providerId: input.providerId,
      label: credentialLabel(input),
    });
    return claudeCodeCredential(
      await this.refreshOAuthCredential(input.apiConnection, credential),
      { backend: input.backend, reasoningEffort: input.reasoningEffort },
    );
  }

  private get gh() {
    return this.options.gh ?? runHostGh;
  }

  private async subscribeSession(
    sessionId: string,
    backend?: AgentBackendConfig,
  ) {
    const cline = await this.core(backend);
    await this.subscribeCoreSession(sessionId, cline);
  }

  private async subscribeCoreSession(sessionId: string, cline: ClineCore) {
    await this.unsubscribeSession(sessionId);
    this.sessionReleases.delete(sessionId);
    const unsubscribe = await cline.subscribe(
      (payload: CoreSessionEvent) => {
        const executionId =
          this.sessionExecutionIds.get(sessionId) ??
          `${sessionId}:initial-execution`;
        const toolActivity = clineSessionToolEvent(payload);
        this.observeSessionActivity(
          sessionId,
          executionId,
          toolActivity?.phase,
          toolActivity?.toolCallId,
        );
        const eventTokens = eventTokenCount(payload);
        const lifecycleBeforeEvent = this.runLifecycles.state(sessionId);
        const terminalBeforeEvent = [
          "succeeded",
          "failed",
          "cancelled",
        ].includes(lifecycleBeforeEvent?.state ?? "");
        if (!this.runLifecycles.accepts(sessionId, executionId, eventTokens)) {
          void this.logSession(
            sessionId,
            terminalBeforeEvent
              ? "post-terminal event dropped"
              : "cancelling event dropped",
            {
              event_type: payload.type,
              ...this.runLifecycles.state(sessionId),
            },
          );
          return;
        }
        if (toolActivity?.phase === "finished" && toolActivity.toolCallId) {
          const completed = this.sessionCompletedToolIds.get(sessionId) ?? new Set<string>();
          completed.add(toolActivity.toolCallId);
          this.sessionCompletedToolIds.set(sessionId, completed);
        }
        if (this.shouldSkipFallbackChunk(sessionId, payload)) return;
        const spawnAgentPhase = clineSessionSpawnAgentPhase(payload);
        const normalized = this.withToolLifecycle(
          sessionId,
          normalizeEvent(sessionId, payload),
        );
        const display = !this.shouldSkipSessionDisplayEvent(sessionId, payload);
        const event = this.withSubmittedSummary(
          sessionId,
          this.withExecutionId(
            sessionId,
            this.withSessionIteration(
              sessionId,
              this.withToolInput(sessionId, normalized),
            ),
          ),
        );
        if (this.deferTransportFailureEvent(sessionId, executionId, event)) {
          return;
        }
        if (this.shouldSkipDuplicateSessionEvent(sessionId, event)) return;
        if (terminalToolEvent(event)) {
          this.events?.captureHiddenToolEvent?.(event);
          return;
        }
        const terminalState = terminalLifecycleState(event);
        if (terminalState) {
          const drain = this.finalizeStreamTerminal(
            cline,
            sessionId,
            executionId,
            terminalState,
            event,
            display,
          );
          this.sessionTerminalDrains.set(sessionId, drain);
          const clearTerminalDrain = () => {
            if (this.sessionTerminalDrains.get(sessionId) === drain)
              this.sessionTerminalDrains.delete(sessionId);
          };
          void drain.then(clearTerminalDrain, clearTerminalDrain);
          return;
        }
        if (!display) return;
        if (spawnAgentPhase) {
          this.updateSessionSpawnAgentState(sessionId, spawnAgentPhase);
        }
        void this.handleSessionEvent(sessionId, event);
        this.events?.emit(event);
      },
      { sessionId },
    );
    this.unsubscribers.set(sessionId, unsubscribe);
  }

  private async finalizeStreamTerminal(
    cline: ClineCore,
    sessionId: string,
    executionId: string,
    terminalState: RunTerminalState,
    event: AgentEvent,
    display: boolean,
  ) {
    await this.terminateSessionExecution({
      cline,
      display,
      event,
      executionId,
      reason: `Cline emitted terminal event: ${terminalState}`,
      sessionId,
      terminalState,
    });
  }

  private deferTransportFailureEvent(
    sessionId: string,
    executionId: string,
    event: AgentEvent,
  ) {
    const current = this.sessionTransportRecoveries.get(sessionId);
    if (
      current?.executionId === executionId &&
      current.attempts < maximumTransportRecoveryAttempts &&
      terminalLifecycleState(event) === "failed"
    )
      return true;
    const message = transportFailureEventMessage(event);
    if (!message) return false;
    if (!this.shouldRecoverTransportFailure(sessionId, executionId, message))
      return false;
    this.rememberTransportFailure(sessionId, executionId, message, current);
    return true;
  }

  private rememberTransportFailure(
    sessionId: string,
    executionId: string,
    message: string,
    current: SessionTransportRecovery | undefined,
  ) {
    this.sessionTransportRecoveries.set(sessionId, {
      attempts: current?.attempts ?? 0,
      executionId,
      message,
    });
    void this.logSession(sessionId, "provider transport recovery pending", {
      message,
      status: "recovering",
    });
  }

  private shouldRecoverTransportFailure(
    sessionId: string,
    executionId: string,
    error: unknown,
  ) {
    if (!retryableModelTransportFailure(error)) return false;
    const start = this.sessionStartInputs.get(sessionId);
    if (start?.interactive !== true) {
      // A noninteractive SDK run is destroyed when it ends. Only Light
      // development runs can restart their persisted conversation, and only
      // after an observed iteration, with turns left when the run has a limit.
      const consumed = this.sessionIterations.get(sessionId);
      const maximum = start?.config.maxIterations;
      if (start?.interactive !== false || this.clineDefaultSessions.has(sessionId) ||
        !start.config.extraTools?.some((tool: AgentTool) => tool.name === "finish_task") ||
        consumed === undefined || consumed < 1 ||
        (maximum !== undefined && consumed >= maximum)) return false;
    }
    if (!this.runLifecycles.canInvoke(sessionId, executionId)) return false;
    if (this.sessionSubmittedSummaries.has(sessionId)) return false;
    if ((this.sessionActiveTools.get(sessionId)?.size ?? 0) > 0) return false;
    const recovery = this.sessionTransportRecoveries.get(sessionId);
    return (
      recovery?.executionId !== executionId ||
      recovery.attempts < maximumTransportRecoveryAttempts
    );
  }

  private async resumeTransportInterruption(
    cline: ClineCore,
    sessionId: string,
    executionId: string,
  ): Promise<unknown> {
    const current = this.sessionTransportRecoveries.get(sessionId);
    const attempts =
      current?.executionId === executionId ? current.attempts + 1 : 1;
    this.sessionTransportRecoveries.set(sessionId, {
      attempts,
      executionId,
      message: current?.message ?? "Provider stream interrupted",
    });
    const start = this.sessionStartInputs.get(sessionId);
    let restart: ClineCoreStartInput | undefined;
    if (start?.interactive === false) {
      const consumed = this.sessionIterations.get(sessionId)!;
      const [initialMessages, initialCompactionState] = await Promise.all([
        cline.readMessages(sessionId), cline.readSessionCompactionState(sessionId),
      ]);
      if (!this.runLifecycles.canInvoke(sessionId, executionId)) return;
      if (!initialMessages.length)
        throw new Error("Provider recovery requires persisted conversation history.");
      const persistedResults = new Set<string>(initialMessages.flatMap((message: Message) =>
        Array.isArray(message.content) ? message.content.flatMap((block: ContentBlock) =>
          block.type === "tool_result" ? [block.tool_use_id] : []) : []));
      if ([...(this.sessionCompletedToolIds.get(sessionId) ?? [])].some((id) => !persistedResults.has(id)))
        throw new Error("Provider recovery refused: persisted history omits a completed tool result.");
      restart = { ...start, prompt: transportRecoveryPrompt, initialMessages,
        initialCompactionState, userImages: undefined, userFiles: undefined,
        config: { ...start.config, maxIterations: start.config.maxIterations === undefined
          ? undefined : start.config.maxIterations - consumed } };
      this.sessionTransportRecoveries.set(sessionId, {
        attempts, executionId, iterationOffset: consumed,
        message: current?.message ?? "Provider stream interrupted",
      });
    }
    void this.logSession(sessionId, "provider transport recovery started", {
      attempt: attempts,
      status: "recovering",
    });
    this.emitSessionNotice(
      sessionId,
      "Provider connection interrupted. Blame is resuming from the persisted session state.",
    );
    if (restart) {
      this.armSessionInactivityWatchdog(sessionId, executionId, cline);
      const session = (await cline.start(restart)) as RuntimeClineResult;
      await this.completeSessionStartResult(cline, session, executionId);
      return session.result;
    }
    return this.sendPrompt(
      cline,
      sessionId,
      transportRecoveryPrompt,
      {},
      executionId,
    );
  }

  private sessionResultFailure(
    sessionId: string,
    executionId: string,
    result: unknown,
  ) {
    const failure = resultFailureMessage(result);
    if (
      resultFailureDetail(result) ||
      (!failure && resultStatus(asRecord(result)))
    )
      return failure;
    const recovery = this.sessionTransportRecoveries.get(sessionId);
    return recovery?.executionId === executionId && recovery.attempts === 0
      ? recovery.message
      : failure;
  }

  private sessionFailureEvent(
    sessionId: string,
    executionId: string,
    message: string,
  ) {
    return this.withExecutionId(
      sessionId,
      {
        type: "error",
        sessionId,
        payload: { message, ...clineErrorMetadata(message) },
      },
      executionId,
    );
  }

  private withSubmittedSummary(sessionId: string, event: AgentEvent) {
    const notification = this.sessionSubmittedSummaries.get(sessionId);
    if (event.type !== "done" || !notification) return event;
    return {
      ...event,
      payload: {
        ...asRecord(event.payload),
        text: notification.summary,
        ...(notification.images?.length ? { images: notification.images } : {}),
        completion: notification.completion,
        verified: notification.verified,
      },
    };
  }

  private withSessionIteration(sessionId: string, event: AgentEvent) {
    let payload = asRecord(event.payload);
    let eventIteration = numberValue(payload.iteration);
    const offset = this.sessionTransportRecoveries.get(sessionId)?.iterationOffset;
    if (eventIteration !== undefined && offset !== undefined) {
      eventIteration += offset;
      payload = { ...payload, iteration: eventIteration };
      event = { ...event, payload };
    }
    if (eventIteration !== undefined)
      this.sessionIterations.set(sessionId, eventIteration);
    if (
      (event.type !== "tool" &&
        event.type !== "text" &&
        event.type !== "reasoning") ||
      eventIteration !== undefined
    )
      return event;
    const iteration = this.sessionIterations.get(sessionId);
    if (iteration === undefined) return event;
    return { ...event, payload: { ...payload, iteration } };
  }

  private withExecutionId(
    sessionId: string,
    event: AgentEvent,
    executionId = this.sessionExecutionIds.get(sessionId),
  ) {
    return executionId ? { ...event, executionId } : event;
  }

  private withToolInput(sessionId: string, event: AgentEvent) {
    if (event.type !== "tool") return event;
    const payload = asRecord(event.payload);
    const toolCall = asRecord(payload.toolCall);
    const toolCallId =
      stringValue(toolCall.id) ?? stringValue(payload.toolCallId);
    if (!toolCallId) return event;
    const key = `${sessionId}:${toolCallId}`;
    const completed = ["cancelled", "failed", "finished"].includes(
      String(payload.phase),
    );
    if (toolCall.input !== undefined) {
      if (completed) this.sessionToolInputs.delete(key);
      else this.sessionToolInputs.set(key, toolCall.input);
      return event;
    }
    const input = this.sessionToolInputs.get(key);
    if (input === undefined) return event;
    if (completed) this.sessionToolInputs.delete(key);
    return {
      ...event,
      payload: { ...payload, toolCall: { ...toolCall, input } },
    };
  }

  private withToolLifecycle(sessionId: string, event: AgentEvent) {
    if (event.type !== "tool") return event;
    const payload = asRecord(event.payload);
    const toolCall = asRecord(payload.toolCall);
    const toolCallId =
      stringValue(toolCall.id) ??
      stringValue(payload.toolCallId) ??
      `tool-${sha256(JSON.stringify(payload)).slice(0, 24)}`;
    const key = `${sessionId}:${toolCallId}`;
    const supplied = numberValue(payload.sequenceNumber);
    const previous = this.sessionToolSequences.get(key) ?? -1;
    const sequenceNumber = supplied ?? previous + 1;
    const phase = normalizedToolPhase(payload);
    if (["cancelled", "failed", "finished"].includes(phase))
      this.sessionToolSequences.delete(key);
    else this.sessionToolSequences.set(key, sequenceNumber);
    return {
      ...event,
      payload: {
        ...payload,
        toolCallId,
        sequenceNumber,
        phase,
        timestamp:
          stringValue(payload.timestamp) ??
          stringValue(payload.ts) ??
          new Date().toISOString(),
        toolCall: { ...toolCall, id: toolCallId },
      },
    };
  }

  private shouldSkipDuplicateSessionEvent(
    sessionId: string,
    event: AgentEvent,
  ) {
    const signature = duplicateEventSignature(event);
    if (!signature) return false;
    const now = Date.now();
    const signatures =
      this.sessionEventSignatures.get(sessionId) ?? new Map<string, number>();
    const previous = signatures.get(signature);
    signatures.set(signature, now);
    this.sessionEventSignatures.set(sessionId, signatures);
    removeOldEventSignatures(signatures, now);
    return previous !== undefined && now - previous < 100;
  }

  private async handleSessionEvent(sessionId: string, event: AgentEvent) {
    if (streamingAgentEvent(event)) return;
    const eventUsage = eventUsageSummary(event);
    const usage = await this.usageForEvent(sessionId, event, eventUsage);
    await this.logSession(sessionId, `event:${event.type}`, eventLogPayload(event));
    if (!usage) return;
    await this.handleUsageUpdate(sessionId, usage);
  }

  private recordNativeCompletion(
    sessionId: string,
    notification: LightCompletionNotification,
    input: RuntimeStartSessionInput,
  ) {
    this.sessionSubmittedSummaries.set(sessionId, notification);
    if (!input.projectId || !notification.memory) return;
    const write = this.projectMemoryPersistence()
      .save(input.apiConnection, input.projectId, notification.memory)
      .then(() => undefined)
      .catch(() => undefined);
    this.sessionMemoryWrites.set(sessionId, write);
    void write.then(() => this.clearProjectMemoryWrite(sessionId, write));
  }

  private clearProjectMemoryWrite(sessionId: string, write: Promise<void>) {
    if (this.sessionMemoryWrites.get(sessionId) === write)
      this.sessionMemoryWrites.delete(sessionId);
  }

  private async loadProjectMemory(input: RuntimeStartSessionInput) {
    if (!input.nativeCompletion || !input.projectId) return undefined;
    try {
      const records = await this.projectMemoryPersistence().list(
        input.apiConnection,
        input.projectId,
      );
      return selectProjectMemory({
        objective: input.taskObjective ?? input.prompt,
        records,
        workspaceRoot: input.workspaceRoot,
      });
    } catch {
      return undefined;
    }
  }

  private projectMemoryPersistence() {
    return (
      this.options.projectMemoryPersistence ?? cloudProjectMemoryPersistence
    );
  }

  private publishProjectMemoryMetrics(
    sessionId: string,
    selection: ProjectMemorySelection,
  ) {
    this.events?.emit(
      this.withExecutionId(sessionId, {
        type: "notice",
        sessionId,
        payload: {
          kind: "project_memory_selected",
          metrics: selection.metrics,
          phase: "completed",
        },
      }),
    );
  }

  private async recordSessionJournalTerminal(
    sessionId: string,
    state: RunTerminalState,
  ) {
    await this.writeSessionJournal(sessionId, {
      kind: "terminal",
      state: lightTerminalState(state),
    });
  }

  private async writeSessionJournal(
    sessionId: string,
    input: SessionJournalInput,
  ) {
    const workspaceRoot = this.sessionStartInputs.get(sessionId)?.config.cwd;
    if (!workspaceRoot) return;
    await writeSessionJournal({
      workspaceRoot,
      sessionId,
      input,
      executor: this.sessionJournalExecutors.get(sessionId),
    });
  }

  private async publishNativeValidationActivity(
    sessionId: string,
    activity: LightValidationActivity,
  ) {
    const event = this.nativeValidationEvent(sessionId, activity);
    this.events?.emit(event);
    await this.handleSessionEvent(sessionId, event);
  }

  private nativeValidationEvent(
    sessionId: string,
    activity: LightValidationActivity,
  ) {
    const event: AgentEvent = {
      type: "tool",
      sessionId,
      payload: {
        phase: activity.phase,
        toolCallId: activity.toolCallId,
        toolName: "run_task",
        toolCall: {
          id: activity.toolCallId,
          name: "run_task",
          input: activity.input,
        },
        ...(activity.output === undefined ? {} : { output: activity.output }),
      },
    };
    return this.withExecutionId(
      sessionId,
      this.withSessionIteration(
        sessionId,
        this.withToolLifecycle(sessionId, event),
      ),
    );
  }

  private async usageForEvent(
    sessionId: string,
    event: AgentEvent,
    eventUsage: AgentUsageSummary | undefined,
  ) {
    if (eventUsage || event.type !== "done") return eventUsage;
    try {
      return await this.readUsage(sessionId);
    } catch {
      return undefined;
    }
  }

  private async handleUsageUpdate(sessionId: string, usage: AgentUsageSummary) {
    const usageSignature = JSON.stringify(summarizeUsage(usage));
    if (this.sessionUsageSignatures.get(sessionId) === usageSignature) return;
    this.sessionUsageSignatures.set(sessionId, usageSignature);
    const context = this.sessionContexts.get(sessionId) ?? { sessionId };
    await this.logSession(sessionId, "usage updated", {
      ...context,
      ...summarizeUsage(usage),
    });
    if (!shouldAbortForUsage(usage, this.productionConfig)) return;
    const executionId = this.sessionExecutionIds.get(sessionId);
    if (executionId && !this.runLifecycles.canInvoke(sessionId, executionId))
      return;
    const message = usageLimitMessage(usage, this.productionConfig);
    this.emitSessionError(sessionId, message);
    await this.abortSession(sessionId, false);
  }

  private unsubscribeSession(sessionId: string) {
    const current = this.sessionReleases.get(sessionId);
    if (current) return current;
    const release = this.releaseSession(sessionId);
    this.sessionReleases.set(sessionId, release);
    void release.then(
      () => this.deleteSessionRelease(sessionId, release),
      () => this.deleteSessionRelease(sessionId, release),
    );
    return release;
  }

  private deleteSessionRelease(sessionId: string, release: Promise<void>) {
    if (this.sessionReleases.get(sessionId) === release)
      this.sessionReleases.delete(sessionId);
  }

  private async releaseSession(sessionId: string) {
    const unsubscribe = this.unsubscribers.get(sessionId);
    this.unsubscribers.delete(sessionId);
    try {
      unsubscribe?.();
    } catch {
      // Session cleanup must continue even when a provider unsubscribe fails.
    }
    this.clearSessionState(sessionId);
    await this.sessionMemoryWrites.get(sessionId)?.catch(() => undefined);
    this.sessionMemoryWrites.delete(sessionId);
    const logFile = this.sessionLogFiles.get(sessionId);
    this.sessionLogFiles.delete(sessionId);
    await this.sessionLogWrites.get(sessionId)?.catch(() => undefined);
    if (logFile)
      await appendLog(logFile, "session unsubscribed").catch(() => undefined);
    this.sessionLogWrites.delete(sessionId);
  }

  private clearSessionState(sessionId: string) {
    this.clearSessionInactivityWatchdog(sessionId);
    const lifecycle = this.runLifecycles.state(sessionId);
    const terminationActive = lifecycle?.state === "cancelling";
    this.autoApprovedWriteToolSessions.delete(sessionId);
    this.clineDefaultSessions.delete(sessionId);
    this.sessionContexts.delete(sessionId);
    this.sessionJournalExecutors.delete(sessionId);
    this.sessionEventSignatures.delete(sessionId);
    if (!terminationActive) this.sessionExecutionIds.delete(sessionId);
    this.sessionIterations.delete(sessionId);
    this.sessionCompletedToolIds.delete(sessionId);
    this.sessionSubmittedSummaries.delete(sessionId);
    this.sessionNativeFinish.delete(sessionId);
    this.sessionDeferredTaskBriefings.delete(sessionId);
    this.sessionSpawnAgentActiveCounts.delete(sessionId);
    for (const key of this.sessionToolInputs.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.sessionToolInputs.delete(key);
    }
    for (const key of this.sessionToolSequences.keys()) {
      if (key.startsWith(`${sessionId}:`))
        this.sessionToolSequences.delete(key);
    }
    this.sessionUsageSignatures.delete(sessionId);
    this.sessionInactivityTimeouts.delete(sessionId);
    this.sessionTransportRecoveries.delete(sessionId);
    this.sessionTerminalDrains.delete(sessionId);
    if (!terminationActive) {
      this.runLifecycles.remove(sessionId);
      this.sessionTerminations.delete(sessionId);
      this.sessionTerminationWatchdogs.delete(sessionId);
    }
    this.sessionBackendKeys.delete(sessionId);
    this.sessionApiConnections.delete(sessionId);
    this.sessionStartInputs.delete(sessionId);
    this.sessionPersonalization.delete(sessionId);
    this.userInstructionServices.stop(sessionId);
    this.structuredEventSessions.delete(sessionId);
  }

  private shouldSkipSessionDisplayEvent(
    sessionId: string,
    event: CoreSessionEvent,
  ) {
    const spawnAgentActive =
      (this.sessionSpawnAgentActiveCounts.get(sessionId) ?? 0) > 0;
    return !shouldDisplayClineSessionEvent(event, spawnAgentActive);
  }

  private updateSessionSpawnAgentState(
    sessionId: string,
    phase: "started" | "finished",
  ) {
    const current = this.sessionSpawnAgentActiveCounts.get(sessionId) ?? 0;
    const next = nextSpawnAgentActiveCount(current, phase);
    if (next) {
      this.sessionSpawnAgentActiveCounts.set(sessionId, next);
      return;
    }
    this.sessionSpawnAgentActiveCounts.delete(sessionId);
  }

  private shouldSkipFallbackChunk(sessionId: string, event: CoreSessionEvent) {
    if (event.type === "agent_event") {
      this.structuredEventSessions.add(sessionId);
      return false;
    }
    return (
      event.type === "chunk" &&
      event.payload.stream === "agent" &&
      this.structuredEventSessions.has(sessionId)
    );
  }

  private async activeSessionIds() {
    const sessionIds = new Set(this.unsubscribers.keys());
    await Promise.all(
      Array.from(this.clines.values()).map(async (core) => {
        try {
          const sessions = (await (
            await core
          ).list(50)) as RuntimeSessionSummary[];
          sessions.forEach((session) => {
            if (session.sessionId) sessionIds.add(session.sessionId);
          });
        } catch {
          // A failed provider listing must not prevent the remaining sessions from closing.
        }
      }),
    );

    return Array.from(sessionIds);
  }

  private resolvePendingApprovals() {
    this.pendingApprovals.forEach((approval) =>
      approval.resolve({ approved: false, reason: stoppedApprovalReason }),
    );
    this.pendingApprovals.clear();
    this.alwaysAllowedTools.clear();
    this.autoApprovedWriteToolSessions.clear();
  }

  private requestApproval(
    request: ToolApprovalRequest,
  ): Promise<ToolApprovalResult> | ToolApprovalResult {
    const toolName = request.toolName ?? request.name ?? "unknown";
    const clineDefault =
      request.sessionId && this.clineDefaultSessions.has(request.sessionId);
    const blockedReason = clineDefault
      ? undefined
      : blockedToolReason(toolName, request.input);
    if (blockedReason) {
      if (request.sessionId)
        this.emitSessionError(request.sessionId, blockedReason);
      return { approved: false, reason: blockedReason };
    }
    if (
      !writeTools.includes(toolName) ||
      this.alwaysAllowedTools.has(toolName) ||
      (request.sessionId &&
        this.autoApprovedWriteToolSessions.has(request.sessionId))
    ) {
      this.events?.emit({
        type: "notice",
        sessionId: request.sessionId,
        payload: { message: `Auto-approved tool: ${toolName}` },
      });
      if (request.sessionId)
        void this.logSession(request.sessionId, "tool auto-approved", request);
      return { approved: true };
    }

    return new Promise((resolve) => {
      const approval = toApprovalRequest(request, toolName);
      this.pendingApprovals.set(approval.id, { request: approval, resolve });
      if (approval.sessionId)
        void this.logSession(
          approval.sessionId,
          "tool approval requested",
          approval,
        );
      this.events?.emit({
        type: "approval",
        sessionId: approval.sessionId,
        payload: approval,
      });
    });
  }

  private resolveApproval(input: ResolveApprovalInput) {
    const pending = this.pendingApprovals.get(input.requestId);
    if (!pending) return false;

    this.pendingApprovals.delete(input.requestId);
    if (input.decision === "always")
      this.alwaysAllowedTools.add(pending.request.toolName);
    if (pending.request.sessionId) {
      void this.logSession(
        pending.request.sessionId,
        "tool approval resolved",
        {
          toolName: pending.request.toolName,
          decision: input.decision,
        },
      );
    }
    pending.resolve(
      input.decision === "deny"
        ? { approved: false, reason: USER_REJECTED_TOOL_REASON }
        : { approved: true },
    );
    return true;
  }

  private async loginOAuth(input: LoginOAuthProviderInput) {
    const provider = await this.oauthProvider(input.providerId);
    const credentials = await provider.login({
      onAuth: (info: { url: string; instructions?: string }) => {
        this.options.openExternalUrl?.(info.url);
        this.events?.emit({
          type: "notice",
          payload: {
            providerId: input.providerId,
            message: info.instructions ?? "OAuth login opened.",
          },
        });
      },
      onPrompt: async (prompt: OAuthPrompt) => prompt.defaultValue ?? "",
      onProgress: (message: string) => {
        this.events?.emit({
          type: "notice",
          payload: { providerId: input.providerId, message },
        });
      },
      onServerListening: (info: OAuthServerListeningInfo) => {
        this.events?.emit({
          type: "notice",
          payload: {
            providerId: input.providerId,
            message: `Waiting for OAuth callback on ${info.callbackUrl}`,
          },
        });
      },
      onServerClose: () => {
        this.events?.emit({
          type: "notice",
          payload: {
            providerId: input.providerId,
            message: "OAuth callback server closed.",
          },
        });
      },
    });

    return saveOAuthCredential(input.apiConnection, {
      providerId: input.providerId,
      label: input.label,
      apiKey: provider.getApiKey(credentials),
      oauthCredentials: toBlameOAuthCredentials(credentials),
      baseUrl: input.baseUrl ?? null,
    });
  }

  private async refreshOAuthCredential(
    connection: ApiConnection,
    credential: Awaited<ReturnType<typeof resolveProviderCredential>>,
    options: { force?: boolean } = {},
  ) {
    if (credential.authMethod !== "oauth" || !credential.oauthCredentials)
      return credential;
    if (
      !options.force &&
      credential.oauthCredentials.expires > Date.now() + 60_000
    )
      return credential;

    const provider = await this.oauthProvider(credential.providerId);
    let refreshed: Awaited<ReturnType<typeof provider.refreshToken>>;
    try {
      refreshed = await provider.refreshToken(credential.oauthCredentials);
    } catch (error) {
      // A failed proactive refresh keeps a token that is still valid.
      if (credential.oauthCredentials.expires > Date.now() + 60_000)
        return credential;
      throw error;
    }
    const saved = await saveOAuthCredential(connection, {
      providerId: credential.providerId,
      label: credential.label,
      apiKey: provider.getApiKey(refreshed),
      oauthCredentials: toBlameOAuthCredentials(refreshed),
      baseUrl: credential.baseUrl,
    });

    return {
      ...credential,
      apiKey: provider.getApiKey(refreshed),
      oauthCredentials: toBlameOAuthCredentials(refreshed),
      authMethod: saved.authMethod,
    };
  }

  private async syncClineOAuthProviderSettings(
    credential: Awaited<ReturnType<typeof resolveProviderCredential>>,
  ) {
    if (credential.authMethod !== "oauth" || !credential.oauthCredentials)
      return;
    if (!supportedClineOAuthProvider(credential.providerId)) return;
    const sdk = await import("@cline/sdk");
    const providerId = sdk.normalizeOAuthProvider(credential.providerId);
    const manager = new sdk.ProviderSettingsManager();
    const existing = manager.getProviderSettings(providerId);
    sdk.saveLocalProviderOAuthCredentials(manager, providerId, existing, {
      access: credential.oauthCredentials.access,
      refresh: credential.oauthCredentials.refresh,
      expires: credential.oauthCredentials.expires,
      accountId:
        credential.oauthCredentials.accountId ??
        credential.oauthCredentials.email,
    });
  }

  private async oauthProvider(
    providerId: string,
  ): Promise<OAuthProviderInterface> {
    const sdk = await import("@cline/sdk");
    if (providerId === "openai-codex") return openAICodexOAuthProvider(sdk);
    if (providerId === "cline" || providerId === "opencode") {
      return clineOAuthProvider(sdk, providerId);
    }
    if (providerId === "oca") return ocaOAuthProvider(sdk);
    throw new Error(`OAuth is not supported for provider ${providerId}`);
  }

  private emitSessionNotice(sessionId: string, message: string) {
    void this.logSession(sessionId, "notice", { message });
    this.events?.emit(
      this.withExecutionId(sessionId, {
        type: "notice",
        sessionId,
        payload: { message },
      }),
    );
  }

  private emitSessionError(
    sessionId: string,
    message: string,
    error: unknown = message,
    executionId?: string,
  ) {
    void this.logSession(sessionId, "error", { message });
    this.events?.emit(
      this.withExecutionId(
        sessionId,
        {
          type: "error",
          sessionId,
          payload: { message, ...clineErrorMetadata(error) },
        },
        executionId,
      ),
    );
  }

  private async logSession(
    sessionId: string,
    message: string,
    payload?: unknown,
  ) {
    const file = this.sessionLogFiles.get(sessionId);
    if (!file) return;
    const precedingWrite = this.sessionLogWrites.get(sessionId);
    const write = (precedingWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => appendLog(file, message, payload));
    this.sessionLogWrites.set(sessionId, write);
    await write;
  }

  private async disposeCore() {
    const clines = Array.from(this.clines.values());
    this.clines.clear();
    this.sessionBackendKeys.clear();
    this.sessionStartInputs.clear();
    this.sessionInactivityTimeouts.clear();
    await Promise.allSettled(
      clines.map(async (cline) => (await cline).dispose("Shutting down")),
    );
  }

  private async startDevelopmentSession(request: StartDevelopmentSessionInput) {
    const id = request.resumeSessionId?.trim() || request.sessionId?.trim() || createBlameSessionId();
    const input = await conversationWorkspace({ ...request, sessionId: id }, id);
    if (this.options.developmentHarness === "cline") {
      return this.startClineDevelopmentSession(input);
    }
    const attachedSession = this.attachedSession(input.resumeSessionId);
    if (attachedSession) {
      this.sessionApiConnections.set(
        attachedSession.sessionId,
        input.apiConnection,
      );
      await this.logSession(
        attachedSession.sessionId,
        "development session reused",
      );
      return attachedSession;
    }
    const resumeSessionId = input.resumeSessionId?.trim();
    const conversationId =
      resumeSessionId || input.sessionId?.trim() || createBlameSessionId();
    const initialMessages =
      input.autoSendPrompt === false
        ? await this.resumeMessages(resumeSessionId, input.backend)
        : undefined;
    const initialCompactionState = initialMessages
      ? await this.resumeCompactionState(resumeSessionId, input.backend)
      : undefined;
    const developmentInput = await developmentUserInput(
      input,
      newAttachmentDirectory(input.workspaceRoot),
      this.developmentAttachmentStorage(input),
    );
    const compaction = blameCompactionConfig(this.productionConfig);
    const enableSpecialistConsult = developmentSpecialistConsultEnabled(input);
    const conversation = conversationSessionOptions(input);
    // open_component_preview exists only where the desktop offers it and
    // this runtime can render it: the prompt describes exactly that.
    const componentPreview =
      input.componentPreview === true && Boolean(this.options.componentPreview);
    const session = await this.startSession({
      ...conversation,
      apiConnection: input.apiConnection,
      providerId: input.providerId,
      modelId: input.modelId,
      credentialLabel: input.credentialLabel,
      reasoningEffort: input.reasoningEffort,
      maxInputTokens: input.maxInputTokens,
      configExtensions: input.configExtensions,
      disableMcpSettingsTools: input.disableMcpSettingsTools,
      autoApproveWriteTools: true,
      autoSendPrompt: input.autoSendPrompt !== false,
      sessionId: conversationId,
      initialMessages,
      initialCompactionState,
      mode: "act",
      maxIterations: input.maxIterations,
      prompt: developmentInput.prompt,
      taskObjective: developmentInput.prompt,
      requiredChecks: input.requiredChecks,
      userImages: developmentInput.userImages,
      pluginPaths: input.pluginPaths,
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      workspaceMode: input.workspaceMode,
      previewDevtoolsScope: input.previewDevtoolsScope,
      componentPreview,
      isolatedEnvironment: input.isolatedEnvironment,
      systemPrompt: await buildDevelopmentSystemPrompt({
        ...input,
        componentPreview,
      }),
      enableBuiltInSkills: true,
      enableSpecialistConsult,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      nativeCompletion: true,
      compaction,
      backend: input.backend,
      executionId: input.executionId,
      projectId: input.projectId,
      storyId: input.storyId,
      personalization: input.personalization,
      projectInitialization: input.projectInitialization,
    });
    this.sessionApiConnections.set(session.sessionId, input.apiConnection);
    return session;
  }

  private developmentPreviewOptions(
    input: RuntimeStartSessionInput,
  ): RuntimeOptions {
    if (
      !input.projectInitialization ||
      !this.options.applyPreviewInitialization ||
      !this.options.repairProjectInitialization
    ) {
      return this.options;
    }
    const state = { initialization: input.projectInitialization };
    return {
      ...this.options,
      repairPreviewInitialization: (preview) =>
        this.repairDevelopmentPreview(input, preview, state),
    };
  }

  private async repairDevelopmentPreview(
    input: RuntimeStartSessionInput,
    preview: PreviewRuntimeContext,
    state: DevelopmentPreviewState,
  ) {
    const repair = await this.options.repairProjectInitialization!(
      await this.developmentPreviewRepairInput(input, preview, state),
    );
    if (!repair.previewManifest || !repair.runConfigurations) {
      return {
        classification: repair.classification,
        reason: repair.reason,
        status: "not_repairable" as const,
      };
    }
    const applied = await this.options.applyPreviewInitialization!({
      ...preview,
      databaseMode: state.initialization.databaseMode ?? "compose",
      previewManifest: repair.previewManifest,
      reason: repair.reason,
      repairSessionId: repair.session,
      runConfigurations: repair.runConfigurations,
    });
    if (applied.status === "applied") {
      state.initialization = {
        ...state.initialization,
        previewManifest: repair.previewManifest,
        runConfigurations: repair.runConfigurations,
      };
    }
    return {
      ...applied,
      classification: repair.classification,
      reason: repair.reason,
    };
  }

  private async developmentPreviewRepairInput(
    input: RuntimeStartSessionInput,
    preview: PreviewRuntimeContext,
    state: DevelopmentPreviewState,
  ): Promise<RepairProjectInitializationTask> {
    return {
      model: {
        providerId: input.providerId,
        modelId: input.modelId,
        credentialLabel: input.credentialLabel,
        reasoning: input.reasoningEffort,
      },
      projectId: input.projectId,
      workspace: { root: input.workspaceRoot },
      previewManifest: state.initialization.previewManifest,
      runConfigurations: state.initialization.runConfigurations,
      preferences: {
        database: { mode: state.initialization.databaseMode ?? "compose" },
      },
      diagnostics: await this.previewInitializationDiagnostics(preview),
    };
  }

  private async previewInitializationDiagnostics(
    preview: PreviewRuntimeContext,
  ) {
    const [target, logs] = await Promise.all([
      this.options.previewDevtools?.({ ...preview, waitFor: "none" }),
      this.options.previewContainerLogs?.(preview),
    ]);
    return {
      setupLog: "",
      launchError:
        target?.message ?? "Managed preview initialization is obsolete.",
      composeConfig: "",
      composePs: "",
      serviceLogs: {
        preview: JSON.stringify(logs ?? {}).slice(0, 32_000),
      },
    };
  }

  private async startClineDevelopmentSession(
    input: StartDevelopmentSessionInput,
  ) {
    return this.startSession({
      apiConnection: input.apiConnection,
      autoSendPrompt: input.autoSendPrompt !== false,
      checkpointEnabled: input.checkpointEnabled,
      clineDefaultTools: true,
      configExtensions: [],
      credentialLabel: input.credentialLabel,
      cwd: input.cwd,
      maxIterations: input.maxIterations,
      mode: "act",
      modelId: input.modelId,
      prompt: input.summary,
      providerId: input.providerId,
      reasoningEffort: input.reasoningEffort,
      systemPrompt: await clineDefaultSystemPrompt(input),
      workspaceRoot: input.workspaceRoot,
    });
  }

  private attachmentDirectory(sessionId: string) {
    const config = this.sessionStartInputs.get(sessionId)?.config;
    return newAttachmentDirectory(config?.workspaceRoot ?? config?.cwd ?? process.cwd());
  }

  private developmentAttachmentStorage(input: StartDevelopmentSessionInput) {
    const executor = managedLightWorkspaceExecutor(
      this.options.lightWorkspace,
      {
        backendMode: input.backend?.mode,
        workspaceMode: input.workspaceMode,
      },
    );
    return executor ? { executor, workspaceRoot: input.workspaceRoot } : undefined;
  }

  private sessionAttachmentStorage(sessionId: string) {
    const executor = this.sessionJournalExecutors.get(sessionId);
    const config = this.sessionStartInputs.get(sessionId)?.config;
    const workspaceRoot = config?.workspaceRoot ?? config?.cwd;
    return executor && workspaceRoot ? { executor, workspaceRoot } : undefined;
  }

  private sendPrompt(
    cline: ClineCore,
    sessionId: string,
    prompt: string,
    attachments: Pick<SendSessionInput, "userFiles" | "userImages"> = {},
    executionId?: string,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const activeExecutionId =
      executionId ?? this.sessionExecutionIds.get(sessionId) ?? sessionId;
    if (!this.runLifecycles.canInvoke(sessionId, activeExecutionId))
      return Promise.reject(
        new Error(
          "The execution is no longer running; no model call was made.",
        ),
      );
    this.armSessionInactivityWatchdog(sessionId, activeExecutionId, cline);
    const result: Promise<unknown> = cline
      .send({
        sessionId,
        prompt,
        ...(attachments.userImages?.length
          ? { userImages: attachments.userImages }
          : {}),
        ...(attachments.userFiles?.length
          ? { userFiles: attachments.userFiles }
          : {}),
      })
      .then(async (result: unknown): Promise<unknown> => {
        const terminalDrain = this.sessionTerminalDrains.get(sessionId);
        await terminalDrain;
        const lifecycle = this.runLifecycles.state(sessionId);
        if (
          lifecycle?.execution_id === activeExecutionId &&
          lifecycle.state !== "running"
        )
          return result;
        void this.logSession(
          sessionId,
          "send resolved",
          sendResultLogPayload(result, Date.now() - startedAt),
        );
        const failure = this.sessionResultFailure(
          sessionId,
          activeExecutionId,
          result,
        );
        if (failure) {
          if (
            this.shouldRecoverTransportFailure(
              sessionId,
              activeExecutionId,
              failure,
            )
          )
            return this.resumeTransportInterruption(
              cline,
              sessionId,
              activeExecutionId,
            );
          this.sessionTransportRecoveries.delete(sessionId);
          const terminalState = terminalStateFromResult(result);
          await this.terminateSessionExecution({
            cline,
            display: true,
            event: this.withExecutionId(
              sessionId,
              {
                type: "error",
                sessionId,
                payload: { message: failure, ...clineErrorMetadata(failure) },
              },
              activeExecutionId,
            ),
            executionId: activeExecutionId,
            reason: `Cline send returned ${terminalState}`,
            sessionId,
            terminalState,
          });
          return result;
        }
        this.sessionTransportRecoveries.delete(sessionId);
        if (!terminalDrain) {
          await this.terminateSessionExecution({
            cline,
            display: true,
            event: this.withSubmittedSummary(
              sessionId,
              this.withExecutionId(
                sessionId,
                {
                  type: "done",
                  sessionId,
                  payload: doneResultPayload(result),
                },
                activeExecutionId,
              ),
            ),
            executionId: activeExecutionId,
            reason: "Cline send resolved",
            sessionId,
            terminalState: "succeeded",
          });
        }
        return result;
      })
      .catch(async (error: unknown): Promise<unknown> => {
        const lifecycle = this.runLifecycles.state(sessionId);
        if (
          lifecycle?.execution_id === activeExecutionId &&
          lifecycle.state !== "running"
        )
          return lifecycle.state === "succeeded"
            ? undefined
            : Promise.reject(error);
        const message = errorMessage(error);
        if (
          this.shouldRecoverTransportFailure(
            sessionId,
            activeExecutionId,
            error,
          )
        )
          return this.resumeTransportInterruption(
            cline,
            sessionId,
            activeExecutionId,
          );
        this.sessionTransportRecoveries.delete(sessionId);
        void this.logSession(sessionId, "send failed", {
          durationMs: Date.now() - startedAt,
          errorType: errorType(error),
          message,
          status: "failed",
        });
        await this.terminateSessionExecution({
          cline,
          display: true,
          event: this.withExecutionId(
            sessionId,
            {
              type: "error",
              sessionId,
              payload: { message, ...clineErrorMetadata(error) },
            },
            activeExecutionId,
          ),
          executionId: activeExecutionId,
          reason: "Cline send failed",
          sessionId,
          terminalState: "failed",
        });
        throw error;
      });
    void this.logSession(sessionId, "prompt sent", {
      ...promptMetadata(prompt),
    });
    return result;
  }
}

export function createClineBaselineRuntime(events?: AgentRuntimeEvents) {
  return new BlameAgentRuntime(events, { developmentHarness: "cline" });
}

function createBlameSessionId() {
  return `${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 5)}`;
}

async function settleWithTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<
  | { status: "completed" }
  | { error: unknown; status: "failed" }
  | { status: "timeout" }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ error, status: "failed" as const }),
    ),
    new Promise<{ status: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function terminationWatchdogPause(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref?.();
  });
}

export function clineErrorMetadata(error: unknown) {
  const message = errorMessage(error);
  if (
    isClineNotSubscribedError(error) ||
    isClineNotSubscribedMessage(message)
  ) {
    return {
      code: "cline_not_subscribed",
      actionUrl: getClinePassSubscriptionUrl(),
    };
  }
  if (
    isClineOrgIndividualInferenceSubscriptionError(error) ||
    isClineOrgIndividualInferenceSubscriptionMessage(message)
  ) {
    return { code: "cline_org_subscription_unsupported" };
  }
  if (isClinePassLimitError(error) || isClinePassLimitMessage(message)) {
    return {
      code: "cline_pass_limit",
      actionUrl: getClinePassSubscriptionUrl(),
    };
  }
  if (
    isClineFreeModelLimitError(error) ||
    isClineFreeModelLimitMessage(message)
  ) {
    return {
      code: "cline_free_model_limit",
      resetAt: extractClineFreeModelLimitResetTime(message),
    };
  }
  if (isClineModelNotFoundMessage(message)) {
    return { code: "cline_model_not_found" };
  }
  return {};
}

function credentialLabel(input: RuntimeCredentialInput) {
  if (input.credentialLabel) return input.credentialLabel;
  if (input.providerId === openAICompatibleProviderID) return input.modelId;
  return undefined;
}

function startContext(input: StartSessionInput) {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    checkpointEnabled: input.checkpointEnabled,
    configExtensions: input.configExtensions?.join(","),
    disableMcpSettingsTools: input.disableMcpSettingsTools,
    mode: input.mode ?? "act",
    maxIterations: input.maxIterations,
    pluginPathCount: input.pluginPaths?.length ?? 0,
    ...promptMetadata(input.prompt),
  };
}

function sessionContext(
  input: StartSessionInput,
  sessionId: string,
): ProductionSessionContext {
  return {
    maxIterations: input.maxIterations,
    mode: input.mode ?? "act",
    modelId: input.modelId,
    providerId: input.providerId,
    checkpointEnabled: input.checkpointEnabled,
    configExtensions: input.configExtensions?.join(","),
    disableMcpSettingsTools: input.disableMcpSettingsTools,
    pluginPathCount: input.pluginPaths?.length ?? 0,
    sessionId,
  };
}

function adaptiveModelInactivityTimeoutMs(
  reasoningEffort: unknown,
  configured?: number,
) {
  if (configured !== undefined) return configured;
  const effort = String(reasoningEffort ?? "").toLowerCase();
  if (["xhigh", "max", "ultra"].includes(effort)) return 300_000;
  if (effort === "high") return 240_000;
  if (effort === "medium") return 210_000;
  return defaultModelInactivityTimeoutMs;
}

export function workspaceSessionIds(
  sessionLogFiles: ReadonlyMap<string, string>,
  workspace: string,
) {
  return Array.from(sessionLogFiles)
    .filter(([, file]) => pathInsideWorkspace(file, workspace))
    .map(([sessionId]) => sessionId);
}

function pathInsideWorkspace(path: string, workspace: string) {
  const relativePath = relative(resolve(workspace), resolve(path));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

export function resultFailureMessage(result: unknown) {
  const payload = asRecord(result);
  const status = incompleteResultStatus(payload);
  if (!status) return undefined;
  return resultFailureDetail(result) ?? terminalProductMessage(status);
}

function resultFailureDetail(result: unknown) {
  const payload = asRecord(result);
  const error = asRecord(payload.error);
  return (
    stringValue(error.message) ??
    stringValue(payload.error) ??
    stringValue(payload.message)
  );
}

