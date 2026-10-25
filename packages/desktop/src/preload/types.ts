import type {
  AgentEvent,
  NewProjectsClient,
  AgentUsageSummary,
  CompactSessionInput,
  CompactSessionResult,
  AnalyzeProjectCodePracticesInput,
  AnalyzeProjectCodePracticesResult,
  ApiConnection,
  ApproveAndMergeInput,
  ApproveAndMergeResult,
  AssessProjectInitializationImpactInput,
  AssessProjectInitializationImpactResult,
  CompareCheckpointInput,
  CompareCheckpointResult,
  ExecutionTelemetryCohorts,
  GenerateCommitMessageInput,
  GenerateCommitMessageResult,
  GenerateTitleInput,
  GenerateTitleResult,
  PlanUserStoriesInput,
  PlanUserStoriesResult,
  InitializeProjectInput,
  InitializeProjectResult,
  ProjectInitializationDiagnostics,
  ClaudeCodeStatus,
  ConnectClaudeCodeInput,
  SubscriptionUsage,
  SubscriptionUsageInput,
  LoginOAuthProviderInput,
  OptimizeUserStoryPromptInput,
  OptimizeUserStoryPromptResult,
  ApplyPreviewInitializationInput,
  PreviewManifest,
  ProjectPreviewRuntimeState,
  ProjectRunConfiguration,
  ProviderListResponse,
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
  StartSessionInput,
} from "@blame/agent-runtime";
import type {
  BacklogStatusPipRequest,
  BacklogStatusPipSnapshot,
  CloudAuthRequestClient,
  DeployClient,
  GitCommandResult,
  GitLogCommit,
  GitStatusResult,
  SecurityAuditClient,
} from "@blame/app";
import type {
  AgentScreenshotsClient,
  McpServersClient,
  PreviewDevtoolsSettingsClient,
} from "@blame/app";
import type { RuntimeDiagnosticInput, RuntimeProgress } from "@blame/app";
import type { TelemetryExportSession } from "@blame/app";
import type { HostDependencyReport } from "../main/host-dependencies";
import type { RuntimeStatusReport } from "../main/runtime-manager";
import type { CreateProjectInput } from "../main/project-creation";
import type {
  PreviewLogEvent,
  PreviewSessionCommand,
  PreviewSessionEvent,
  PreviewSessionView,
  LiveSyncStatus,
  RuntimeProfileId,
} from "@blame/preview-runtime";

