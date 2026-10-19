import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { imageAwareCompaction } from "./image-compaction.js";

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
  OAuthCredentials as ClineOAuthCredentials,
  CoreSessionEvent,
  ContentBlock,
  Message,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthProviderInterface,
  OAuthServerListeningInfo,
} from "@cline/sdk";

import { type Context } from "@blame/telemetry";

import { AgentTelemetry } from "./agent-telemetry.js";
import { assertTargetChangesRestorable, stashTargetChanges, type TargetChangesStash } from "./approve-merge-git.js";
import {
  codePracticesConfig,
  codePracticesPrompt,
  collectProjectInitializationAttempt,
  collectProjectInitializationRepairAttempt,
  combinedTaskBriefing,
  initializationConfig,
  initializationCorrection,
  initializationPrompt,
  parseProjectInitializationAttempt,
  parseProjectInitializationRepairAttempt,
  parsedCodePracticesAttempt,
  projectCodePracticesSubmitTool,
  projectInitializationRepairSubmitTool,
  projectInitializationSubmitTool,
  type AgentTool,
  type CodePracticesAttemptOutcome,
  type InitializationCorrection,
  type ProjectCodePracticesAttempt,
  type ProjectInitializationRepairAttempt,
  type RuntimeClineResult,
  type RuntimeSessionSummary,
} from "./cline-initialization.js";
import {
  backendKey,
  blameNativePluginPath,
  clineDefaultToolPolicies,
  codePracticesToolPolicies,
  commitMessageConfig,
  coreBackendOptions,
  extensionContext,
  initializationImpactConfig,
  initializationRepairConfig,
  initializationToolPolicies,
  mergeConflictConfig,
  mergeConflictToolPolicies,
  newProjectGenerationConfig,
  newProjectGenerationToolPolicies,
  productionLogger,
  toolPolicies,
  withConfigExtensions,
  type CommitMessageRuntimeInput,
  type MergeConflictRuntimeInput,
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
  approveMergeLogPath,
  blameTelemetry,
  commitMessageLogPath,
  mergeConflictLogPath,
  sessionLogPath,
  startLogPath,
} from "./cline-runtime-log.js";
import {
  buildDevelopmentSystemPrompt,
  clineDefaultSystemPrompt,
  developmentUserInput,
  newAttachmentDirectory,
  newProjectGenerationMaxIterations,
  newProjectGenerationPrompt,
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
import { fallbackCommitSubject } from "./commit-message.js";
import { loadCatalogModel } from "./supplemental-model-config.js";
import { createContextProjectionExtension } from "./context-projection.js";
import {
  appendInitialTaskBriefing,
  createInitialTaskBriefing,
} from "./harness/initial-task-briefing.js";
import {
  type LightCompletionNotification,
  type LightValidationActivity,
} from "./harness/light-completion.js";
import {
  managedLightWorkspaceExecutor,
  writeSessionJournal,
  type LightWorkspaceExecutor,
  type SessionJournalInput,
} from "./harness/light-executor.js";
import { sha256 } from "./harness/light-identity.js";
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
import type { ProductionSessionContext } from "./production.js";
import {
  appendProductionConfig,
  applyProductionEnvironment,
  assertRepositoryPath,
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
import {
  scanProjectCodePractices,
  type ProjectCodePracticesScan,
} from "./project-code-practices-scan.js";
import {
  collectProjectInitializationImpactDiagnostics,
  deterministicInitializationImpact,
  parseProjectInitializationImpactResult,
  projectInitializationImpactPrompt,
} from "./project-initialization-impact.js";
import { projectInitializationRepairPrompt } from "./project-initialization-repair.js";
import type { ProjectInitializationScan } from "./project-initialization.js";
import { scanProjectForInitialization } from "./project-initialization.js";
import { loadPrompt } from "./prompt-loader.js";
import { optimizeUserStoryPrompt } from "./prompt-optimization.js";
import { createProviderCompatibleFetch } from "./provider-schema-compatibility.js";
import { reasoningConfig } from "./reasoning.js";
import {
  runSecurityDiscovery,
  runSecurityValidation,
} from "./security-audit-runtime.js";
import { scanSecurityAuditRepository } from "./security-audit-scan.js";
import { developmentSpecialistConsultEnabled } from "./specialist-agents.js";
import { taskComplexityBucket } from "./telemetry-cohorts.js";
import { generateTitle } from "./title-generation.js";
import type {
  AgentApprovalRequest,
  AgentBackendConfig,
  AgentEvent,
  AgentRuntimeEvents,
  AgentRuntimePrewarmInput,
  AgentUsageSummary,
  AnalyzeProjectCodePracticesInput,
  AnalyzeProjectCodePracticesResult,
  ApiConnection,
  ApproveAndMergeInput,
  ApproveAndMergeResult,
  AssessProjectInitializationImpactInput,
  AssessProjectInitializationImpactResult,
  CompareCheckpointInput,
  CompareCheckpointResult,
  DiscoverSecurityAuditInput,
  GenerateCommitMessageInput,
  GenerateCommitMessageResult,
  GenerateTitleInput,
  GenerateTitleResult,
  InitializeProjectInput,
  InitializeProjectResult,
  LoginOAuthProviderInput,
  MapSecurityAuditInput,
  NewProjectGenerationResult,
  OAuthCredentials,
  OptimizeUserStoryPromptInput,
  OptimizeUserStoryPromptResult,
  RepairProjectInitializationInput,
  RepairProjectInitializationResult,
  ResolveApprovalInput,
  ResolveMergeConflictsInput,
  ResolveMergeConflictsResult,
  RestoreCheckpointInput,
  RestoreCheckpointResult,
  SaveProviderCredentialInput,
  SendDevelopmentSessionInput,
  SendSessionInput,
  StartDevelopmentSessionInput,
  StartNewProjectGenerationInput,
  StartSessionInput,
  ValidateSecurityAuditInput,
} from "./types.js";
import { BlameUserInstructionServices, skillScopeSystemPrompt } from "./user-instruction-services.js";
import {
  createTextWebFetchExecutor,
  describeTextWebFetch,
} from "./web-fetch.js";
import {
  advanceTargetBranch,
  assertGitRepository,
  cleanGitStatus,
  currentGitBranch,
  setGitRunner,
  git,
  type GitUpstream,
  hasMergeConflicts,
  hasPendingMerge,
  integrationWorktree,
  mergeConflictFiles,
  optionalGitUpstream,
  pullIntegrationWorktree,
  pushIntegrationWorktree,
  removeIntegrationWorktree,
  restoreTargetChanges,
  validateMergeBranches,
} from "./runtime-git.js";

export {
  backendKey,
  blameNativePluginPath,
  clineDefaultToolPolicies,
  coreBackendOptions,
  initializationToolPolicies,
  newProjectGenerationToolPolicies,
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
const defaultSessionMaxIterations = 32;
const developmentSessionMaxIterations = 64;
const maxInitializationAttempts = 3;
const maxMergeConflictResolutionAttempts = 3;
const runtimeArtifactPaths = [".blame", ".blame-preview", ".pnpm-store"];
const runtimeArtifactPathspecs = runtimeArtifactPaths.map(
  (path) => `:!${path}`,
);
const openAICompatibleProviderID = "openai-compatible";
const runtimePrewarmSessionId = "blame-runtime-prewarm";
const cloudProjectMemoryPersistence: ProjectMemoryPersistence = {
  list: listProjectMemories,
  save: saveProjectMemory,
};

type ToolApprovalResult = {
  approved: boolean;
};

type RuntimeCredentialInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId?: string;
  credentialLabel?: string;
};

type ClineSdk = typeof import("@cline/sdk");

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

type InitializationCredential = {
  apiKey: string;
  authMethod?: string;
  baseUrl: string | null;
};

type StoryMergePreparation = {
  baseCommit: string;
  integration: string;
  targetBranch: string;
  targetClean: boolean;
  upstream?: GitUpstream;
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
  private activeSecurityAuditSessions = new Map<
    string,
    Map<string, ClineCore>
  >();
  private cancelledSecurityAudits = new Set<string>();
  private sessionBackendKeys = new Map<string, string>();
  private readonly agentTelemetry = new AgentTelemetry();
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
  private sessionQualityBaselines = new Map<string, string>();
  private clineDefaultSessions = new Set<string>();
  private sessionEventSignatures = new Map<string, Map<string, number>>();
  private sessionExecutionIds = new Map<string, string>();
  private sessionToolInputs = new Map<string, unknown>();
  private sessionToolSequences = new Map<string, number>();
  private sessionCompletedToolIds = new Map<string, Set<string>>();
  private sessionSubmittedSummaries = new Map<
    string,
    LightCompletionNotification
  >();
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
    unsubscribe: (sessionId: string) => this.unsubscribeSession(sessionId),
    releaseWorkspace: (workspace: string) =>
      this.releaseWorkspaceSessions(workspace),
  };

  approvals = {
    resolve: (input: ResolveApprovalInput) => this.resolveApproval(input),
  };

  initializations = {
    run: (input: InitializeProjectInput) => this.initializeProject(input),
    repair: (input: RepairProjectInitializationInput) =>
      this.repairProjectInitialization(input),
    assessImpact: (input: AssessProjectInitializationImpactInput) =>
      this.assessProjectInitializationImpact(input),
  };

  codePractices = {
    run: (input: AnalyzeProjectCodePracticesInput) =>
      this.analyzeProjectCodePractices(input),
  };

  securityAudits = {
    map: (input: MapSecurityAuditInput) => this.mapSecurityAudit(input),
    discover: (input: DiscoverSecurityAuditInput) =>
      this.discoverSecurityAudit(input),
    validate: (input: ValidateSecurityAuditInput) =>
      this.validateSecurityAudit(input),
    cancel: (auditId: string) => this.cancelSecurityAudit(auditId),
    finish: (auditId: string) => this.finishSecurityAudit(auditId),
  };

  newProjects = {
    generate: (input: StartNewProjectGenerationInput) =>
      this.generateNewProject(input),
  };

  promptOptimizer = {
    optimizeUserStory: (input: OptimizeUserStoryPromptInput) =>
      this.optimizeUserStoryPrompt(input),
    generateTitle: (input: GenerateTitleInput) => this.generateTitle(input),
  };

  approveAndMerge = (input: ApproveAndMergeInput) =>
    this.approveAndMergeStory(input);

  generateCommitMessage = (input: GenerateCommitMessageInput) =>
    this.generateWorkspaceCommitMessage(input);

  resolveMergeConflicts = (input: ResolveMergeConflictsInput) =>
    this.resolveWorkspaceMergeConflicts(input);

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
    this.userInstructionServices.stopAll();
    this.agentTelemetry.shutdown();
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
    this.agentTelemetry.start(sessionId, {
      ...input,
      taskComplexityBucket: sessionTaskComplexity(input),
    });
    const telemetryContext = this.agentTelemetry.context(sessionId);
    const startLogFile = startLogPath(input.cwd);
    await appendLog(
      startLogFile,
      "start requested",
      startContext(input),
      telemetryContext,
    );
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
      await appendLog(
        startLogFile,
        "credential resolved",
        {
          providerId: credential.providerId,
          authMethod: credential.authMethod,
          hasBaseUrl: !!credential.baseUrl,
        },
        telemetryContext,
      );
      const resolvedCredential = await this.refreshOAuthCredential(
        input.apiConnection,
        credential,
        {
          force: forceOAuthRefresh(credential.providerId),
        },
      );
      this.agentTelemetry.setAuthentication(
        sessionId,
        resolvedCredential.authMethod,
      );
      await appendLog(
        startLogFile,
        "credential refreshed",
        {
          providerId: resolvedCredential.providerId,
          authMethod: resolvedCredential.authMethod,
          hasBaseUrl: !!resolvedCredential.baseUrl,
          expires: resolvedCredential.oauthCredentials?.expires,
        },
        telemetryContext,
      );
      await this.syncClineOAuthProviderSettings(resolvedCredential);
      if (resolvedCredential.authMethod === "oauth") {
        await appendLog(
          startLogFile,
          "cline oauth settings synced",
          {
            providerId: resolvedCredential.providerId,
            accountId: resolvedCredential.oauthCredentials?.accountId,
            email: resolvedCredential.oauthCredentials?.email,
            expires: resolvedCredential.oauthCredentials?.expires,
          },
          telemetryContext,
        );
      }
      const cline = await this.core(input.backend);
      await appendLog(
        startLogFile,
        "cline core ready",
        undefined,
        telemetryContext,
      );
      const sessionLogFile = sessionLogPath(input.cwd, sessionId);
      await this.subscribeSession(sessionId, input.backend);
      this.sessionExecutionIds.set(sessionId, executionId);
      this.runLifecycles.begin(sessionId, executionId);
      this.sessionBackendKeys.set(sessionId, backendKey(input.backend));
      this.sessionLogFiles.set(sessionId, sessionLogFile);
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
        ...(standardTools ?? []),
        ...(specialistTool ? [specialistTool] : []),
      ];
      const systemPrompt =
        (input.systemPrompt ?? loadPrompt("default-agent-system")) +
        (input.nativeCompletion && !input.clineDefaultTools
          ? skillScopeSystemPrompt(userInstructionService)
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
        ...(!input.clineDefaultTools
          ? {
              capabilities: {
                toolExecutors: { webFetch: createTextWebFetchExecutor() },
              },
            }
          : {}),
        ...(autoSendPrompt
          ? {
              prompt: appendInitialTaskBriefing(input.prompt, taskBriefing),
            }
          : {}),
        ...(input.initialMessages?.length
          ? { initialMessages: input.initialMessages }
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
            systemPrompt,
            cwd: input.cwd,
            workspaceRoot: input.workspaceRoot,
            checkpoint: {
              enabled:
                input.checkpointEnabled ??
                blameCheckpointConfig(this.productionConfig).enabled,
            },
            mode: input.mode ?? "act",
            maxIterations: input.maxIterations ?? defaultSessionMaxIterations,
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
          ...(!input.clineDefaultTools
            ? { hooks: { beforeModel: describeTextWebFetch } }
            : {}),
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
              ...(previewOptions.repairPreviewInitialization
                ? ["repair_preview_initialization"]
                : []),
            ]),
      } as const;
      this.sessionStartInputs.set(sessionId, startInput);
      if (input.clineDefaultTools) this.clineDefaultSessions.add(sessionId);
      await this.captureSessionQualityBaseline(sessionId);
      if (input.autoApproveWriteTools) {
        this.emitSessionNotice(
          sessionId,
          "Development session write tools auto-approved.",
        );
      }
      if (autoSendPrompt) {
        this.armSessionInactivityWatchdog(sessionId, executionId, cline);
        this.agentTelemetry.startModelRequest(sessionId);
        void this.agentTelemetry
          .withinSession<RuntimeClineResult>(
            sessionId,
            () => cline.start(startInput) as Promise<RuntimeClineResult>,
          )
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
      const session =
        await this.agentTelemetry.withinSession<RuntimeClineResult>(
          sessionId,
          () => cline.start(startInput) as Promise<RuntimeClineResult>,
        );
      this.sessionBackendKeys.set(session.sessionId, backendKey(input.backend));
      await appendLog(
        startLogFile,
        "session created",
        {
          durationMs: Date.now() - startedAt,
          sessionId: session.sessionId,
          logFile: sessionLogFile,
        },
        this.agentTelemetry.context(session.sessionId),
      );
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
      this.agentTelemetry.ready(session.sessionId, true);
      return session;
    } catch (error) {
      const activeContext = this.agentTelemetry.context(sessionId);
      await appendLog(
        startLogFile,
        "start failed",
        {
          durationMs: Date.now() - startedAt,
          errorType: errorType(error),
          message: errorMessage(error),
          status: "failed",
        },
        activeContext,
      );
      this.agentTelemetry.fail(sessionId, error);
      this.userInstructionServices.stop(sessionId);
      if (this.sessionExecutionIds.get(sessionId) === executionId)
        await this.unsubscribeSession(sessionId, true);
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
    const activeContext = this.agentTelemetry.context(sessionId);
    await appendLog(
      startLogFile,
      "session created",
      {
        durationMs: Date.now() - startedAt,
        sessionId,
        logFile: sessionLogFile,
      },
      activeContext,
    );
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
    const activeContext = this.agentTelemetry.context(sessionId);
    const message = errorMessage(error);
    await appendLog(
      startLogFile,
      "start failed",
      {
        durationMs: Date.now() - startedAt,
        errorType: errorType(error),
        message,
        status: "failed",
      },
      activeContext,
    );
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
    this.agentTelemetry.fail(sessionId, error);
    this.userInstructionServices.stop(sessionId);
  }

  private async sendSession(
    input: SendSessionInput,
    interventionType?: string,
  ) {
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
    this.agentTelemetry.beginTurn(
      input.sessionId,
      input.executionId,
      input.storyId,
      sessionTaskComplexity(input),
    );
    if (interventionType) {
      this.agentTelemetry.humanIntervention(input.sessionId, interventionType);
    }
    try {
      await this.captureSessionQualityBaseline(input.sessionId);
      const cline = await this.sessionCore(input.sessionId);
      return await this.sendPrompt(
        cline,
        input.sessionId,
        input.prompt,
        {
          userFiles: input.userFiles,
          userImages: input.userImages,
        },
        executionId,
      );
    } catch (error) {
      this.agentTelemetry.fail(input.sessionId, error);
      throw error;
    }
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
    return this.sendSession(
      {
        sessionId: input.sessionId,
        executionId: input.executionId,
        storyId: input.storyId,
        ...developmentInput,
        prompt: appendInitialTaskBriefing(developmentInput.prompt, briefing),
      },
      input.feedbackOnly ? "feedback" : undefined,
    );
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
    if (humanInitiated)
      this.agentTelemetry.humanIntervention(sessionId, "abort");
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
        const summary =
          stringValue(asRecord(input.event?.payload).text) ?? "Task completed.";
        try {
          await finish(summary);
        } catch (error) {
          nativeFailure = errorMessage(error);
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
    const usage = await Promise.resolve()
      .then(() => input.cline.getAccumulatedUsage(input.sessionId))
      .then(normalizeAgentUsageSummary)
      .catch(() => undefined);
    if (usage) this.agentTelemetry.recordUsageSummary(input.sessionId, usage);
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
    if (terminalState === "cancelled")
      this.agentTelemetry.cancel(input.sessionId);
    else if (terminalState !== "succeeded")
      this.agentTelemetry.fail(
        input.sessionId,
        new Error(terminalProductMessage(terminalState)),
      );
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
    return this.agentTelemetry.runCheckpointRestore(input.sessionId, () =>
      this.restoreCheckpointWorkflow(input),
    );
  }

  private async restoreCheckpointWorkflow(
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
    this.agentTelemetry.restore(sourceSessionId, restoredSessionId);
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
    await this.captureSessionQualityBaseline(restoredSessionId);
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

  private async discoverSecurityAudit(input: DiscoverSecurityAuditInput) {
    return this.agentTelemetry.runBusinessOperation(
      input,
      "security_audit_discovery",
      async () => {
        assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
        return runSecurityDiscovery(
          await this.core(input.backend),
          input,
          await this.initializationCredential(input),
          this.securityAuditSessionControl(input.auditId),
        );
      },
    );
  }

  private async validateSecurityAudit(input: ValidateSecurityAuditInput) {
    return this.agentTelemetry.runBusinessOperation(
      input,
      "security_audit_validation",
      async () => {
        assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
        return runSecurityValidation(
          await this.core(input.backend),
          input,
          await this.initializationCredential(input),
          this.securityAuditSessionControl(input.auditId),
        );
      },
    );
  }

  private securityAuditSessionControl(auditId: string) {
    return {
      assertActive: () => {
        if (this.cancelledSecurityAudits.has(auditId)) {
          throw new Error("Security audit cancelled");
        }
      },
      started: (sessionId: string, cline: ClineCore) => {
        if (this.cancelledSecurityAudits.has(auditId)) {
          void Promise.allSettled([
            cline.stop(sessionId),
            cline.abort(sessionId, "Security audit cancelled"),
          ]);
          throw new Error("Security audit cancelled");
        }
        const sessions =
          this.activeSecurityAuditSessions.get(auditId) ??
          new Map<string, ClineCore>();
        sessions.set(sessionId, cline);
        this.activeSecurityAuditSessions.set(auditId, sessions);
      },
      finished: (sessionId: string) => {
        const sessions = this.activeSecurityAuditSessions.get(auditId);
        sessions?.delete(sessionId);
        if (!sessions?.size) this.activeSecurityAuditSessions.delete(auditId);
      },
    };
  }

  private async cancelSecurityAudit(auditId: string) {
    this.cancelledSecurityAudits.add(auditId);
    const sessions = this.activeSecurityAuditSessions.get(auditId);
    if (!sessions?.size) return false;
    await Promise.allSettled(
      [...sessions].map(([sessionId, cline]) =>
        Promise.allSettled([
          cline.stop(sessionId),
          cline.abort(sessionId, "Security audit cancelled by user"),
        ]),
      ),
    );
    return true;
  }

  private finishSecurityAudit(auditId: string) {
    this.cancelledSecurityAudits.delete(auditId);
    this.activeSecurityAuditSessions.delete(auditId);
    return true;
  }

  private async initializeProject(
    input: InitializeProjectInput,
  ): Promise<InitializeProjectResult> {
    return this.agentTelemetry.runBusinessOperation(
      input,
      "project_initialization",
      () => this.initializeProjectWorkflow(input),
    );
  }

  private async analyzeProjectCodePractices(
    input: AnalyzeProjectCodePracticesInput,
  ): Promise<AnalyzeProjectCodePracticesResult> {
    return this.agentTelemetry.runBusinessOperation(
      input,
      "project_code_practices",
      () => this.analyzeProjectCodePracticesWorkflow(input),
    );
  }

  private async analyzeProjectCodePracticesWorkflow(
    input: AnalyzeProjectCodePracticesInput,
  ): Promise<AnalyzeProjectCodePracticesResult> {
    assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
    const credential = await this.initializationCredential(input);
    const scan = await scanProjectCodePractices(input.workspaceRoot);
    const cline = await this.core(input.backend);
    return this.runCodePracticesAttempts(cline, input, scan, credential);
  }

  private async runCodePracticesAttempts(
    cline: ClineCore,
    input: AnalyzeProjectCodePracticesInput,
    scan: ProjectCodePracticesScan,
    credential: InitializationCredential,
  ): Promise<AnalyzeProjectCodePracticesResult> {
    let correction = input.validationFeedback;
    for (let attempt = 1; attempt <= maxInitializationAttempts; attempt += 1) {
      const result = await this.startCodePracticesAttempt(
        cline,
        input,
        scan,
        credential,
        correction,
      );
      const outcome = this.codePracticesAttemptOutcome(
        input,
        result,
        scan,
        attempt,
      );
      if (outcome.complete) return outcome.result;
      correction = outcome.correction;
    }
    throw new Error("Code practice analysis did not return a valid result");
  }

  private codePracticesAttemptOutcome(
    input: AnalyzeProjectCodePracticesInput,
    result: ProjectCodePracticesAttempt,
    scan: ProjectCodePracticesScan,
    attempt: number,
  ): CodePracticesAttemptOutcome {
    try {
      return {
        complete: true,
        result: parsedCodePracticesAttempt(result, scan),
      };
    } catch (error) {
      if (attempt === maxInitializationAttempts) throw error;
      const correction = this.projectInitializationRetry(
        input,
        "project_code_practices",
        result.input,
        error,
      );
      return { complete: false, correction };
    }
  }

  private async startCodePracticesAttempt(
    cline: ClineCore,
    input: AnalyzeProjectCodePracticesInput,
    scan: ProjectCodePracticesScan,
    credential: InitializationCredential,
    correction?: InitializationCorrection,
  ) {
    const submit = projectCodePracticesSubmitTool();
    const session = await this.startCodePracticesAgent(
      cline,
      input,
      scan,
      credential,
      submit.tool,
      correction,
    );
    if (!submit.input) {
      throw new Error("Code practice analysis agent did not return a result");
    }
    return { input: submit.input, sessionId: session.sessionId };
  }

  private startCodePracticesAgent(
    cline: ClineCore,
    input: AnalyzeProjectCodePracticesInput,
    scan: ProjectCodePracticesScan,
    credential: InitializationCredential,
    submitTool: AgentTool,
    correction?: InitializationCorrection,
  ) {
    return this.agentTelemetry.runOperation(
      input,
      "project_code_practices",
      () =>
        cline.start({
          prompt: codePracticesPrompt(scan, correction),
          config: codePracticesConfig(input, credential, submitTool),
          interactive: false,
          source: "blame-project-code-practices",
          toolPolicies: codePracticesToolPolicies(),
        }) as Promise<RuntimeClineResult>,
      credential.authMethod,
    );
  }

  private async initializeProjectWorkflow(
    input: InitializeProjectInput,
  ): Promise<InitializeProjectResult> {
    assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
    const resolvedCredential = await this.initializationCredential(input);
    const scan = await scanProjectForInitialization(input.workspaceRoot);
    const cline = await this.core(input.backend);
    let correction = input.validationFeedback;
    for (let attempt = 1; attempt <= maxInitializationAttempts; attempt += 1) {
      const result = await this.startProjectInitializationAttempt(
        cline,
        input,
        scan,
        resolvedCredential,
        correction,
      );
      try {
        return parseProjectInitializationAttempt(result, scan, input);
      } catch (error) {
        if (attempt === maxInitializationAttempts) throw error;
        correction = this.projectInitializationRetry(
          input,
          "project_initialization",
          result.result,
          error,
        );
      }
    }
    throw new Error(
      "Project initialization agent did not return a valid result",
    );
  }

  private async startProjectInitializationAttempt(
    cline: ClineCore,
    input: InitializeProjectInput,
    scan: ProjectInitializationScan,
    credential: InitializationCredential,
    correction?: InitializationCorrection,
  ) {
    const submitTool = projectInitializationSubmitTool();
    const session = await this.startProjectInitializationAgent(
      cline,
      input,
      scan,
      credential,
      submitTool.tool,
      correction,
    );
    return collectProjectInitializationAttempt(cline, session, submitTool);
  }

  private startProjectInitializationAgent(
    cline: ClineCore,
    input: InitializeProjectInput,
    scan: ProjectInitializationScan,
    credential: InitializationCredential,
    submitTool: AgentTool,
    correction: InitializationCorrection | undefined,
  ) {
    return this.agentTelemetry.runOperation(
      input,
      "project_initialization",
      () =>
        cline.start({
          prompt: initializationPrompt(scan, correction, input.preferences),
          config: initializationConfig(input, credential, submitTool),
          interactive: false,
          source: "blame-project-initialization",
          toolPolicies: initializationToolPolicies(),
        }) as Promise<RuntimeClineResult>,
      credential.authMethod,
    );
  }

  private async repairProjectInitialization(
    input: RepairProjectInitializationInput,
  ): Promise<RepairProjectInitializationResult> {
    return this.agentTelemetry.runBusinessOperation(
      input,
      "project_initialization_repair",
      () => this.repairProjectInitializationWorkflow(input),
    );
  }

  private async repairProjectInitializationWorkflow(
    input: RepairProjectInitializationInput,
  ): Promise<RepairProjectInitializationResult> {
    assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
    const credential = await this.runtimeCredential(input);
    const scan = await scanProjectForInitialization(input.workspaceRoot);
    const cline = await this.core(input.backend);
    let correction: InitializationCorrection | undefined;
    for (let attempt = 1; attempt <= maxInitializationAttempts; attempt += 1) {
      const result = await this.startProjectInitializationRepairAttempt(
        cline,
        input,
        scan,
        credential,
        correction,
      );
      try {
        return parseProjectInitializationRepairAttempt(result, scan, input);
      } catch (error) {
        if (attempt === maxInitializationAttempts) throw error;
        correction = this.projectInitializationRetry(
          input,
          "project_initialization_repair",
          result.result,
          error,
        );
      }
    }
    throw new Error(
      "Project initialization repair agent did not return a valid result",
    );
  }

  private async startProjectInitializationRepairAttempt(
    cline: ClineCore,
    input: RepairProjectInitializationInput,
    scan: ProjectInitializationScan,
    credential: InitializationCredential,
    correction?: InitializationCorrection,
  ): Promise<ProjectInitializationRepairAttempt> {
    const submitTool = projectInitializationRepairSubmitTool();
    const session = await this.agentTelemetry.runOperation(
      input,
      "project_initialization_repair",
      () =>
        cline.start({
          prompt: projectInitializationRepairPrompt(input, scan, correction),
          config: initializationRepairConfig(
            input,
            credential,
            submitTool.tool,
          ),
          interactive: false,
          source: "blame-project-initialization-repair",
          toolPolicies: initializationToolPolicies(),
        }) as Promise<RuntimeClineResult>,
      credential.authMethod,
    );
    return collectProjectInitializationRepairAttempt(session, submitTool);
  }

  private projectInitializationRetry(
    input: InitializeProjectInput | RepairProjectInitializationInput,
    operationName: string,
    previousResult: unknown,
    error: unknown,
  ) {
    this.agentTelemetry.recordOperationRetry(input, operationName, error);
    return initializationCorrection(previousResult, error);
  }

  private async assessProjectInitializationImpact(
    input: AssessProjectInitializationImpactInput,
  ): Promise<AssessProjectInitializationImpactResult> {
    return this.agentTelemetry.runBusinessOperation(
      input,
      "project_initialization_impact",
      () => this.assessProjectInitializationImpactWorkflow(input),
    );
  }

  private async assessProjectInitializationImpactWorkflow(
    input: AssessProjectInitializationImpactInput,
  ): Promise<AssessProjectInitializationImpactResult> {
    assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
    const diagnostics =
      await collectProjectInitializationImpactDiagnostics(input);
    const deterministic = deterministicInitializationImpact(diagnostics);
    if (deterministic) return { ...deterministic, diagnostics };
    const credential = await this.runtimeCredential(input);
    const cline = await this.core(input.backend);
    const session = await this.startProjectInitializationImpactAgent(
      input,
      diagnostics,
      credential,
      cline,
    );
    const text = session.result?.text;
    if (!text)
      throw new Error(
        "Project initialization impact agent did not return a result",
      );
    return {
      sessionId: session.sessionId,
      ...parseProjectInitializationImpactResult(text),
      diagnostics,
    };
  }

  private startProjectInitializationImpactAgent(
    input: AssessProjectInitializationImpactInput,
    diagnostics: Awaited<
      ReturnType<typeof collectProjectInitializationImpactDiagnostics>
    >,
    credential: InitializationCredential,
    cline: ClineCore,
  ) {
    return this.agentTelemetry.runOperation(
      input,
      "project_initialization_impact",
      () =>
        cline.start({
          prompt: projectInitializationImpactPrompt(diagnostics),
          config: initializationImpactConfig(input, credential),
          interactive: false,
          source: "blame-project-initialization-impact",
          toolPolicies: initializationToolPolicies(),
        }) as Promise<RuntimeClineResult>,
      credential.authMethod,
    );
  }

  private async generateNewProject(
    input: StartNewProjectGenerationInput,
  ): Promise<NewProjectGenerationResult> {
    assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
    const credential = await this.runtimeCredential(input);
    const cline = await this.core(input.backend);
    const sessionId = input.sessionId ?? createBlameSessionId();
    this.agentTelemetry.start(sessionId, input);
    this.agentTelemetry.setAuthentication(sessionId, credential.authMethod);
    const sessionLogFile = sessionLogPath(input.cwd, sessionId);
    await this.subscribeSession(sessionId, input.backend);
    this.sessionBackendKeys.set(sessionId, backendKey(input.backend));
    this.sessionLogFiles.set(sessionId, sessionLogFile);
    this.sessionContexts.set(sessionId, {
      maxIterations: newProjectGenerationMaxIterations(),
      mode: "yolo",
      modelId: input.modelId,
      providerId: input.providerId,
      sessionId,
    });
    this.autoApprovedWriteToolSessions.add(sessionId);
    this.emitSessionNotice(sessionId, "New project generation agent started.");
    this.emitSessionNotice(sessionId, `Cline debug log: ${sessionLogFile}`);

    try {
      const config = await newProjectGenerationConfig(
        input,
        credential,
        sessionId,
        this.productionConfig,
      );
      this.agentTelemetry.startModelRequest(sessionId);
      const session =
        await this.agentTelemetry.withinSession<RuntimeClineResult>(
          sessionId,
          () =>
            cline.start({
              prompt: newProjectGenerationPrompt(input),
              config,
              interactive: false,
              localRuntime: { configExtensions: ["rules"] },
              source: "blame-new-project-generation",
              toolPolicies: newProjectGenerationToolPolicies(),
            }) as Promise<RuntimeClineResult>,
        );
      const failure = resultFailureMessage(session.result);
      const readinessError = await generatedProjectReadinessError(input.cwd);
      if (readinessError) throw new Error(failure ?? readinessError);
      if (failure) {
        this.emitSessionNotice(
          sessionId,
          `New project generation agent ended after scaffold: ${failure}`,
        );
      }
      this.emitSessionNotice(
        sessionId,
        "New project generation agent finished.",
      );
      return {
        path: input.cwd,
        sessionId,
      };
    } finally {
      await this.unsubscribeSession(sessionId);
    }
  }

  private async optimizeUserStoryPrompt(
    input: OptimizeUserStoryPromptInput,
  ): Promise<OptimizeUserStoryPromptResult> {
    assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
    const prompt = input.prompt.trim();
    if (!prompt)
      throw new Error("Prompt optimizer requires a user story prompt.");
    const credential = await this.runtimeCredential(input);
    const cline = await this.core(input.backend);
    return this.agentTelemetry.runOperation(
      input,
      "prompt_optimization",
      () => optimizeUserStoryPrompt({ ...input, prompt }, cline, credential),
      credential.authMethod,
    );
  }

  private async generateTitle(
    input: GenerateTitleInput,
  ): Promise<GenerateTitleResult> {
    assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Title generator requires a prompt.");
    const credential = await this.runtimeCredential(input);
    const cline = await this.core(input.backend);
    return this.agentTelemetry.runOperation(
      input,
      "title_generation",
      () => generateTitle({ ...input, prompt }, cline, credential),
      credential.authMethod,
    );
  }

  private async initializationCredential(input: RuntimeCredentialInput) {
    const credential = await this.runtimeCredential(input);
    await this.syncClineOAuthProviderSettings(credential);
    return credential;
  }

  private async runtimeCredential(input: RuntimeCredentialInput) {
    const credential = await resolveProviderCredential(input.apiConnection, {
      providerId: input.providerId,
      label: credentialLabel(input),
    });
    return this.refreshOAuthCredential(input.apiConnection, credential);
  }

  private async approveAndMergeStory(
    input: ApproveAndMergeInput,
  ): Promise<ApproveAndMergeResult> {
    return this.agentTelemetry.runBusinessOperation(input, "merge", () =>
      this.approveAndMergeStoryOperation(input),
    );
  }

  private async approveAndMergeStoryOperation(
    input: ApproveAndMergeInput,
  ): Promise<ApproveAndMergeResult> {
    assertRepositoryPath(input.repositoryRoot, "repositoryRoot");
    assertRepositoryPath(input.worktree, "worktree");
    const logFile = approveMergeLogPath(input.worktree);
    await appendLog(
      logFile,
      "approve merge requested",
      approveMergeContext(input),
    );
    const preparation = await this.prepareStoryMerge(input);
    try {
      // A previous approval may have stopped with an unresolved merge. Resolve
      // its index before the ordinary commit path can stage conflict markers.
      await this.completePendingStoryMerge(input, preparation.targetBranch);
      await this.commitStoryWork(input);
      await this.mergeTargetIntoStory(
        input,
        preparation.targetBranch,
        preparation.baseCommit,
      );
      await removeRuntimeEnvChanges(input.worktree, preparation.baseCommit);
      return await this.finalizeStoryMerge(input, logFile, preparation);
    } finally {
      if (!preparation.targetClean) {
        await removeIntegrationWorktree(
          input.repositoryRoot,
          preparation.integration,
        );
      }
    }
  }

  private async prepareStoryMerge(
    input: ApproveAndMergeInput,
  ): Promise<StoryMergePreparation> {
    await assertGitRepository(input.repositoryRoot);
    await assertGitRepository(input.worktree);
    const targetBranch = await currentGitBranch(input.repositoryRoot);
    await validateMergeBranches(input, targetBranch);
    const upstream = await optionalGitUpstream(input.repositoryRoot);
    const targetClean = await cleanGitStatus(input.repositoryRoot);
    const integration = targetClean
      ? input.repositoryRoot
      : await integrationWorktree(input.repositoryRoot, targetBranch);
    try {
      await pullIntegrationWorktree(integration, upstream);
      const baseCommit = await git(integration, ["rev-parse", "HEAD"]);
      return { baseCommit, integration, targetBranch, targetClean, upstream };
    } catch (error) {
      if (!targetClean) {
        await removeIntegrationWorktree(input.repositoryRoot, integration);
      }
      throw error;
    }
  }

  private async finalizeStoryMerge(
    input: ApproveAndMergeInput,
    logFile: string,
    preparation: StoryMergePreparation,
  ) {
    const { baseCommit, integration, targetBranch, targetClean, upstream } =
      preparation;
    let targetChanges: TargetChangesStash | undefined;
    try {
      if (!targetClean) {
        targetChanges = await stashTargetChanges(input.repositoryRoot, git);
        if (targetChanges) {
          await appendLog(logFile, "local target changes stashed", {
            commit: targetChanges.commit,
          });
        }
      }
      await git(integration, ["merge", "--ff-only", input.storyBranch]);
      const mergeCommit = await git(integration, ["rev-parse", "HEAD"]);
      if (!targetClean) {
        await assertTargetChangesRestorable(integration, targetChanges, git);
        await advanceTargetBranch(
          input.repositoryRoot,
          targetBranch,
          input.storyBranch,
        );
        const changesToRestore = targetChanges;
        targetChanges = undefined;
        await restoreTargetChanges(
          input.repositoryRoot,
          changesToRestore,
          logFile,
        );
      }
      await pushIntegrationWorktree(integration, upstream, logFile);
      await appendLog(logFile, "approve merge completed", {
        baseCommit,
        mergeCommit,
        targetBranch,
      });
      return { baseCommit, mergeCommit, targetBranch };
    } finally {
      if (targetChanges) {
        await restoreTargetChanges(
          input.repositoryRoot,
          targetChanges,
          logFile,
        );
      }
    }
  }

  private async commitStoryWork(input: ApproveAndMergeInput) {
    if (await hasMergeConflicts(input.worktree)) {
      throw new Error(
        "Resolve the active Git conflicts before committing the story.",
      );
    }
    const status = await storyStatus(input.worktree, "--porcelain");
    if (!status.trim()) return;
    const message = await this.generateCommitMessageWithAgent(
      input,
      approveMergeLogPath(input.worktree),
      "blame-approve-merge",
    );
    await addStoryChanges(input.worktree);
    await git(input.worktree, ["commit", "-m", message]);
    const nextStatus = await storyStatus(input.worktree, "--porcelain");
    if (nextStatus.trim())
      throw new Error(
        "Story worktree still has uncommitted changes after commit.",
      );
  }

  private async generateWorkspaceCommitMessage(
    input: GenerateCommitMessageInput,
  ): Promise<GenerateCommitMessageResult> {
    assertRepositoryPath(input.repositoryRoot, "repositoryRoot");
    assertRepositoryPath(input.worktree, "worktree");
    await assertGitRepository(input.repositoryRoot);
    await assertGitRepository(input.worktree);
    const status = await storyStatus(
      input.worktree,
      "--porcelain",
      commitMessagePaths(input),
    );
    if (!status.trim())
      throw new Error(
        "No selected changes available for commit message generation.",
      );
    const logFile = commitMessageLogPath(input.worktree);
    await appendLog(logFile, "commit message generation requested", {
      providerId: input.providerId,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      repositoryRoot: input.repositoryRoot,
      selectedPaths: input.selectedPaths ?? [],
      worktree: input.worktree,
    });
    const message = await this.generateCommitMessageWithAgent(
      input,
      logFile,
      "blame-commit-message-generation",
    );
    return { message };
  }

  private async generateCommitMessageWithAgent(
    input: CommitMessageRuntimeInput,
    logFile: string,
    source: string,
  ) {
    try {
      const startedAt = Date.now();
      const credential = await this.runtimeCredential(input);
      const cline = await this.core(input.backend);
      const session = await this.agentTelemetry.runOperation(
        input,
        "commit_message_generation",
        async () =>
          cline.start({
            prompt: await commitMessagePrompt(input),
            config: commitMessageConfig(input, credential),
            interactive: false,
            source,
            toolPolicies: initializationToolPolicies(),
          }),
        credential.authMethod,
      );
      const message = commitMessageFromAgentResult(session.result);
      await appendLog(logFile, "commit message agent finished", {
        durationMs: Date.now() - startedAt,
        sessionId: session.sessionId,
        status: resultStatus(asRecord(session.result)),
        success: Boolean(message),
      });
      if (message) return message;
    } catch (error) {
      await appendLog(logFile, "commit message agent failed", {
        errorType: errorType(error),
        status: "failed",
      });
    }
    await appendLog(logFile, "commit message fallback selected", {
      status: "fallback",
      success: true,
    });
    return fallbackCommitMessage(input);
  }

  private async mergeTargetIntoStory(
    input: ApproveAndMergeInput,
    targetBranch: string,
    targetCommit: string,
  ) {
    // Preparation fetched through the project checkout, which owns remote
    // credentials. Reuse its exact target, including unpublished local commits;
    // the story worktree may run in a VM without those credentials.
    try {
      await git(input.worktree, ["merge", targetCommit]);
      return;
    } catch (error) {
      if (!(await hasMergeConflicts(input.worktree))) throw error;
    }
    try {
      await this.completePendingStoryMerge(input, targetBranch);
    } catch (error) {
      // Story work was committed before this merge. Restore that usable revision
      // if the resolver fails, rather than leave the preview on conflict markers.
      try {
        await git(input.worktree, ["merge", "--abort"]);
      } catch (abortError) {
        throw new Error(
          `Merge resolution failed and Git could not abort the merge: ${errorMessage(abortError)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async completePendingStoryMerge(
    input: ApproveAndMergeInput,
    targetBranch: string,
  ) {
    if (!(await hasPendingMerge(input.worktree))) return;
    await this.resolveMergeConflictsWithAgent(
      input,
      targetBranch,
      approveMergeLogPath(input.worktree),
    );
    const conflicts = await mergeConflictFiles(input.worktree);
    if (conflicts.length)
      throw new Error(unresolvedMergeConflictMessage(conflicts));
    await addStoryChanges(input.worktree);
    await git(input.worktree, ["commit", "--no-edit"]);
  }

  private async resolveWorkspaceMergeConflicts(
    input: ResolveMergeConflictsInput,
  ): Promise<ResolveMergeConflictsResult> {
    assertRepositoryPath(input.repositoryRoot, "repositoryRoot");
    assertRepositoryPath(input.worktree, "worktree");
    const logFile = mergeConflictLogPath(input.worktree);
    await appendLog(logFile, "merge conflict resolution requested", {
      providerId: input.providerId,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      repositoryRoot: input.repositoryRoot,
      worktree: input.worktree,
    });
    await assertGitRepository(input.repositoryRoot);
    await assertGitRepository(input.worktree);
    const targetBranch =
      input.targetBranch || (await currentGitBranch(input.worktree)) || "HEAD";
    await this.resolveMergeConflictsWithAgent(
      input,
      targetBranch,
      logFile,
      false,
    );
    const conflicts = await mergeConflictFiles(input.worktree);
    return { conflicts, resolved: conflicts.length === 0 };
  }

  private async resolveMergeConflictsWithAgent(
    input: MergeConflictRuntimeInput,
    targetBranch: string,
    logFile: string,
    throwOnUnresolved = true,
  ) {
    let conflicts = await mergeConflictFiles(input.worktree);
    for (
      let attempt = 1;
      attempt <= maxMergeConflictResolutionAttempts && conflicts.length;
      attempt += 1
    ) {
      const failure = await this.runMergeConflictAgent(
        input,
        targetBranch,
        attempt,
        logFile,
      );
      conflicts = await mergeConflictFiles(input.worktree);
      await appendLog(logFile, "merge conflict agent finished", {
        status: conflicts.length ? "conflicts_remaining" : "resolved",
        success: !conflicts.length,
      });
      if (failure && conflicts.length) throw new Error(failure);
    }
    if (conflicts.length && throwOnUnresolved)
      throw new Error(unresolvedMergeConflictMessage(conflicts));
  }

  private async runMergeConflictAgent(
    input: MergeConflictRuntimeInput,
    targetBranch: string,
    attempt: number,
    logFile: string,
  ) {
    const startedAt = Date.now();
    const credential = await this.runtimeCredential(input);
    const cline = await this.core(input.backend);
    const session = await this.agentTelemetry.runOperation(
      input,
      "merge_conflict_resolution",
      async () =>
        cline.start({
          prompt: await mergeConflictPrompt(input, targetBranch, attempt),
          config: mergeConflictConfig(input, credential),
          interactive: false,
          source: "blame-merge-conflict-resolution",
          toolPolicies: mergeConflictToolPolicies(),
        }),
      credential.authMethod,
    );
    await appendLog(logFile, "merge conflict agent run completed", {
      durationMs: Date.now() - startedAt,
      sessionId: session.sessionId,
      status: resultStatus(asRecord(session.result)),
    });
    return resultFailureMessage(session.result);
  }

  private async subscribeSession(
    sessionId: string,
    backend?: AgentBackendConfig,
  ) {
    const cline = await this.core(backend);
    await this.subscribeCoreSession(sessionId, cline);
  }

  private async subscribeCoreSession(sessionId: string, cline: ClineCore) {
    await this.unsubscribeSession(sessionId, true);
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
        if (
          lifecycleBeforeEvent?.execution_id === executionId &&
          lifecycleBeforeEvent.state !== "running"
        )
          this.agentTelemetry.recordPostStopEvent(sessionId, eventTokens);
        if (!this.runLifecycles.accepts(sessionId, executionId, eventTokens)) {
          if (terminalBeforeEvent)
            this.agentTelemetry.recordPostTerminalEvent(sessionId, eventTokens);
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
        this.agentTelemetry.observeCoreEvent(sessionId, payload);
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
      // when the observed iteration count leaves an explicit remaining budget.
      const consumed = this.sessionIterations.get(sessionId);
      const maximum = start?.config.maxIterations;
      if (start?.interactive !== false || this.clineDefaultSessions.has(sessionId) ||
        !start.config.extraTools?.some((tool: AgentTool) => tool.name === "finish_task") ||
        consumed === undefined || consumed < 1 || maximum === undefined ||
        consumed >= maximum) return false;
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
        config: { ...start.config, maxIterations: start.config.maxIterations! - consumed } };
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
      this.agentTelemetry.startModelRequest(sessionId);
      this.armSessionInactivityWatchdog(sessionId, executionId, cline);
      const session = await this.agentTelemetry.withinSession(sessionId,
        () => cline.start(restart!) as Promise<RuntimeClineResult>);
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
    if (streamingAgentEvent(event)) {
      this.agentTelemetry.observeEvent(sessionId, event);
      return;
    }
    const activeContext = this.agentTelemetry.context(sessionId);
    const eventUsage = eventUsageSummary(event);
    const usage = await this.usageForEvent(sessionId, event, eventUsage);
    if (event.type === "done" && usage)
      this.agentTelemetry.recordUsageSummary(sessionId, usage);
    const qualityContext =
      event.type === "done"
        ? this.agentTelemetry.completeModelRequest(sessionId, event.payload)
        : undefined;
    if (event.type === "done") {
      await this.recordSessionQuality(sessionId, qualityContext);
    }
    this.agentTelemetry.observeEvent(sessionId, event);
    await this.logSession(
      sessionId,
      `event:${event.type}`,
      eventLogPayload(event),
      activeContext,
    );
    if (!usage) return;
    await this.handleUsageUpdate(sessionId, usage, activeContext);
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
    const span = blameTelemetry.startSpan("blame.agent.usage_summary", {
      parent: this.agentTelemetry.context(sessionId),
    });
    try {
      const usage = await blameTelemetry.withinSpan(span, () =>
        this.readUsage(sessionId),
      );
      span.end();
      return usage;
    } catch (error) {
      span.recordError(error).end("failed");
      return undefined;
    }
  }

  private async handleUsageUpdate(
    sessionId: string,
    usage: AgentUsageSummary,
    activeContext: Context | undefined,
  ) {
    const usageSignature = JSON.stringify(summarizeUsage(usage));
    if (this.sessionUsageSignatures.get(sessionId) === usageSignature) return;
    this.sessionUsageSignatures.set(sessionId, usageSignature);
    const context = this.sessionContexts.get(sessionId) ?? { sessionId };
    await this.logSession(
      sessionId,
      "usage updated",
      {
        ...context,
        ...summarizeUsage(usage),
      },
      activeContext,
    );
    if (!shouldAbortForUsage(usage, this.productionConfig)) return;
    const executionId = this.sessionExecutionIds.get(sessionId);
    if (executionId && !this.runLifecycles.canInvoke(sessionId, executionId))
      return;
    const message = usageLimitMessage(usage, this.productionConfig);
    this.emitSessionError(sessionId, message);
    await this.abortSession(sessionId, false);
  }

  private unsubscribeSession(sessionId: string, preserveTelemetry = false) {
    const current = this.sessionReleases.get(sessionId);
    if (current) return current;
    const release = this.releaseSession(sessionId, preserveTelemetry);
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

  private async releaseSession(sessionId: string, preserveTelemetry: boolean) {
    const unsubscribe = this.unsubscribers.get(sessionId);
    this.unsubscribers.delete(sessionId);
    try {
      unsubscribe?.();
    } catch {
      // Session cleanup must continue even when a provider unsubscribe fails.
    }
    this.clearSessionState(sessionId, preserveTelemetry);
    await this.sessionMemoryWrites.get(sessionId)?.catch(() => undefined);
    this.sessionMemoryWrites.delete(sessionId);
    const logFile = this.sessionLogFiles.get(sessionId);
    this.sessionLogFiles.delete(sessionId);
    await this.sessionLogWrites.get(sessionId)?.catch(() => undefined);
    if (logFile)
      await appendLog(logFile, "session unsubscribed").catch(() => undefined);
    this.sessionLogWrites.delete(sessionId);
  }

  private clearSessionState(sessionId: string, preserveTelemetry: boolean) {
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
    this.sessionQualityBaselines.delete(sessionId);
    this.sessionStartInputs.delete(sessionId);
    this.userInstructionServices.stop(sessionId);
    this.structuredEventSessions.delete(sessionId);
    if (!preserveTelemetry) this.agentTelemetry.remove(sessionId);
  }

  private async recordSessionQuality(
    sessionId: string,
    parent: Context | undefined,
  ) {
    const cwd = this.sessionStartInputs.get(sessionId)?.config.cwd;
    const baseline = this.sessionQualityBaselines.get(sessionId);
    if (!cwd || baseline === undefined) return;
    const span = blameTelemetry.startSpan("blame.agent.quality", { parent });
    try {
      const status = await blameTelemetry.withinSpan(span, () =>
        workspaceStatus(cwd),
      );
      this.agentTelemetry.recordQuality(
        sessionId,
        qualityFromStatusDelta(baseline, status),
      );
      this.sessionQualityBaselines.set(sessionId, status);
      span.end();
    } catch (error) {
      span.recordError(error).end("failed");
    }
  }

  private async captureSessionQualityBaseline(sessionId: string) {
    const cwd = this.sessionStartInputs.get(sessionId)?.config.cwd;
    if (!cwd) return;
    try {
      this.sessionQualityBaselines.set(sessionId, await workspaceStatus(cwd));
    } catch {
      this.sessionQualityBaselines.delete(sessionId);
    }
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
      approval.resolve({ approved: false }),
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
      return { approved: false };
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
      if (approval.sessionId) {
        this.agentTelemetry.humanIntervention(
          approval.sessionId,
          "tool_approval",
        );
      }
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
    pending.resolve({ approved: input.decision !== "deny" });
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
    const refreshed = await provider.refreshToken(credential.oauthCredentials);
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
    activeContext: Context | undefined = this.agentTelemetry.context(sessionId),
  ) {
    const file = this.sessionLogFiles.get(sessionId);
    if (!file) return;
    const precedingWrite = this.sessionLogWrites.get(sessionId);
    const write = (precedingWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => appendLog(file, message, payload, activeContext));
    this.sessionLogWrites.set(sessionId, write);
    await write;
  }

  private async disposeCore() {
    const clines = Array.from(this.clines.values());
    this.clines.clear();
    this.sessionBackendKeys.clear();
    this.sessionQualityBaselines.clear();
    this.sessionStartInputs.clear();
    this.sessionInactivityTimeouts.clear();
    await Promise.allSettled(
      clines.map(async (cline) => (await cline).dispose("Shutting down")),
    );
  }

  private async startDevelopmentSession(input: StartDevelopmentSessionInput) {
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
    const developmentInput = await developmentUserInput(
      input,
      newAttachmentDirectory(input.cwd),
      this.developmentAttachmentStorage(input),
    );
    const iterationBudget =
      input.maxIterations ?? developmentSessionMaxIterations;
    const compaction = blameCompactionConfig(this.productionConfig);
    const enableSpecialistConsult = developmentSpecialistConsultEnabled(input);
    const session = await this.startSession({
      apiConnection: input.apiConnection,
      providerId: input.providerId,
      modelId: input.modelId,
      credentialLabel: input.credentialLabel,
      reasoningEffort: input.reasoningEffort,
      checkpointEnabled: input.checkpointEnabled,
      configExtensions: input.configExtensions,
      disableMcpSettingsTools: input.disableMcpSettingsTools,
      autoApproveWriteTools: true,
      autoSendPrompt: input.autoSendPrompt !== false,
      sessionId: conversationId,
      initialMessages,
      mode: "act",
      maxIterations: iterationBudget,
      prompt: developmentInput.prompt,
      taskObjective: developmentInput.prompt,
      requiredChecks: input.requiredChecks,
      userFiles: developmentInput.userFiles,
      userImages: developmentInput.userImages,
      pluginPaths: input.pluginPaths,
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      workspaceMode: input.workspaceMode,
      previewDevtoolsScope: input.previewDevtoolsScope,
      isolatedEnvironment: input.isolatedEnvironment,
      systemPrompt: await buildDevelopmentSystemPrompt(input),
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
      !this.options.applyPreviewInitialization
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
    const repair = await this.repairProjectInitialization(
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
      repairSessionId: repair.sessionId,
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
  ): Promise<RepairProjectInitializationInput> {
    return {
      apiConnection: input.apiConnection,
      providerId: input.providerId,
      modelId: input.modelId,
      credentialLabel: input.credentialLabel,
      reasoningEffort: input.reasoningEffort,
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      previewManifest: state.initialization.previewManifest,
      runConfigurations: state.initialization.runConfigurations,
      preferences: {
        database: { mode: state.initialization.databaseMode ?? "compose" },
      },
      diagnostics: await this.previewInitializationDiagnostics(preview),
      backend: input.backend,
      executionId: input.executionId,
      storyId: input.storyId,
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
    const logFile = this.sessionLogFiles.get(sessionId);
    if (!logFile) return newAttachmentDirectory(process.cwd());
    return join(
      dirname(dirname(logFile)),
      "attachments",
      sessionId,
      randomUUID(),
    );
  }

  private developmentAttachmentStorage(input: StartDevelopmentSessionInput) {
    const executor = managedLightWorkspaceExecutor(
      this.options.lightWorkspace,
      {
        backendMode: input.backend?.mode,
        workspaceMode: input.workspaceMode,
      },
    );
    return executor ? { executor, workspaceRoot: input.cwd } : undefined;
  }

  private sessionAttachmentStorage(sessionId: string) {
    const executor = this.sessionJournalExecutors.get(sessionId);
    const workspaceRoot = this.sessionStartInputs.get(sessionId)?.config.cwd;
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
    this.agentTelemetry.startModelRequest(sessionId);
    this.armSessionInactivityWatchdog(sessionId, activeExecutionId, cline);
    const activeContext = this.agentTelemetry.context(sessionId);
    const result: Promise<unknown> = this.agentTelemetry
      .withinSession(sessionId, () =>
        cline.send({
          sessionId,
          prompt,
          ...(attachments.userImages?.length
            ? { userImages: attachments.userImages }
            : {}),
          ...(attachments.userFiles?.length
            ? { userFiles: attachments.userFiles }
            : {}),
        }),
      )
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
          activeContext,
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
        void this.logSession(
          sessionId,
          "send failed",
          {
            durationMs: Date.now() - startedAt,
            errorType: errorType(error),
            message,
            status: "failed",
          },
          activeContext,
        );
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
    void this.logSession(
      sessionId,
      "prompt sent",
      {
        ...promptMetadata(prompt),
      },
      activeContext,
    );
    return result;
  }
}

export function createClineBaselineRuntime(events?: AgentRuntimeEvents) {
  return new BlameAgentRuntime(events, { developmentHarness: "cline" });
}

async function generatedProjectReadinessError(cwd: string) {
  const paths = [
    join(cwd, "package.json"),
    join(cwd, "apps", "web", "package.json"),
  ];
  for (const path of paths) {
    if (!(await fileExists(path))) continue;
    return projectManifestReadinessError(path);
  }
  return "Project generation agent completed without creating a package.json.";
}

async function projectManifestReadinessError(path: string) {
  try {
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const missing = ["dev", "build"].filter(
      (name) => typeof manifest.scripts?.[name] !== "string",
    );
    return missing.length
      ? `Generated package.json is missing required scripts: ${missing.join(", ")}.`
      : undefined;
  } catch {
    return "Project generation agent created an invalid package.json.";
  }
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createBlameSessionId() {
  return `${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 5)}`;
}

async function commitMessagePrompt(input: CommitMessageRuntimeInput) {
  const paths = commitMessagePaths(input);
  const [status, changedFiles, diffStat, log] = await Promise.all([
    storyStatus(input.worktree, "--porcelain", paths),
    storyChangedFiles(input.worktree, paths),
    storyDiffStat(input.worktree, paths),
    git(input.worktree, ["log", "-12", "--pretty=%s"]),
  ]);
  const title = input.title || "Git changes";
  const summary =
    input.summary ||
    "Generate a concise commit message for the selected changes.";
  return [
    `Backlog item: ${title}`,
    "",
    summary,
    "",
    `Git status:\n${truncateText(status, 8_000)}`,
    "",
    `Selected paths:\n${truncateText(paths.join("\n"), 8_000)}`,
    "",
    `Changed files:\n${truncateText(changedFiles, 12_000)}`,
    "",
    `Diff stat:\n${truncateText(diffStat, 12_000)}`,
    "",
    `Recent commits:\n${truncateText(log, 8_000)}`,
  ].join("\n");
}

async function storyChangedFiles(cwd: string, paths = ["."]) {
  return git(cwd, [
    "diff",
    "--no-ext-diff",
    "--name-status",
    "HEAD",
    "--",
    ...paths,
    ...runtimeArtifactPathspecs,
  ]);
}

async function storyDiffStat(cwd: string, paths = ["."]) {
  return git(cwd, [
    "diff",
    "--no-ext-diff",
    "--stat",
    "HEAD",
    "--",
    ...paths,
    ...runtimeArtifactPathspecs,
  ]);
}

async function fallbackCommitMessage(input: CommitMessageRuntimeInput) {
  const paths = commitMessagePaths(input);
  const [status, log] = await Promise.all([
    storyStatus(input.worktree, "--porcelain", paths),
    git(input.worktree, ["log", "-12", "--pretty=%s"]),
  ]);
  const files = statusFileNames(status);
  const standardConvention = commitMessageConventionEnabled(input);
  const subject = fallbackCommitSubject(
    input.title || "selected changes",
    files,
  );
  const bracketPrefix = dominantBracketPrefix(log);
  if (!standardConvention && bracketPrefix) {
    return limitCommitMessage(`${bracketPrefix} ${subject}`);
  }
  const scope = commitScope(files);
  const type = commitType(files);
  return limitCommitMessage(`${type}${scope ? `(${scope})` : ""}: ${subject}`);
}

function commitMessagePaths(input: CommitMessageRuntimeInput) {
  if (!("selectedPaths" in input)) return ["."];
  const paths = input.selectedPaths?.filter(Boolean) ?? [];
  return paths.length ? paths : ["."];
}

function commitMessageFromAgentResult(result: unknown) {
  const payload = asRecord(result);
  return (
    firstTextLine(payload.text) ??
    firstTextLine(payload.outputText) ??
    firstTextLine(payload.message)
  );
}

function commitMessageConventionEnabled(input: CommitMessageRuntimeInput) {
  return (
    input.codePractices?.find(
      (item) => item.practice === "commit_message_convention",
    )?.enabled ?? false
  );
}

function dominantBracketPrefix(log: string) {
  const prefixes = log
    .split("\n")
    .map((line) => line.match(/^(\[[^\]]+\])/)?.[1])
    .filter(isString);
  const counts = new Map<string, number>();
  prefixes.forEach((prefix) =>
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1),
  );
  return [...counts.entries()].find(([, count]) => count >= 2)?.[0];
}

function statusFileNames(status: string) {
  return status.split("\n").map(statusFileName).filter(isString);
}

function statusFileName(line: string) {
  const file = line.slice(3).trim();
  return file.includes(" -> ") ? file.split(" -> ").at(-1) : file;
}

function commitScope(files: string[]) {
  const firstFile = files.find(Boolean);
  if (!firstFile) return undefined;
  const parts = firstFile.split("/");
  if (parts[0] === "packages" && parts[1]) return parts[1];
  if (parts[0] === "src" && parts[1]) return parts[1];
  return parts[0]?.replace(/\.[^.]+$/g, "");
}

function commitType(files: string[]) {
  if (
    files.length &&
    files.every((file) => /\.(test|spec)\.[jt]sx?$/.test(file))
  )
    return "test";
  if (files.length && files.every((file) => /\.(md|mdx|txt)$/.test(file)))
    return "docs";
  if (files.some((file) => /(^|\/)(package\.json|pnpm-lock\.yaml)$/.test(file)))
    return "build";
  return "fix";
}

function limitCommitMessage(message: string) {
  return message.length <= 74
    ? message
    : message.slice(0, 74).replace(/\s+\S*$/, "");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

async function mergeConflictPrompt(
  input: MergeConflictRuntimeInput,
  targetBranch: string,
  attempt: number,
) {
  const [status, files] = await Promise.all([
    storyStatus(input.worktree, "--short"),
    git(input.worktree, ["diff", "--name-only", "--diff-filter=U"]),
  ]);
  const title = input.title || "Current Git merge conflict";
  const summary = input.summary || "Resolve the active merge conflicts.";
  const storyBranch =
    "storyBranch" in input && input.storyBranch
      ? input.storyBranch
      : await currentGitBranch(input.worktree);
  return [
    `Backlog item: ${title}`,
    "",
    summary,
    "",
    `Story branch: ${storyBranch || "HEAD"}`,
    `Target branch: ${targetBranch}`,
    `Resolution attempt: ${attempt} of ${maxMergeConflictResolutionAttempts}`,
    "",
    `Conflicted files:\n${files}`,
    "",
    `Git status:\n${truncateText(status, 8_000)}`,
  ].join("\n");
}

async function storyStatus(
  cwd: string,
  format: "--porcelain" | "--short",
  paths = ["."],
) {
  const envPathspecs = (await changedRuntimeEnvPaths(cwd)).map(
    (path) => `:!${path}`,
  );
  return git(cwd, [
    "status",
    format,
    "--",
    ...paths,
    ...runtimeArtifactPathspecs,
    ...envPathspecs,
  ]);
}

async function addStoryChanges(cwd: string) {
  const envPaths = await changedRuntimeEnvPaths(cwd);
  await git(cwd, ["add", "-A", "--", "."]);
  await git(cwd, [
    "reset",
    "--quiet",
    "--",
    ...runtimeArtifactPaths,
    ...envPaths,
  ]);
}

async function removeRuntimeEnvChanges(cwd: string, baseCommit: string) {
  const changedFiles = await git(cwd, [
    "diff",
    "--name-only",
    `${baseCommit}...HEAD`,
  ]);
  const envPaths = splitLines(changedFiles).filter(runtimeEnvPath);
  if (!envPaths.length) return;
  for (const path of envPaths) {
    if (await gitPathExists(cwd, baseCommit, path)) {
      await git(cwd, [
        "restore",
        "--source",
        baseCommit,
        "--staged",
        "--worktree",
        "--",
        path,
      ]);
    } else {
      await git(cwd, ["rm", "--cached", "--ignore-unmatch", "--", path]);
    }
  }
  await git(cwd, ["commit", "-m", "chore: exclude runtime environment files"]);
}

async function changedRuntimeEnvPaths(cwd: string) {
  const paths = await git(cwd, [
    "ls-files",
    "--modified",
    "--deleted",
    "--others",
    "--exclude-standard",
  ]);
  return splitLines(paths).filter(runtimeEnvPath);
}

async function gitPathExists(cwd: string, revision: string, path: string) {
  try {
    await git(cwd, ["cat-file", "-e", `${revision}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

function runtimeEnvPath(path: string) {
  const name = basename(path);
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return ![".example", ".sample", ".template"].some((suffix) =>
    name.endsWith(suffix),
  );
}

function splitLines(value: string) {
  return value.split("\n").filter(Boolean);
}

export function qualityFromStatus(status: string) {
  return qualityFromStatusDelta("", status);
}

export function qualityFromStatusDelta(baseline: string, status: string) {
  const baselinePaths = new Set(
    statusEntries(baseline).map(({ path }) => path),
  );
  const entries = statusEntries(status).filter(
    ({ path }) => !baselinePaths.has(path),
  );
  return {
    filesModified: new Set(entries.map((entry) => entry.path)).size,
    testsAdded: entries.filter(
      (entry) => entry.added && testFilePath(entry.path),
    ).length,
  };
}

function statusEntries(status: string) {
  return splitLines(status).map(statusEntry);
}

function statusEntry(line: string) {
  const separator = line[2] === " " ? 2 : line[1] === " " ? 1 : 2;
  const status = line.slice(0, separator);
  const path =
    line
      .slice(separator + 1)
      .split(" -> ")
      .at(-1) ?? "";
  return {
    added: status === "??" || status.includes("A"),
    path,
  };
}

function testFilePath(path: string) {
  return /(?:^|\/)(?:__tests__|tests?)\/|\.(?:spec|test)\.[^/]+$/i.test(path);
}

function sessionTaskComplexity(
  input: Pick<SendSessionInput, "prompt" | "userFiles" | "userImages">,
) {
  const attachmentCount =
    (input.userFiles?.length ?? 0) + (input.userImages?.length ?? 0);
  return taskComplexityBucket(input.prompt.length, attachmentCount);
}

function workspaceStatus(cwd: string) {
  return git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

function unresolvedMergeConflictMessage(conflicts: string[]) {
  return `Merge conflict agent finished with unresolved conflicts: ${conflicts.join(", ")}`;
}

function firstTextLine(value: unknown) {
  const line = stringValue(value)
    ?.trim()
    .replace(/^```(?:text)?\s*/, "")
    .replace(/\s*```$/, "")
    .split("\n")
    .find(Boolean)
    ?.trim();
  return line?.replace(/^["'`]|["'`]$/g, "");
}

function truncateText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated]`;
}

function approveMergeContext(input: ApproveAndMergeInput) {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    repositoryRoot: input.repositoryRoot,
    worktree: input.worktree,
    storyBranch: input.storyBranch,
  };
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

function forceOAuthRefresh(providerId: string) {
  return providerId === "openai-codex";
}

function supportedClineOAuthProvider(providerId: string) {
  return (
    providerId === "openai-codex" ||
    providerId === "cline" ||
    providerId === "opencode" ||
    providerId === "oca"
  );
}

function openAICodexOAuthProvider(sdk: ClineSdk): OAuthProviderInterface {
  return {
    id: "openai-codex",
    name: "ChatGPT Plus/Pro (ChatGPT Subscription)",
    usesCallbackServer: true,
    login: (callbacks: OAuthLoginCallbacks) => sdk.loginOpenAICodex(callbacks),
    refreshToken: (credentials: ClineOAuthCredentials) =>
      sdk.refreshOpenAICodexToken(credentials.refresh, credentials),
    getApiKey: (credentials: ClineOAuthCredentials) => credentials.access,
  };
}

function clineOAuthProvider(
  sdk: ClineSdk,
  providerId: "cline" | "opencode",
): OAuthProviderInterface {
  const provider = providerId === "opencode" ? providerId : undefined;
  return {
    id: providerId,
    name: providerId === "cline" ? "Cline Account" : "OpenCode",
    usesCallbackServer: false,
    login: (callbacks: OAuthLoginCallbacks) =>
      sdk.loginClineOAuth({
        apiBaseUrl: "https://api.cline.bot",
        callbacks,
        provider,
      }),
    refreshToken: (credentials: ClineOAuthCredentials) =>
      sdk.refreshClineToken(credentials, {
        apiBaseUrl: "https://api.cline.bot",
        provider,
      }),
    getApiKey: clineOAuthApiKey,
  };
}

function ocaOAuthProvider(sdk: ClineSdk): OAuthProviderInterface {
  return {
    id: "oca",
    name: "Oracle Code Assist",
    usesCallbackServer: true,
    login: (callbacks: OAuthLoginCallbacks) => sdk.loginOcaOAuth({ callbacks }),
    refreshToken: (credentials: ClineOAuthCredentials) =>
      sdk.refreshOcaToken(credentials),
    getApiKey: (credentials: ClineOAuthCredentials) => credentials.access,
  };
}

function clineOAuthApiKey(credentials: ClineOAuthCredentials) {
  if (credentials.access.startsWith("workos:")) return credentials.access;
  return `workos:${credentials.access}`;
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
    maxIterations: input.maxIterations ?? defaultSessionMaxIterations,
    pluginPathCount: input.pluginPaths?.length ?? 0,
    ...promptMetadata(input.prompt),
  };
}

function sessionContext(
  input: StartSessionInput,
  sessionId: string,
): ProductionSessionContext {
  return {
    maxIterations: input.maxIterations ?? defaultSessionMaxIterations,
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

function toBlameOAuthCredentials(
  credentials: ClineOAuthCredentials,
): OAuthCredentials {
  return {
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    accountId: credentials.accountId,
    email: credentials.email,
    metadata: credentials.metadata,
  };
}
