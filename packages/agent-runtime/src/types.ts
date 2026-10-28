import type {
  CompareCheckpointResult as ClineCompareCheckpointResult,
  Message,
  RestoreResult as ClineRestoreResult,
} from "@cline/sdk";
import type {
  PreviewLifecycleState,
  PreviewManifest,
} from "@blame/preview-contract";

export type ApiConnection = {
  url: string;
  token?: string | null;
};

export type BlameModel = {
  id: string;
  name: string;
  status?: string;
  description?: string;
  contextWindow?: number;
  // The usable input budget, below the window (ChatGPT plans cap it lower).
  maxInputTokens?: number;
  maxTokens?: number;
  capabilities?: string[];
  releaseDate?: string;
  canonicalModelId?: string;
  matchConfidence?: number;
  benchmark?: ModelBenchmark;
  cost: {
    input: number | null;
    output: number | null;
    cacheRead?: number | null;
    cacheWrite?: number | null;
  };
  variants?: Record<string, unknown>;
};

export type ModelBenchmark = {
  smartScore: number;
  codingIndex?: number;
  agenticIndex?: number;
  intelligenceIndex?: number;
  designArenaScore?: number;
};

export type ModelRecommendation = {
  providerId: string;
  modelId: string;
  position: number;
  segment: "benchmarked" | "unbenchmarked";
  estimatedCost: number | null;
  smartScore?: number;
};

export type ModelRecommendationProfile = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  sampleCount: number;
};

export type ModelRecommendations = {
  generatedAt: string;
  benchmarkBoundary: number;
  all: ModelRecommendation[];
  byProvider: Record<string, ModelRecommendation[]>;
  profile: ModelRecommendationProfile;
};

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ReasoningSelection = "none" | "enabled" | ReasoningEffort;
export type AgentMode = "act" | "plan" | "yolo";
export type AgentBackendMode = "auto" | "local" | "hub" | "remote";
export type AgentRuntimeConfigExtension =
  | "plugins"
  | "rules"
  | "skills"
  | "workflows";

export type AgentBackendConfig = {
  authToken?: string;
  cwd?: string;
  endpoint?: string;
  key?: string;
  mode: AgentBackendMode;
  workspaceRoot?: string;
};

export type AgentRuntimePrewarmInput = {
  backend: AgentBackendConfig;
  cwd: string;
  workspaceRoot: string;
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
};

export type BlameProvider = {
  id: string;
  name: string;
  description?: string;
  baseUrl?: string;
  defaultModelId?: string;
  capabilities?: string[];
  models: Record<string, BlameModel>;
};

/** "local-cli": the provider signs in through a CLI on this computer. */
export type ProviderAuthMethod = "api-key" | "oauth" | "local-cli";

export type ProviderCredentialSummary = {
  id: string;
  userId: string;
  providerId: string;
  label: string;
  authMethod?: ProviderAuthMethod;
  baseUrl: string | null;
  modelIds?: string[];
  accountId?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string | null;
};

export type ProviderListResponse = {
  all: BlameProvider[];
  connected: string[];
  default: Record<string, string>;
  credentials: ProviderCredentialSummary[];
  recommendations: ModelRecommendations;
};

export type SaveProviderCredentialInput = {
  providerId: string;
  label?: string;
  apiKey: string;
  baseUrl?: string | null;
  modelIds?: string[];
};

export type DeleteProviderCredentialInput = {
  id: string;
};

export type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
  metadata?: Record<string, unknown>;
};

export type SaveOAuthCredentialInput = {
  providerId: string;
  label?: string;
  apiKey: string;
  oauthCredentials: OAuthCredentials;
  baseUrl?: string | null;
};

export type SaveLocalProviderCredentialInput = {
  providerId: string;
  label?: string;
  accountId?: string | null;
};

export type ConnectClaudeCodeInput = {
  apiConnection: ApiConnection;
  label?: string;
};

