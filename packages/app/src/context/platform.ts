import type { CloudAuthRequestClient } from "./platform-cloud-auth"
import * as React from "react"
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
  RunSecurityAuditInput,
  SaveProviderCredentialInput,
  SecurityAudit,
  SendDevelopmentSessionInput,
  SendSessionInput,
  StartDevelopmentSessionInput,
  StartSessionInput,
  ReasoningSelection,
} from "@blame/agent-runtime"
import type { NewProjectConfiguration } from "../components/new-project/new-project-options"
import type { UserStory } from "../components/backlog/data/backlog-data"
import type {
  LiveSyncStatus,
  PreviewLogEvent,
  PreviewSessionCommand,
  PreviewSessionEvent,
  PreviewSessionView,
  RuntimeProfileId,
} from "@blame/preview-runtime"
import type {
  DeploymentManifest,
  DeploymentSnapshot,
  ProjectDeployment,
} from "@blame/deploy-contract"

export type {
  CloudAuthRequestInput,
  CloudAuthRequestResponse,
  CloudAuthRequestClient,
} from "./platform-cloud-auth"

type PickerPaths = string | string[] | null

export type OpenDirectoryPickerOptions = {
  title?: string
  multiple?: boolean
}

export type Platform = {
  billing?: {
    onRefreshLicense(callback: () => void): () => void
    ready(): void
  }
  auth?: {
    onCallback(
      callback: (result: { code?: string; error?: string }) => void
    ): () => void
    request: CloudAuthRequestClient["request"]
    ready(): void
  }
  agent?: AgentClient
  agentScreenshots?: AgentScreenshotsClient
  api?: ApiConnection
  previewDevtools?: PreviewDevtoolsSettingsClient
  appStatus?: AppStatusClient
  appearance?: AppearanceClient
  backlogStatusPip?: BacklogStatusPipClient
  deploy?: DeployClient
  platform?: string
  previewBrowser?: PreviewBrowserClient
  previewRuntime?: PreviewRuntimeClient
  securityAudits?: SecurityAuditClient
  systemNotifications?: SystemNotificationsClient
  terminal?: TerminalClient
  previewTerminal?: import("./platform-preview-surfaces").PreviewTerminalClient
  previewSurfaces?: import("./platform-preview-surfaces").PreviewSurfacesClient
  telemetry?: TelemetryClient
  updates?: DesktopUpdatesClient
  mcp?: McpServersClient
  workspace?: WorkspaceClient
  windowControls?: WindowControlsClient
  // Desktop: one window per open project.
  projectWindows?: ProjectWindowsClient
  // Desktop: the open project's app beyond Blame's own runner.
  projectApp?: ProjectAppClient
  openDirectoryPickerDialog?(
    options?: OpenDirectoryPickerOptions
  ): Promise<PickerPaths>
  requestMicrophoneAccess?(): Promise<boolean>
  // Opens the system's microphone privacy settings (desktop only).
  openMicrophoneSettings?(): Promise<void>
  openExternalLink?(url: string): void
  openPath?(path: string): Promise<string>
  openAttachment?(input: { name: string; content: Uint8Array }): Promise<void>
}

export type DeployProgress = {
  phase: "preparing" | "uploading" | "submitting"
  percent: number
}

export type DeploySourceInput = {
  root: string
  previewManifest: PreviewManifest
  runConfigurations: ProjectRunConfiguration[]
}

export type DeployClient = {
  configure(connection: ApiConnection): Promise<boolean>
  disconnect(): Promise<boolean>
  preflight(input: DeploySourceInput): Promise<{
    manifest: DeploymentManifest
    snapshot: DeploymentSnapshot
    excludedFileCount: number
  }>
  start(
    input: DeploySourceInput & {
      projectId: string
      targetId: string
      operationId: string
      expectedWorkspaceHash: string
    },
    onProgress?: (progress: DeployProgress) => void
  ): Promise<ProjectDeployment>
}

export type TelemetryExportSession = {
  endpoint: string
  expiresAt: string
  token: string
}

export type RuntimeDiagnosticInput = {
  detail: string
  operation: "ensure" | "repair" | "reset"
}

