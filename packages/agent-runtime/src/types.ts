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

export type RequiredProjectCheck =
  import("./harness/light-contracts.js").RequiredProjectCheck;

export type CodeSelectionAttachment = {
  id?: string;
  content: string;
  endLine: number;
  // A conversation message is named by path and has no file lines. A story
  // attached as context is named by its number (US-042) and read with the
  // story history tools.
  origin?: "code" | "message" | "story";
  path: string;
  startLine: number;
  storyId?: string;
};

export type FileAttachment = {
  id?: string;
  content?: string;
  downloadUrl?: string;
  name: string;
  size: number;
  type: string;
};

export type ApproveAndMergeResult = {
  baseCommit: string;
  mergeCommit: string;
  targetBranch: string;
  push: ApproveAndMergePush;
};

export type ApproveAndMergePush =
  | { status: "pushed"; upstream: string }
  // The target branch has no upstream; remote is where it could be published.
  | { status: "no-upstream"; remote: string | null }
  // The merge was not pushed: the person did not ask for it.
  | { status: "skipped" };

export type {
  OpenPullRequestResult,
  PullRequestAvailability,
  PullRequestAvailabilityInput,
  PullRequestState,
  PullRequestStateInput,
} from "./pull-request-types.js";

export type GenerateCommitMessageResult = {
  message: string;
};

export type DirectStoryFilesInput = {
  // The project folder a Direct story works in.
  root: string;
  // Every agent session the story ran, including restored checkpoints.
  sessionIds: string[];
};

export type DirectStoryFile = {
  path: string;
  // The file holds changes that are not the story's: it differed from HEAD
  // before the story first wrote it, or it changed after the story's last write.
  shared: boolean;
};

export type DirectStoryFilesResult = {
  // Files the story wrote that still differ from HEAD and can be committed.
  files: DirectStoryFile[];
};

export type ResolveMergeConflictsResult = {
  conflicts: string[];
  resolved: boolean;
};

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

export type {
  MapSecurityAuditInput,
  MapSecurityAuditResult,
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
  SecurityAuditWorkspaceMap,
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

export type StoryPlanPriority = "Low" | "Medium" | "High";

/** A user story an agent proposes; nothing is created until the person adds it. */
export type PlannedUserStory = {
  // Stable within one reply (P1, P2…); dependencies point at these keys or
  // at existing stories (US-012).
  key: string;
  title: string;
  summary: string;
  priority: StoryPlanPriority;
  dependsOn: string[];
  // Names of the files the person attached to the conversation that this
  // story needs; the app hands them to the story's coding agent.
  attachments: string[];
  // Set by the app once the person added it to the backlog.
  addedAs?: string;
  dismissed?: boolean;
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

export type ApprovalDecision = "approve" | "deny" | "always";