export type ClaudeCodeStatus = {
  installed: boolean;
  executablePath?: string;
  version?: string;
  loggedIn: boolean;
  /** "claude.ai" when Claude Code uses a Pro, Max or Team subscription. */
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  error?: string;
};

export type SubscriptionUsageInput = {
  apiConnection: ApiConnection;
  providerId: string;
  credentialLabel?: string;
};

/** One limit window of a subscription plan, such as 5 hours or a week. */
export type SubscriptionUsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  /** Epoch milliseconds, when the provider gives an exact time. */
  resetsAt?: number;
  /** The provider's own wording, when it gives no exact time. */
  resetsLabel?: string;
  windowMinutes?: number;
};

export type SubscriptionUsage = {
  providerId: string;
  windows: SubscriptionUsageWindow[];
  planType?: string;
  checkedAt: number;
};

export type LoginOAuthProviderInput = {
  apiConnection: ApiConnection;
  providerId: string;
  label?: string;
  baseUrl?: string | null;
};

export type RequiredProjectCheck =
  import("./harness/light-contracts.js").RequiredProjectCheck;

export type StartSessionInput = {
  requiredChecks?: RequiredProjectCheck[];
  isolatedEnvironment?: boolean;
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningSelection;
  // Caps the context the agent works in (compaction follows it). Unset: the
  // provider's own input limit.
  maxInputTokens?: number;
  autoApproveWriteTools?: boolean;
  autoSendPrompt?: boolean;
  checkpointEnabled?: boolean;
  configExtensions?: AgentRuntimeConfigExtension[];
  disableMcpSettingsTools?: boolean;
  mode?: AgentMode;
  maxIterations?: number;
  pluginPaths?: string[];
  prompt: string;
  sessionId?: string | null;
  initialMessages?: Message[];
  userImages?: string[];
  userFiles?: string[];
  cwd: string;
  workspaceRoot: string;
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
  systemPrompt?: string;
  previewDevtoolsScope?: string;
  credentialLabel?: string;
  backend?: AgentBackendConfig;
  executionId?: string;
  projectId?: string;
  storyId?: string;
};

export type CodeSelectionAttachment = {
  id?: string;
  content: string;
  endLine: number;
  path: string;
  startLine: number;
};

export type FileAttachment = {
  id?: string;
  content?: string;
  downloadUrl?: string;
  name: string;
  size: number;
  type: string;
};

export type StartDevelopmentSessionInput = {
  requiredChecks?: RequiredProjectCheck[];
  isolatedEnvironment?: boolean;
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  credentialLabel?: string;
  reasoningEffort?: ReasoningSelection;
  maxInputTokens?: number;
  autoSendPrompt?: boolean;
  checkpointEnabled?: boolean;
  configExtensions?: AgentRuntimeConfigExtension[];
  disableMcpSettingsTools?: boolean;
  enableSpecialistConsult?: boolean;
  maxIterations?: number;
  pluginPaths?: string[];
  title: string;
  summary: string;
  codeSelectionAttachments?: CodeSelectionAttachment[];
  fileAttachments?: FileAttachment[];
  feedback?: string;
  feedbackCodeSelectionAttachments?: CodeSelectionAttachment[];
  feedbackFileAttachments?: FileAttachment[];
  resumeSessionId?: string | null;
  sessionId?: string;
  cwd: string;
  workspaceRoot: string;
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
  previewDevtoolsScope?: string;
  codePractices?: ProjectCodePracticePreference[];
  projectInitialization?: {
    previewManifest: PreviewManifest;
    runConfigurations: ProjectRunConfiguration[];
    databaseMode?: ProjectInitializationDatabaseMode | null;
  };
  backend?: AgentBackendConfig;
  executionId?: string;
  projectId?: string;
  storyId?: string;
};

export type ApproveAndMergeInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  credentialLabel?: string;
  reasoningEffort?: ReasoningSelection;
  repositoryRoot: string;
  worktree: string;
  storyBranch: string;
  title: string;
  summary: string;
  codePractices?: ProjectCodePracticePreference[];
  backend?: AgentBackendConfig;
  executionId?: string;
  storyId?: string;
};