export type RuntimeProgress = {
  completedBytes?: number
  percent?: number
  phase:
    | "checking"
    | "configuring"
    | "downloading"
    | "installing"
    | "starting"
    | "verifying"
  totalBytes?: number
}

// The Blame Runtime (Lima on macOS, WSL on Windows, containerd on Linux)
// that runs local container previews.
export type RuntimeStatusReport = {
  issues: { action?: string; name: string; status: string }[]
  platform: string
  runtime: string
  status: "ready" | "missing" | "repairable" | "unsupported" | "broken"
  // Installed, only out of date: a routine update.
  updateRequired?: boolean
  // Installed VM is stopped and only needs to be started.
  startRequired?: boolean
}

export type TelemetryClient = {
  configure(session: TelemetryExportSession): Promise<boolean>
  disable(): Promise<boolean>
  sendRuntimeDiagnostic?(input: RuntimeDiagnosticInput): Promise<boolean>
}

export type McpTransport = "stdio" | "streamableHttp" | "sse"

export type McpServerConfig = {
  args?: string[]
  command?: string
  cwd?: string
  disabled: boolean
  env?: Record<string, string>
  headers?: Record<string, string>
  name: string
  oauth: {
    configured: boolean
    lastAuthenticatedAt?: number
    lastError?: string
    supported: boolean
  }
  requiresLocalSetup: boolean
  timeout?: number
  transport: McpTransport
  url?: string
}

export type McpServersClient = {
  authorize(name: string): Promise<McpServerConfig[]>
  disconnectOAuth(name: string): Promise<McpServerConfig[]>
  detachCloud(userId: string): Promise<McpServerConfig[]>
  list(): Promise<McpServerConfig[]>
  mergeCloud(
    userId: string,
    servers: CloudMcpServerConfig[],
    adoptLocal?: boolean
  ): Promise<McpServerConfig[]>
  save(
    server: McpServerConfig,
    previousName?: string
  ): Promise<McpServerConfig[]>
  remove(name: string): Promise<McpServerConfig[]>
  setEnabled(name: string, enabled: boolean): Promise<McpServerConfig[]>
}

export type CloudMcpServerConfig = Pick<
  McpServerConfig,
  "command" | "disabled" | "name" | "timeout" | "transport" | "url"
>

export type BacklogStatusPipClient = {
  open(): Promise<boolean>
  onRequest(callback: (request: BacklogStatusPipRequest) => void): () => void
  onSnapshot(callback: (snapshot: BacklogStatusPipSnapshot) => void): () => void
  publish(snapshot: BacklogStatusPipSnapshot): void
  request(input: BacklogStatusPipRequest): Promise<boolean>
  // The window has no system title bar: the page closes and resizes it.
  close?(): void
  setMode?(input: {
    compact: boolean
    contentHeight?: number
  }): Promise<boolean>
}

export type BacklogStatusPipSnapshot = {
  authStatus: "loading" | "authenticated" | "unauthenticated"
  hasActiveProject: boolean
  loading: boolean
  stories: UserStory[]
}

// Where a click on a notification takes the user.
export type NotificationTarget = {
  pathname: string
  storyId?: string
  chatId?: string
  tab?: string
}

export type SystemNotificationInput = {
  body?: string
  title: string
  target?: NotificationTarget
}

export type SystemNotificationsClient = {
  show(input: SystemNotificationInput): Promise<boolean>
  onClick?(callback: (target: NotificationTarget) => void): () => void
}

// The app's presence outside its window: title, dock/taskbar badge and
// attention requests.
export type AppStatusClient = {
  setActivity(input: { running: number }): Promise<void>
  requestAttention(): Promise<void>
}

export type AppTheme = "light" | "dark" | "system"

export type AppearanceClient = {
  setTheme(theme: AppTheme): Promise<void>
}

export type BacklogStatusPipAction =
  | "Send to Dev Agent"
  | "Discard"
  | "Dequeue"
  | "Open Worktree"
  | "Open Preview"
  | "Stop Agent"
  | "Unpause Agent"
  | "View Diff"
  | "View Files"
  | "View Terminal"
  | "Request Changes"
  | "Reject"
  | "Approve & Merge"
  | "Use Context"
  | "Rework"
  | "Delete Permanently"