export type OpenDirectoryPickerOptions = {
  title?: string;
  multiple?: boolean;
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

export type WorktreeResult = {
  worktree: string;
  branch: string;
  workspaceMode: "local-container" | "cloud-mirror" | "direct";
};

export type ProjectSetupEvent = {
  runId: string;
  type: "stdout" | "stderr" | "exit";
  data: string;
};

export type GitConflictFile = {
  base: string;
  current: string;
  incoming: string;
  path: string;
  result: string;
};

export type ProjectCreationEvent = {
  type: "stdout" | "stderr" | "exit";
  data: string;
};

export type ProjectServiceLogEvent = {
  streamId: string;
  type: "stdout" | "stderr" | "exit";
  data: string;
};

export type TerminalEvent = {
  id: string;
  type: "stdout" | "stderr" | "exit";
  data: string;
};

export type PreviewBrowserBounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type PreviewBrowserState = {
  error?: string;
  id: string;
  loading: boolean;
  url?: string;
};

// One window per open project.
// The open project's app, for the app's shared runner: who holds its port,
// and the agent's requests about it (answered by this window).
export type ProjectApp = {
  inspectPort(input: {
    port: number;
    projectPath: string;
  }): Promise<import("../main/local-port-owner").LocalPortOwner>;
  onRequest(
    callback: (request: { action: "start" | "status"; id: string }) => void,
  ): () => void;
  respond(
    id: string,
    result: import("../main/ipc/project-app-ipc").ProjectAppResult,
  ): Promise<boolean>;
};

export type ProjectWindows = {
  focusProject(path: string): Promise<boolean>;
  openProject(path: string): Promise<"focused" | "opened" | undefined>;
  reportProject(path: string | null): void;
};

export type WindowControls = {
  close(): void;
  isMaximized(): Promise<boolean>;
  minimize(): Promise<void>;
  onMaximized(callback: (maximized: boolean) => void): () => void;
  setPresentation(input: WindowPresentationInput): Promise<boolean>;
  toggleMaximize(): Promise<void>;
};

export type WindowPresentationInput = {
  pathname: string;
  role: "compact" | "workspace";
};

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export type DesktopUpdateChannel = "stable" | "beta";

export type DesktopUpdateStatus = {
  channel: DesktopUpdateChannel;
  currentVersion: string;
  error?: string;
  latestVersion?: string;
  phase: DesktopUpdatePhase;
  progress?: number;
  reason?: string;
  releaseDate?: string;
  releaseNotes?: string;
};

export type DesktopUpdates = {
  check(): Promise<DesktopUpdateStatus>;
  download(): Promise<DesktopUpdateStatus>;
  getStatus(): Promise<DesktopUpdateStatus>;
  install(): Promise<DesktopUpdateStatus>;
  onStatus(callback: (status: DesktopUpdateStatus) => void): () => void;
  setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateStatus>;
};

export type NotificationTarget = {
  pathname: string;
  storyId?: string;
  chatId?: string;
  tab?: string;
};

export type SystemNotificationInput = {
  body?: string;
  title: string;
  target?: NotificationTarget;
};

export type SystemNotifications = {
  show(input: SystemNotificationInput): Promise<boolean>;
  onClick(callback: (target: NotificationTarget) => void): () => void;
};

export type AppStatus = {
  setActivity(input: { running: number }): Promise<void>;
  requestAttention(): Promise<void>;
};

export type BacklogStatusPip = {
  onRequest(callback: (request: BacklogStatusPipRequest) => void): () => void;
  onSnapshot(
    callback: (snapshot: BacklogStatusPipSnapshot) => void,
  ): () => void;
  open(): Promise<boolean>;
  publish(snapshot: BacklogStatusPipSnapshot): void;
  request(input: BacklogStatusPipRequest): Promise<boolean>;
  close(): void;
  setMode(input: {
    compact: boolean;
    contentHeight?: number;
  }): Promise<boolean>;
};

export type BlameDesktopApi = {
  auth: {
    onCallback(
      callback: (result: { code?: string; error?: string }) => void,
    ): () => void;
    request: CloudAuthRequestClient["request"];
    ready(): void;
  };
  billing: {
    onRefreshLicense(callback: () => void): () => void;
    ready(): void;
  };
  deploy: DeployClient;
  telemetry: {
    configure(session: TelemetryExportSession): Promise<boolean>;
    disable(): Promise<boolean>;
    sendRuntimeDiagnostic(input: RuntimeDiagnosticInput): Promise<boolean>;
  };
  openDirectoryPicker(
    options?: OpenDirectoryPickerOptions,
  ): Promise<string | string[] | null>;
  requestMicrophoneAccess(): Promise<boolean>;
  openMicrophoneSettings(): Promise<void>;
  openExternalLink(url: string): void;
  openPath(path: string): Promise<string>;
  backlogStatusPip: BacklogStatusPip;
  platform: NodeJS.Platform;
  systemNotifications: SystemNotifications;
  appStatus: AppStatus;
  appearance: import("@blame/app").AppearanceClient;
  updates: DesktopUpdates;
  mcp: McpServersClient;
  windowControls: WindowControls;
  projectApp: ProjectApp;
  projectWindows: ProjectWindows;
  agentScreenshots: AgentScreenshotsClient;
  previewDevtools: PreviewDevtoolsSettingsClient;
  previewBrowser: {
    capture(input: {
      id: string;
      size?: "full" | "thumbnail";
    }): Promise<string | null>;
    create(input: {
      storageKey: string;
      previewSessionId?: string;
      previewWorktree?: string;
    }): Promise<{ id: string }>;
    destroy(input: { id: string }): Promise<boolean>;
    load(input: { id: string; url: string }): Promise<boolean>;
    onState(
      input: { id: string },
      callback: (state: PreviewBrowserState) => void,
    ): () => void;
    reload(input: { id: string }): Promise<boolean>;
    setDevtoolsScope(input: {
      id: string;
      scope?: string | null;
    }): Promise<boolean>;
    setBounds(input: {
      bounds: PreviewBrowserBounds;
      id: string;
      visible: boolean;
    }): Promise<boolean>;
  };
  previewRuntime: {
    configure(connection: ApiConnection): Promise<boolean>;
    disconnect(): Promise<boolean>;
    create(input: {
      userStoryId: string;
      profile: "vercel-compose";
      previewManifest: PreviewManifest;
      cloudUploadConsentAt: string;
      operationId: string;
      localPath: string;
      sourceRevision?: string;
      resourceSize?: { vcpus: number; memoryGb: number };
    }): Promise<PreviewSessionView>;
    get(input: { sessionId: string }): Promise<PreviewSessionView>;
    findForUserStory(input: {
      userStoryId: string;
      profile: "vercel-compose";
    }): Promise<{ session: PreviewSessionView | null }>;
    openExternal(input: {
      sessionId: string;
      routeId?: string;
    }): Promise<boolean>;
    command(input: {
      sessionId: string;
      command: PreviewSessionCommand;
      operationId: string;
    }): Promise<PreviewSessionView>;
    syncIn(input: { sessionId: string; localPath: string }): Promise<{
      session: PreviewSessionView;
      sourceRevision: string;
      workspaceHash: string;
    }>;
    syncOut(input: { sessionId: string; localPath?: string }): Promise<{
      session: PreviewSessionView;
      revision: string;
      finalHash: string;
    }>;
    syncStatus(input: { sessionId: string }): Promise<LiveSyncStatus | null>;
    onEvent(
      input: { sessionId: string; cursor?: string },
      callback: (event: PreviewSessionEvent) => void,
      onError?: (message: string) => void,
    ): () => void;
    onLog(
      input: { sessionId: string; cursor?: string },
      callback: (event: PreviewLogEvent) => void,
      onError?: (message: string) => void,
    ): () => void;
  };
  securityAudits: SecurityAuditClient;
  workspace: {
    pathExists(input: { path: string }): Promise<boolean>;
    optimizeAttachmentForAiContext(input: {
      content: string;
      name: string;
      type: string;
    }): Promise<{ markdown: string }>;
    listDirectory(input: {
      root: string;
      path?: string;
    }): Promise<WorkspaceEntry[]>;
    readFile(input: { root: string; path: string }): Promise<string>;
    searchFiles(input: {
      root: string;
      query: string;
      limit?: number;
    }): Promise<WorkspaceEntry[]>;
    gitDiff(input: { root: string }): Promise<string>;
    gitDiffStats(input: {
      from?: string;
      root: string;
      to?: string;
    }): Promise<{ additions: number; deletions: number; files: number }>;
    gitDiffBetween(input: {
      from: string;
      root: string;
      to: string;
    }): Promise<string>;
    gitDiffFrom(input: { from: string; root: string }): Promise<string>;
    gitSnapshot(input: { id: string; root: string }): Promise<string>;
    gitStatus(input: { root: string }): Promise<GitStatusResult>;
    gitCommitCount(input: { root: string }): Promise<number>;
    gitLog(input: {
      currentBranchOnly?: boolean;
      root: string;
      limit?: number;
      skip?: number;
    }): Promise<GitLogCommit[]>;
    gitFileDiff(input: {
      root: string;
      path: string;
      staged?: boolean;
    }): Promise<string>;
    gitCommitDiff(input: { root: string; hash: string }): Promise<string>;
    gitConflictFile(input: {
      root: string;
      path: string;
    }): Promise<GitConflictFile>;
    gitAcceptConflictFile(input: {
      root: string;
      path: string;
      side: "current" | "incoming";
    }): Promise<boolean>;
    gitResolveConflictFile(input: {
      root: string;
      path: string;
      content?: string;
    }): Promise<boolean>;
    gitAbortConflict(input: { root: string }): Promise<GitCommandResult>;
    gitContinueConflict(input: { root: string }): Promise<GitCommandResult>;
    gitStageFiles(input: { root: string; paths: string[] }): Promise<boolean>;
    gitUnstageFiles(input: { root: string; paths: string[] }): Promise<boolean>;
    gitRollbackFiles(input: {
      root: string;
      paths: string[];
    }): Promise<boolean>;
    gitDeleteFiles(input: { root: string; paths: string[] }): Promise<boolean>;
    gitCommit(input: {
      root: string;
      message: string;
    }): Promise<GitCommandResult>;
    gitPush(input: { root: string }): Promise<GitCommandResult>;
    listGitDirectory(input: {
      path?: string;
      refs: string[];
      root: string;
    }): Promise<WorkspaceEntry[]>;
    readGitFile(input: {
      path: string;
      refs: string[];
      root: string;
    }): Promise<string>;
    gitRepositoryFingerprint(input: { root: string }): Promise<string | null>;
    ensureGitRepository(input: { root: string }): Promise<boolean>;
    createProject(input: CreateProjectInput): Promise<{
      path: string;
    }>;
    createWorktree(input: {
      // Run in the project folder instead of a new worktree.
      direct?: boolean;
      executionId: string;
      repositoryRoot: string;
      runtimeProfile: RuntimeProfileId;
      storyId: string;
      storyReference: string;
      telemetryCohorts?: ExecutionTelemetryCohorts;
      title: string;
    }): Promise<WorktreeResult>;
    checkHostDependencies(input: {
      includeRuntime?: boolean;
      runtimeProfile?: RuntimeProfileId;
      setupScript?: string;
      worktree?: string;
    }): Promise<HostDependencyReport>;
    prepareProjectPreview(input: {
      executionId: string;
      storyId: string;
      telemetryCohorts?: ExecutionTelemetryCohorts;
      worktree: string;
      previewManifest: PreviewManifest;
      runConfigurations: ProjectRunConfiguration[];
      runConfigurationId?: string | null;
      hostDependenciesChecked?: boolean;
      runtimeProfile: RuntimeProfileId;
    }): Promise<{ prepared: true }>;
    runProjectSetup(input: {
      executionId: string;
      storyId: string;
      telemetryCohorts?: ExecutionTelemetryCohorts;
      worktree: string;
      previewManifest: PreviewManifest;
      runConfigurations: ProjectRunConfiguration[];
      runConfigurationId?: string | null;
      hostDependenciesChecked?: boolean;
      runtimeProfile: RuntimeProfileId;
    }): Promise<{ runId: string }>;
    collectProjectInitializationDiagnostics(input: {
      worktree: string;
      launchError: string;
    }): Promise<ProjectInitializationDiagnostics>;
    stopProjectSetup(input: {
      workspaceMode?: "local-container" | "cloud-mirror" | "direct";
      worktree: string;
    }): Promise<boolean>;
    removeWorktree(input: {
      projectSetupStopped?: boolean;
      repositoryRoot: string;
      workspaceMode?: "local-container" | "cloud-mirror" | "direct";
      worktree: string;
    }): Promise<boolean>;
    resolveProjectPreviewUrl(input: {
      worktree: string;
    }): Promise<string | null>;
    ensureProjectPreviewUrl(input: {
      executionId: string;
      storyId?: string;
      telemetryCohorts?: ExecutionTelemetryCohorts;
      worktree: string;
    }): Promise<string | null>;
    runtimeStatus(): Promise<RuntimeStatusReport>;
    ensureRuntimeReady(
      onProgress?: (progress: RuntimeProgress) => void,
    ): Promise<HostDependencyReport>;
    repairRuntime(
      onProgress?: (progress: RuntimeProgress) => void,
    ): Promise<HostDependencyReport>;
    resetRuntime(
      onProgress?: (progress: RuntimeProgress) => void,
    ): Promise<HostDependencyReport>;
    projectRuntimeHealthy(input: { worktree: string }): Promise<boolean>;
    projectPreviewRuntimeState(input: {
      workspaceMode?: "local-container" | "cloud-mirror" | "direct";
      worktree: string;
    }): Promise<ProjectPreviewRuntimeState>;
    controlProjectPreview(input: {
      action: "start" | "stop" | "restart";
      configurationId?: string;
      worktree: string;
    }): Promise<ProjectPreviewRuntimeState>;
    applyProjectPreviewInitialization(
      input: ApplyPreviewInitializationInput,
    ): Promise<void>;
    listProjectServices(input: { worktree: string }): Promise<string[]>;
    startProjectServiceLogs(input: {
      service: string;
      worktree: string;
    }): Promise<{ streamId: string }>;
    stopProjectServiceLogs(input: { streamId: string }): Promise<boolean>;
    onProjectServiceLog(
      streamId: string,
      callback: (event: ProjectServiceLogEvent) => void,
    ): () => void;
    onSetupEvent(
      runId: string,
      callback: (event: ProjectSetupEvent) => void,
    ): () => void;
    onProjectCreationEvent(
      runId: string,
      callback: (event: ProjectCreationEvent) => void,
    ): () => void;
  };
  terminal: {
    start(input: { cwd: string }): Promise<{ id: string; cwd: string }>;
    write(input: { id: string; data: string }): Promise<boolean>;
    resize(input: { cols: number; id: string; rows: number }): Promise<boolean>;
    stop(id: string): Promise<boolean>;
    onEvent(id: string, callback: (event: TerminalEvent) => void): () => void;
  };
  agent: {
    providers: {
      list(connection: ApiConnection): Promise<ProviderListResponse>;
      saveCredential(
        connection: ApiConnection,
        input: SaveProviderCredentialInput,
      ): Promise<unknown>;
      deleteCredential(connection: ApiConnection, id: string): Promise<void>;
      loginOAuth(input: LoginOAuthProviderInput): Promise<unknown>;
      claudeCodeStatus(): Promise<ClaudeCodeStatus>;
      connectClaudeCode(input: ConnectClaudeCodeInput): Promise<unknown>;
      subscriptionUsage(
        input: SubscriptionUsageInput,
      ): Promise<SubscriptionUsage | null>;
    };
    sessions: {
      start(input: StartSessionInput): Promise<{ sessionId: string }>;
      startDevelopment(
        input: StartDevelopmentSessionInput,
      ): Promise<{ sessionId: string }>;
      send(input: SendSessionInput): Promise<unknown>;
      sendDevelopment(input: SendDevelopmentSessionInput): Promise<unknown>;
      abort(sessionId: string): Promise<void>;
      // Whether this session is still executing in the desktop app.
      live(sessionId: string): Promise<boolean>;
      compareCheckpoint(
        input: CompareCheckpointInput,
      ): Promise<CompareCheckpointResult>;
      list(): Promise<unknown>;
      messages(sessionId: string): Promise<unknown>;
      restoreCheckpoint(
        input: RestoreCheckpointInput,
      ): Promise<RestoreCheckpointResult>;
      usage(sessionId: string): Promise<AgentUsageSummary | undefined>;
      compact(input: CompactSessionInput): Promise<CompactSessionResult>;
      eventStreamUrl(sessionId: string): Promise<string | null>;
      onEvent(
        sessionId: string,
        callback: (event: AgentEvent) => void,
      ): () => void;
    };
    approvals: {
      resolve(input: ResolveApprovalInput): Promise<boolean>;
      onRequest(callback: (event: AgentEvent) => void): () => void;
    };
    initializations: {
      run(input: InitializeProjectInput): Promise<InitializeProjectResult>;
      repair(
        input: RepairProjectInitializationInput,
      ): Promise<RepairProjectInitializationResult>;
      assessImpact(
        input: AssessProjectInitializationImpactInput,
      ): Promise<AssessProjectInitializationImpactResult>;
    };
    codePractices: {
      run(
        input: AnalyzeProjectCodePracticesInput,
      ): Promise<AnalyzeProjectCodePracticesResult>;
    };
    newProjects: NewProjectsClient;
    promptOptimizer: {
      optimizeUserStory(
        input: OptimizeUserStoryPromptInput,
      ): Promise<OptimizeUserStoryPromptResult>;
      generateTitle(input: GenerateTitleInput): Promise<GenerateTitleResult>;
    };
    planning: {
      reply(input: PlanUserStoriesInput): Promise<PlanUserStoriesResult>;
    };
    approveAndMerge(
      input: ApproveAndMergeInput,
    ): Promise<ApproveAndMergeResult>;
    generateCommitMessage(
      input: GenerateCommitMessageInput,
    ): Promise<GenerateCommitMessageResult>;
    resolveMergeConflicts(
      input: ResolveMergeConflictsInput,
    ): Promise<ResolveMergeConflictsResult>;
  };
};