export type ApproveAndMergeResult = {
  baseCommit: string;
  mergeCommit: string;
  targetBranch: string;
};

export type GenerateCommitMessageInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  credentialLabel?: string;
  reasoningEffort?: ReasoningSelection;
  repositoryRoot: string;
  worktree: string;
  title?: string;
  summary?: string;
  selectedPaths?: string[];
  codePractices?: ProjectCodePracticePreference[];
  backend?: AgentBackendConfig;
  executionId?: string;
  storyId?: string;
};

export type GenerateCommitMessageResult = {
  message: string;
};

export type GenerateTitleInput = {
  apiConnection: ApiConnection;
  context: "quick-chat" | "user-story";
  providerId: string;
  modelId: string;
  prompt: string;
  cwd: string;
  workspaceRoot: string;
  reasoningEffort?: ReasoningSelection;
  credentialLabel?: string;
  backend?: AgentBackendConfig;
  executionId?: string;
  storyId?: string;
  runConfigurations?: ProjectRunConfiguration[];
};

export type GenerateTitleResult = {
  sessionId: string;
  title: string;
  runConfigurationId?: string | null;
};

export type ResolveMergeConflictsInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  credentialLabel?: string;
  reasoningEffort?: ReasoningSelection;
  repositoryRoot: string;
  worktree: string;
  title?: string;
  summary?: string;
  targetBranch?: string;
  codePractices?: ProjectCodePracticePreference[];
  backend?: AgentBackendConfig;
  executionId?: string;
  storyId?: string;
};

export type ResolveMergeConflictsResult = {
  conflicts: string[];
  resolved: boolean;
};

export type SendSessionInput = {
  sessionId: string;
  prompt: string;
  executionId?: string;
  storyId?: string;
  userImages?: string[];
  userFiles?: string[];
};

export type SendDevelopmentSessionInput = {
  sessionId: string;
  executionId?: string;
  storyId?: string;
  title: string;
  summary: string;
  codeSelectionAttachments?: CodeSelectionAttachment[];
  fileAttachments?: FileAttachment[];
  feedback?: string;
  feedbackCodeSelectionAttachments?: CodeSelectionAttachment[];
  feedbackFileAttachments?: FileAttachment[];
  feedbackOnly?: boolean;
};

export type CompareCheckpointInput = {
  checkpointRunCount: number;
  cwd?: string;
  sessionId: string;
};

export type CompareCheckpointResult = ClineCompareCheckpointResult;

export type RestoreCheckpointInput = CompareCheckpointInput & {
  restore?: {
    messages?: boolean;
    omitCheckpointMessageFromSession?: boolean;
    workspace?: boolean;
  };
};

export type RestoreCheckpointResult = ClineRestoreResult;

export type ProjectCodePracticeKey =
  | "coding_style"
  | "unit_tests"
  | "layered_architecture"
  | "commit_message_convention";

export type ProjectCodePracticeResult = {
  practice: ProjectCodePracticeKey;
  detected: boolean;
  comment: string;
};

export type ProjectCodePracticePreference = {
  practice: ProjectCodePracticeKey;
  enabled: boolean;
};

export type ProjectRunConfiguration = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  default: boolean;
  category: ProjectRunConfigurationCategory;
  services: string[];
  previewService?: string;
  previewTarget?: string;
  scopes: string[];
  previewUrl?: string;
};

export type ProjectRunConfigurationCategory =
  | "web"
  | "mobile"
  | "desktop"
  | "terminal"
  | "service"
  | "other";

export type ProjectRunConfigurationStatus =
  | "running"
  | "stopped"
  | "starting"
  | "error";

export type ProjectPreviewRuntimeState = {
  configurations: ProjectRunConfiguration[];
  desiredStatus: "running" | "stopped";
  lifecycle?: PreviewLifecycleState;
  previewUrl?: string;
  selectedConfigurationId?: string;
  statuses: Record<string, ProjectRunConfigurationStatus>;
};