export type BacklogStatusPipRequest = {
  action?: BacklogStatusPipAction
  drawer?: {
    focusComment?: boolean
    initialDevelopmentTab?: "diff" | "files" | "terminal"
    initialTab?: "user-story" | "development" | "preview"
  }
  rejectChoice?: "request-changes" | "discard"
  stopChoice?: "pause" | "pause-feedback" | "backlog" | "discard-worktree"
  storyId: string
}

// Who listens on a local port: the project's app already running outside
// Blame, another app, or one Blame cannot place.
export type LocalPortOwner =
  | { status: "free" }
  | {
      status: "busy"
      owner: "project" | "other" | "unknown"
      cwd?: string
      pid?: number
      processName?: string
    }

export type ProjectAppRequest = { action: "start" | "status"; id: string }

export type ProjectAppResult = {
  status:
    | "conflict"
    | "failed"
    | "running"
    | "starting"
    | "stopped"
    | "unavailable"
  message: string
  configuration?: string
  logs?: string
  owner?: { kind: "other" | "unknown"; folder?: string; process?: string }
  previewUrl?: string
  runningOutsideBlame?: boolean
}

export type ProjectAppClient = {
  inspectPort(input: {
    port: number
    projectPath: string
  }): Promise<LocalPortOwner>
  // An agent working in the project folder asks about its app.
  onRequest(callback: (request: ProjectAppRequest) => void): () => void
  respond(id: string, result: ProjectAppResult): Promise<boolean>
}

export type ProjectWindowsClient = {
  onMenuAction?(callback: (action: "new" | "open") => void): () => void
  // Brings forward another window that has this project open.
  focusProject(path: string): Promise<boolean>
  openProject(path: string): Promise<"focused" | "opened" | undefined>
  reportProject(path: string | null): void
}

export type WindowControlsClient = {
  close(): void
  isMaximized(): Promise<boolean>
  minimize(): Promise<void>
  onMaximized(callback: (maximized: boolean) => void): () => void
  setPresentation(input: WindowPresentationInput): Promise<boolean>
  toggleMaximize(): Promise<void>
}

export type WindowPresentationInput = {
  pathname: string
  role: "compact" | "workspace"
}

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported"

export type DesktopUpdateChannel = "stable" | "beta"

export type DesktopUpdateStatus = {
  channel: DesktopUpdateChannel
  currentVersion: string
  error?: string
  latestVersion?: string
  phase: DesktopUpdatePhase
  progress?: number
  reason?: string
  releaseDate?: string
  releaseNotes?: string
}

export type DesktopUpdatesClient = {
  check(): Promise<DesktopUpdateStatus>
  download(): Promise<DesktopUpdateStatus>
  getStatus(): Promise<DesktopUpdateStatus>
  install(): Promise<DesktopUpdateStatus>
  onStatus(callback: (status: DesktopUpdateStatus) => void): () => void
  setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateStatus>
}