export type {
  PreviewLifecyclePhase,
  PreviewLifecycleState,
  PreviewLifecycleStatus,
  PreviewManifest,
  PreviewManifestBinding,
  PreviewManifestBindingSource,
  PreviewManifestBindingTarget,
  PreviewManifestCache,
  PreviewManifestConfidence,
  PreviewManifestContainer,
  PreviewManifestContainerBuild,
  PreviewManifestEndpoint,
  PreviewManifestEndpointHealthcheck,
  PreviewManifestEnvironment,
  PreviewManifestProbe,
  PreviewManifestProbeTarget,
  PreviewManifestProject,
  PreviewManifestRisk,
  PreviewManifestService,
  PreviewManifestServiceKind,
  PreviewManifestSetupTask,
} from "@blame/preview-contract";

export type ProjectInitializationDatabaseMode = "existing" | "compose";

// Replaces a story worktree's preview setup with a repaired manifest.
export type ApplyPreviewInitializationInput = {
  databaseMode: ProjectInitializationDatabaseMode;
  previewManifest: PreviewManifest;
  reason: string;
  repairSessionId: string;
  runConfigurations: ProjectRunConfiguration[];
  storyId: string;
  worktree: string;
};

export type ProjectInitializationPreferences = {
  database?: {
    mode: ProjectInitializationDatabaseMode;
  };
};

export type InitializeProjectInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningSelection;
  cwd: string;
  workspaceRoot: string;
  credentialLabel?: string;
  preferences?: ProjectInitializationPreferences;
  validationFeedback?: {
    validationError: string;
    previousResult: string;
  };
  backend?: AgentBackendConfig;
  executionId?: string;
  storyId?: string;
  /** Channel of `initialization_progress` notices, see initialization-progress.ts. */
  progressId?: string;
};

export type InitializeProjectResult = {
  sessionId: string;
  previewManifest: PreviewManifest;
  runConfigurations: ProjectRunConfiguration[];
};

export type AnalyzeProjectCodePracticesInput = Omit<
  InitializeProjectInput,
  "preferences"
>;

export type AnalyzeProjectCodePracticesResult = {
  sessionId: string;
  practices: ProjectCodePracticeResult[];
};

export type {
  DiscoverSecurityAuditInput,
  MapSecurityAuditInput,
  MapSecurityAuditResult,
  RunSecurityAuditInput,
  SecurityAttackPathStep,
  SecurityAudit,
  SecurityAuditDiscoveryResult,
  SecurityAuditFindingHistory,
  SecurityAuditMode,
  SecurityAuditPerspective,
  SecurityAuditProgress,
  SecurityAuditProgressStep,
  SecurityAuditProgressStepStatus,
  SecurityAuditStatus,
  SecurityCandidate,
  SecurityConfidence,
  SecurityCoverage,
  SecurityCoverageArea,
  SecurityDeterministicScanResult,
  SecurityEvidence,
  SecurityFinding,
  SecurityFindingStatus,
  SecurityPriority,
  SecurityRevision,
  SecurityScannerCoverage,
  SecuritySeverity,
  SecuritySourceLocation,
  SecuritySurfaceMap,
  SecurityThreatModel,
  ValidateSecurityAuditInput,
  ValidateSecurityAuditResult,
} from "./security-audit-types.js";

export type ProjectInitializationRepairClassification =
  | "repairable_initialization"
  | "project_code_failure"
  | "external_failure"
  | "unknown";

export type ProjectInitializationDiagnostics = {
  setupLog: string;
  launchError: string;
  composeConfig: string;
  composePs: string;
  serviceLogs: Record<string, string>;
};

export type ProjectInitializationImpactClassification =
  | "initialization_update_required"
  | "initialization_still_valid"
  | "project_code_failure"
  | "unknown";

export type ProjectInitializationImpactDiagnostics = {
  baseCommit: string;
  mergeCommit: string;
  changedFiles: string[];
  diffSummary: string;
  relevantDiffs: Record<string, string>;
  currentPreviewManifest: PreviewManifest;
  currentRunConfigurations: ProjectRunConfiguration[];
  strategicFilesBefore: Record<string, string>;
  strategicFilesAfter: Record<string, string>;
};

export type AssessProjectInitializationImpactInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningSelection;
  cwd: string;
  workspaceRoot: string;
  credentialLabel?: string;
  baseCommit: string;
  mergeCommit: string;
  previewManifest: PreviewManifest;
  runConfigurations: ProjectRunConfiguration[];
  backend?: AgentBackendConfig;
  executionId?: string;
  storyId?: string;
};

export type AssessProjectInitializationImpactResult = {
  sessionId?: string;
  classification: ProjectInitializationImpactClassification;
  reason: string;
  repairInstruction?: string;
  diagnostics?: ProjectInitializationImpactDiagnostics;
};

export type RepairProjectInitializationInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningSelection;
  cwd: string;
  workspaceRoot: string;
  credentialLabel?: string;
  previewManifest: PreviewManifest;
  runConfigurations: ProjectRunConfiguration[];
  preferences?: ProjectInitializationPreferences;
  diagnostics:
    | ProjectInitializationDiagnostics
    | ProjectInitializationImpactDiagnostics;
  backend?: AgentBackendConfig;
  executionId?: string;
  storyId?: string;
};

export type RepairProjectInitializationResult = {
  sessionId: string;
  classification: ProjectInitializationRepairClassification;
  reason: string;
  previewManifest?: PreviewManifest;
  runConfigurations?: ProjectRunConfiguration[];
};

export type {
  NewProjectGenerationConfiguration,
  StartNewProjectGenerationInput,
  NewProjectPlanMessage,
  PlanNewProjectInput,
  PlanNewProjectResult,
  NewProjectGenerationResult,
  NewProjectsClient,
} from "./new-project-types.js";

export type OptimizeUserStoryPromptInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  prompt: string;
  cwd: string;
  workspaceRoot: string;
  reasoningEffort?: ReasoningSelection;
  credentialLabel?: string;
  title?: string;
  backend?: AgentBackendConfig;
  executionId?: string;
  storyId?: string;
};

export type OptimizeUserStoryPromptResult = {
  sessionId: string;
  markdown: string;
};

export type StoryPlanPriority = "Low" | "Medium" | "High";

/** A user story the planning agent proposes; nothing is created until the person adds it. */
export type PlannedUserStory = {
  // Stable within one reply (P1, P2…); dependencies point at these keys or
  // at existing stories (US-012).
  key: string;
  title: string;
  summary: string;
  priority: StoryPlanPriority;
  dependsOn: string[];
  // Set by the app once the person added it to the backlog.
  addedAs?: string;
  dismissed?: boolean;
};

export type StoryPlanMessage = {
  role: "user" | "assistant";
  text: string;
  stories?: PlannedUserStory[];
};

export type PlanUserStoriesInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  credentialLabel?: string;
  reasoningEffort?: ReasoningSelection;
  backend?: AgentBackendConfig;
  cwd: string;
  workspaceRoot: string;
  projectId: string;
  // Chosen by the app so it can follow the agent's steps while it plans.
  sessionId?: string;
  executionId?: string;
  // The conversation so far, ending with the person's latest message.
  messages: StoryPlanMessage[];
  // The planner's private notes from its previous reply.
  notes?: string;
};

export type PlanUserStoriesResult = {
  sessionId: string;
  message: string;
  stories: PlannedUserStory[];
  notes?: string;
};

export type AgentSessionRecord = {
  sessionId: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AgentUsageTotals = {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  inputTokens: number;
  outputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  totalCost?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
};

export type CompactSessionInput = {
  apiConnection: ApiConnection;
  backend?: AgentBackendConfig;
  credentialLabel?: string;
  maxInputTokens?: number;
  modelId: string;
  providerId: string;
  sessionId: string;
};

export type CompactSessionResult = {
  compacted: boolean;
  tokensAfter?: number;
  tokensBefore?: number;
};

export type AgentUsageSummary = {
  aggregateUsage?: AgentUsageTotals;
  usage?: AgentUsageTotals;
};

export type ExecutionTelemetryCohorts = {
  agentStrategy: "single_agent" | "multi_agent";
  modelId: string;
  providerId: string;
  repositoryLanguage?: string;
  repositorySizeBucket?: "small" | "medium" | "large" | "very_large";
  taskComplexityBucket: "small" | "medium" | "large";
};

export type AgentDonePayload = {
  completion?: import("@blame/harness-core").CompletionDecision;
  text?: string;
  verified?: boolean;
  [key: string]: unknown;
};

export type AgentEvent = {
  type:
    | "text"
    | "reasoning"
    | "tool"
    | "approval"
    | "usage"
    | "notice"
    | "done"
    | "error"
    | "raw";
  sessionId?: string;
  runId?: string;
  executionId?: string;
  eventId?: string;
  sequenceNumber?: number;
  eventType?: string;
  createdAt?: string;
  payload: unknown;
};

export type AgentRuntimeEvents = {
  emit(event: AgentEvent): void;
  captureHiddenToolEvent?(event: AgentEvent): void;
};

export type CodeGraphStatusState =
  | "missing"
  | "building"
  | "ready"
  | "stale"
  | "error";

export type CodeGraphStatus = {
  available: boolean;
  branch?: string;
  builtCommit?: string;
  command?: string;
  contextSavings?: Record<string, unknown>;
  edges?: number;
  files?: number;
  languages?: string[];
  lastUpdated?: string;
  message?: string;
  nodes?: number;
  recommendation?: string;
  staleReason?: string;
  state: CodeGraphStatusState;
  version?: string;
  worktree: string;
};

export type CodeGraphUpdateInput = {
  force?: boolean;
  signal?: AbortSignal;
  waitMs?: number;
  worktree: string;
};

export type CodeGraphUpdateResult = CodeGraphStatus & {
  action: "building" | "failed" | "skipped" | "unavailable" | "updated";
  durationMs?: number;
  output?: string;
};

export type CodeGraphQueryInput = {
  base?: string;
  changedFiles?: string[];
  signal?: AbortSignal;
  task?: string;
  waitMs?: number;
  worktree: string;
};

export type CodeGraphMinimalContextInput = CodeGraphQueryInput;

export type CodeGraphImpactRadiusInput = CodeGraphQueryInput & {
  maxDepth?: number;
};

export type CodeGraphReviewContextInput = CodeGraphImpactRadiusInput & {
  includeSource?: boolean;
  maxLinesPerFile?: number;
};

export type CodeGraphArchitectureOverviewInput = CodeGraphQueryInput & {
  detailLevel?: "minimal" | "standard";
};

export type CodeGraphQueryResult = CodeGraphStatus & {
  data?: unknown;
  source?: "cli" | "mcp";
};

export type CodeReviewGraphProvider = {
  architectureOverview(
    input: CodeGraphArchitectureOverviewInput,
  ): Promise<CodeGraphQueryResult>;
  impactRadius(
    input: CodeGraphImpactRadiusInput,
  ): Promise<CodeGraphQueryResult>;
  minimalContext(
    input: CodeGraphMinimalContextInput,
  ): Promise<CodeGraphQueryResult>;
  reviewContext(
    input: CodeGraphReviewContextInput,
  ): Promise<CodeGraphQueryResult>;
  status(input: {
    signal?: AbortSignal;
    waitMs?: number;
    worktree: string;
  }): Promise<CodeGraphStatus>;
  update(input: CodeGraphUpdateInput): Promise<CodeGraphUpdateResult>;
};

export type ApprovalDecision = "approve" | "deny" | "always";

export type AgentApprovalRequest = {
  id: string;
  sessionId?: string;
  toolName: string;
  reason?: string;
  input?: unknown;
};

export type ResolveApprovalInput = {
  requestId: string;
  decision: ApprovalDecision;
};