export type AgentClient = {
  providers: {
    list(connection: ApiConnection): Promise<ProviderListResponse>
    saveCredential(
      connection: ApiConnection,
      input: SaveProviderCredentialInput
    ): Promise<unknown>
    deleteCredential(connection: ApiConnection, id: string): Promise<void>
    loginOAuth(input: LoginOAuthProviderInput): Promise<unknown>
    // Desktop only: Claude Code signs in on the user's computer.
    claudeCodeStatus?(): Promise<ClaudeCodeStatus>
    connectClaudeCode?(input: ConnectClaudeCodeInput): Promise<unknown>
    subscriptionUsage?(
      input: SubscriptionUsageInput
    ): Promise<SubscriptionUsage | null>
  }
  sessions: {
    start(input: StartSessionInput): Promise<{ sessionId: string }>
    startDevelopment(
      input: StartDevelopmentSessionInput
    ): Promise<{ sessionId: string }>
    send(input: SendSessionInput): Promise<unknown>
    sendDevelopment(input: SendDevelopmentSessionInput): Promise<unknown>
    abort(sessionId: string): Promise<void>
    // Whether this session is still executing in the desktop app.
    live?(sessionId: string): Promise<boolean>
    compareCheckpoint(
      input: CompareCheckpointInput
    ): Promise<CompareCheckpointResult>
    list(): Promise<unknown>
    messages(sessionId: string): Promise<unknown>
    restoreCheckpoint(
      input: RestoreCheckpointInput
    ): Promise<RestoreCheckpointResult>
    usage(sessionId: string): Promise<AgentUsageSummary | undefined>
    // Cline's manual compaction of an idle session, used on its next resume.
    compact?(input: CompactSessionInput): Promise<CompactSessionResult>
    eventStreamUrl?(sessionId: string): Promise<string | null>
    onEvent(
      sessionId: string,
      callback: (event: AgentEvent) => void
    ): () => void
  }
  approvals: {
    resolve(input: ResolveApprovalInput): Promise<boolean>
    onRequest(callback: (event: AgentEvent) => void): () => void
  }
  initializations: {
    run(input: InitializeProjectInput): Promise<InitializeProjectResult>
    repair(
      input: RepairProjectInitializationInput
    ): Promise<RepairProjectInitializationResult>
    assessImpact(
      input: AssessProjectInitializationImpactInput
    ): Promise<AssessProjectInitializationImpactResult>
  }
  codePractices: {
    run(
      input: AnalyzeProjectCodePracticesInput
    ): Promise<AnalyzeProjectCodePracticesResult>
  }
  newProjects: NewProjectsClient
  promptOptimizer: {
    optimizeUserStory(
      input: OptimizeUserStoryPromptInput
    ): Promise<OptimizeUserStoryPromptResult>
    generateTitle(input: GenerateTitleInput): Promise<GenerateTitleResult>
  }
  planning?: {
    reply(input: PlanUserStoriesInput): Promise<PlanUserStoriesResult>
  }
  approveAndMerge(input: ApproveAndMergeInput): Promise<ApproveAndMergeResult>
  generateCommitMessage(
    input: GenerateCommitMessageInput
  ): Promise<GenerateCommitMessageResult>
  resolveMergeConflicts(
    input: ResolveMergeConflictsInput
  ): Promise<ResolveMergeConflictsResult>
}

export type SecurityAuditClient = {
  active(input: { root: string }): Promise<SecurityAudit | undefined>
  run(input: RunSecurityAuditInput): Promise<SecurityAudit>
  cancel(input: {
    root: string
    auditId: string
  }): Promise<SecurityAudit | undefined>
  onChanged(
    callback: (event: { root: string; audit: SecurityAudit }) => void
  ): () => void
}

export type WorkspaceEntry = {
  name: string
  path: string
  type: "directory" | "file"
}

export type WorktreeResult = {
  worktree: string
  branch: string
  workspaceMode: "local-container" | "cloud-mirror" | "direct"
}

export type GitBranchStatus = {
  ahead: number
  behind: number
  current: string
  detached: boolean
  upstream?: string
}

export type GitStatusFile = {
  conflicted?: boolean
  indexStatus: string
  originalPath?: string
  path: string
  staged: boolean
  status: string
  untracked: boolean
  unstaged: boolean
  worktreeStatus: string
}

export type GitStatusResult = {
  branch: GitBranchStatus
  files: GitStatusFile[]
  remote?: string
}

export type GitLogCommitRef = {
  name: string
  type: "branch" | "head" | "remote" | "tag" | "other"
}

export type GitLogCommit = {
  authorEmail: string
  authorName: string
  date: string
  hash: string
  message: string
  parents: string[]
  refs: GitLogCommitRef[]
}

export type GitCommandResult = {
  output: string
}

export type GitConflictFile = {
  base: string
  current: string
  incoming: string
  path: string
  result: string
}

export type ProjectSetupEvent = {
  runId: string
  type: "stdout" | "stderr" | "exit"
  data: string
}

export type ProjectCreationEvent = {
  type: "stdout" | "stderr" | "exit"
  data: string
}

export type ProjectServiceLogEvent = {
  streamId: string
  type: "stdout" | "stderr" | "exit"
  data: string
}

export type HostDependencyIssue = {
  action: string
  message: string
  name:
    | "git"
    | "blame-runtime"
    | "cline-sdk"
    | "docker"
    | "docker-compose"
    | "node"
    | "corepack"
    | "npm"
    | "pnpm"
    | "yarn"
    | "bun"
    | "pip"
  status: "missing" | "unavailable" | "unsupported"
}

export type HostDependencyReport = {
  issues: HostDependencyIssue[]
  ok: boolean
}

export type PreviewBrowserBounds = {
  height: number
  width: number
  x: number
  y: number
}

export type PreviewBrowserState = {
  error?: string
  id: string
  loading: boolean
  url?: string
}

export type AgentScreenshotMetadata = {
  byteLength: number
  colorScheme: "dark" | "light"
  createdAt: string
  height: number
  id: string
  mimeType: string
  pageUrl: string
  runId?: string
  scope: string
  sessionId?: string
  toolCallId?: string
  viewport: { height: number; width: number }
  width: number
}

export type AgentScreenshotData = {
  dataUrl: string
  metadata: AgentScreenshotMetadata
}

// Screenshots the agent took, stored by the desktop app outside the
// worktree. Copies fetched from the account are cached with `cache`.
export type AgentScreenshotsClient = {
  read(input: {
    id: string
    scopes?: string[]
  }): Promise<AgentScreenshotData | null>
  list(input: {
    runId?: string
    scope?: string
    sessionId?: string
  }): Promise<AgentScreenshotMetadata[]>
  cache(input: {
    dataUrl: string
    id: string
    metadata: Partial<AgentScreenshotMetadata> & { scope: string }
  }): Promise<AgentScreenshotMetadata>
  delete(input: { scope?: string; sessionIds?: string[] }): Promise<boolean>
  // Copies the image to the clipboard, or saves it where the user picks.
  copy(input: { id: string }): Promise<boolean>
  saveAs(input: { id: string }): Promise<boolean>
}

// Per-project settings of the agent's browser tools.
export type PreviewDevtoolsSettingsClient = {
  getAdvancedDiagnostics(input: { projectId: string }): Promise<boolean>
  setAdvancedDiagnostics(input: {
    enabled: boolean
    projectId: string
  }): Promise<boolean>
}

export type PreviewBrowserClient = {
  capture(input: {
    id: string
    size?: "full" | "thumbnail"
  }): Promise<string | null>
  create(input: {
    storageKey: string
    device?: "phone" | "tablet"
    previewSessionId?: string
    previewWorktree?: string
  }): Promise<{ id: string }>
  destroy(input: { id: string }): Promise<boolean>
  load(input: { id: string; url: string }): Promise<boolean>
  onState(
    input: { id: string },
    callback: (state: PreviewBrowserState) => void
  ): () => void
  reload(input: { id: string }): Promise<boolean>
  setDevtoolsScope(input: {
    id: string
    scope?: string | null
  }): Promise<boolean>
  setBounds(input: {
    bounds: PreviewBrowserBounds
    id: string
    visible: boolean
  }): Promise<boolean>
}

export type PreviewRuntimeClient = {
  configure(connection: ApiConnection): Promise<boolean>
  disconnect(): Promise<boolean>
  create(input: {
    userStoryId: string
    profile: "vercel-compose"
    previewManifest: PreviewManifest
    cloudUploadConsentAt: string
    operationId: string
    localPath: string
    sourceRevision?: string
    resourceSize?: { vcpus: number; memoryGb: number }
  }): Promise<PreviewSessionView>
  get(input: { sessionId: string }): Promise<PreviewSessionView>
  findForUserStory(input: {
    userStoryId: string
    profile: "vercel-compose"
  }): Promise<{ session: PreviewSessionView | null }>
  openExternal(input: { sessionId: string; routeId?: string }): Promise<boolean>
  command(input: {
    sessionId: string
    command: PreviewSessionCommand
    operationId: string
  }): Promise<PreviewSessionView>
  syncIn(input: { sessionId: string; localPath: string }): Promise<{
    session: PreviewSessionView
    sourceRevision: string
    workspaceHash: string
  }>
  syncOut(input: { sessionId: string; localPath?: string }): Promise<{
    session: PreviewSessionView
    revision: string
    finalHash: string
  }>
  syncStatus?(input: { sessionId: string }): Promise<LiveSyncStatus | null>
  onEvent(
    input: { sessionId: string; cursor?: string },
    callback: (event: PreviewSessionEvent) => void,
    onError?: (message: string) => void
  ): () => void
  onLog(
    input: { sessionId: string; cursor?: string },
    callback: (event: PreviewLogEvent) => void,
    onError?: (message: string) => void
  ): () => void
}

export type WorkspaceClient = {
  pathExists(input: { path: string }): Promise<boolean>
  listDirectory(input: {
    root: string
    path?: string
  }): Promise<WorkspaceEntry[]>
  readFile(input: { root: string; path: string }): Promise<string>
  searchFiles(input: {
    root: string
    query: string
    limit?: number
  }): Promise<WorkspaceEntry[]>
  gitDiff(input: { root: string }): Promise<string>
  gitDiffStats?(input: {
    from?: string
    root: string
    to?: string
  }): Promise<{ additions: number; deletions: number; files: number }>
  gitDiffBetween(input: {
    from: string
    root: string
    to: string
  }): Promise<string>
  gitDiffFrom(input: { from: string; root: string }): Promise<string>
  gitSnapshot(input: { id: string; root: string }): Promise<string>
  gitStatus(input: { root: string }): Promise<GitStatusResult>
  gitCommitCount?(input: { root: string }): Promise<number>
  gitLog(input: {
    currentBranchOnly?: boolean
    root: string
    limit?: number
    skip?: number
  }): Promise<GitLogCommit[]>
  gitFileDiff(input: {
    root: string
    path: string
    staged?: boolean
  }): Promise<string>
  gitCommitDiff(input: { root: string; hash: string }): Promise<string>
  gitConflictFile(input: {
    root: string
    path: string
  }): Promise<GitConflictFile>
  gitAcceptConflictFile(input: {
    root: string
    path: string
    side: "current" | "incoming"
  }): Promise<boolean>
  gitResolveConflictFile(input: {
    root: string
    path: string
    content?: string
  }): Promise<boolean>
  gitAbortConflict(input: { root: string }): Promise<GitCommandResult>
  gitContinueConflict(input: { root: string }): Promise<GitCommandResult>
  gitStageFiles(input: { root: string; paths: string[] }): Promise<boolean>
  gitUnstageFiles(input: { root: string; paths: string[] }): Promise<boolean>
  gitRollbackFiles(input: { root: string; paths: string[] }): Promise<boolean>
  gitDeleteFiles(input: { root: string; paths: string[] }): Promise<boolean>
  gitCommit(input: { root: string; message: string }): Promise<GitCommandResult>
  gitPush(input: { root: string }): Promise<GitCommandResult>
  listGitDirectory(input: {
    path?: string
    refs: string[]
    root: string
  }): Promise<WorkspaceEntry[]>
  readGitFile(input: {
    path: string
    refs: string[]
    root: string
  }): Promise<string>
  gitRepositoryFingerprint(input: { root: string }): Promise<string | null>
  ensureGitRepository(input: { root: string }): Promise<boolean>
  createProject(input: {
    apiConnection: ApiConnection
    configuration: NewProjectConfiguration
    credentialLabel?: string
    modelId: string
    parentPath: string
    projectName: string
    providerId: string
    reasoningEffort?: ReasoningSelection
    runId: string
  }): Promise<{
    path: string
  }>
  createWorktree(input: {
    // Run in the project folder instead of a new worktree.
    direct?: boolean
    executionId: string
    repositoryRoot: string
    runtimeProfile: RuntimeProfileId
    storyId: string
    storyReference: string
    telemetryCohorts?: ExecutionTelemetryCohorts
    title: string
  }): Promise<WorktreeResult>
  checkHostDependencies(input: {
    // Skip runtime checks when already handled by the runtime gate.
    includeRuntime?: boolean
    runtimeProfile?: RuntimeProfileId
    workspaceMode?: "local-container" | "cloud-mirror" | "direct"
    setupScript?: string
    worktree?: string
  }): Promise<HostDependencyReport>
  prepareProjectPreview(input: {
    executionId: string
    storyId: string
    telemetryCohorts?: ExecutionTelemetryCohorts
    worktree: string
    previewManifest: PreviewManifest
    runConfigurations: ProjectRunConfiguration[]
    runConfigurationId?: string | null
    hostDependenciesChecked?: boolean
    runtimeProfile: RuntimeProfileId
  }): Promise<{ prepared: true }>
  runProjectSetup(input: {
    executionId: string
    storyId: string
    telemetryCohorts?: ExecutionTelemetryCohorts
    worktree: string
    previewManifest: PreviewManifest
    runConfigurations: ProjectRunConfiguration[]
    runConfigurationId?: string | null
    hostDependenciesChecked?: boolean
    runtimeProfile: RuntimeProfileId
  }): Promise<{ runId: string }>
  collectProjectInitializationDiagnostics(input: {
    worktree: string
    launchError: string
  }): Promise<ProjectInitializationDiagnostics>
  stopProjectSetup(input: {
    workspaceMode?: "local-container" | "cloud-mirror" | "direct"
    worktree: string
  }): Promise<boolean>
  removeWorktree(input: {
    projectSetupStopped?: boolean
    repositoryRoot: string
    workspaceMode?: "local-container" | "cloud-mirror" | "direct"
    worktree: string
  }): Promise<boolean>
  resolveProjectPreviewUrl(input: { worktree: string }): Promise<string | null>
  ensureProjectPreviewUrl(input: {
    executionId: string
    storyId?: string
    telemetryCohorts?: ExecutionTelemetryCohorts
    workspaceMode?: "local-container" | "cloud-mirror" | "direct"
    worktree: string
  }): Promise<string | null>
  projectRuntimeHealthy?(input: { worktree: string }): Promise<boolean>
  projectPreviewRuntimeState?(input: {
    workspaceMode?: "local-container" | "cloud-mirror" | "direct"
    worktree: string
  }): Promise<ProjectPreviewRuntimeState>
  controlProjectPreview?(input: {
    action: "start" | "stop" | "restart"
    configurationId?: string
    worktree: string
  }): Promise<ProjectPreviewRuntimeState>
  applyProjectPreviewInitialization?(
    input: ApplyPreviewInitializationInput
  ): Promise<void>
  runtimeStatus?(): Promise<RuntimeStatusReport>
  ensureRuntimeReady?(
    onProgress?: (progress: RuntimeProgress) => void
  ): Promise<unknown>
  repairRuntime?(
    onProgress?: (progress: RuntimeProgress) => void
  ): Promise<unknown>
  resetRuntime?(
    onProgress?: (progress: RuntimeProgress) => void
  ): Promise<unknown>
  listProjectServices?(input: { worktree: string }): Promise<string[]>
  startProjectServiceLogs?(input: {
    service: string
    worktree: string
  }): Promise<{ streamId: string }>
  stopProjectServiceLogs?(input: { streamId: string }): Promise<boolean>
  onProjectServiceLog?(
    streamId: string,
    callback: (event: ProjectServiceLogEvent) => void
  ): () => void
  onSetupEvent(
    runId: string,
    callback: (event: ProjectSetupEvent) => void
  ): () => void
  onProjectCreationEvent?(
    runId: string,
    callback: (event: ProjectCreationEvent) => void
  ): () => void
}

export type TerminalEvent = {
  id: string
  type: "stdout" | "stderr" | "exit"
  data: string
}

export type TerminalClient = {
  start(input: { cwd: string }): Promise<{ id: string; cwd: string }>
  write(input: { id: string; data: string }): Promise<boolean>
  resize(input: { cols: number; id: string; rows: number }): Promise<boolean>
  stop(id: string): Promise<boolean>
  onEvent(id: string, callback: (event: TerminalEvent) => void): () => void
}

export const PlatformContext = React.createContext<Platform>({})

export function usePlatform() {
  return React.useContext(PlatformContext)
}

export function createWebPlatform(): Platform {
  return {
    async openDirectoryPickerDialog(options) {
      const value = window.prompt(options?.title ?? "Open Project")
      return value?.trim() || null
    },
    openExternalLink(url) {
      window.open(url, "_blank", "noopener,noreferrer")
    },
  }
}
