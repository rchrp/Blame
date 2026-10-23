import {
  commandWithNextWebpackFallback,
  generatePreviewArtifacts,
  parsePreviewManifest,
  parseRunConfigurations,
  manifestWithProjectPackageManager,
  projectPackageManager,
  type ApplyPreviewInitializationInput,
  type ExecutionTelemetryCohorts,
  type ProjectPreviewRuntimeState,
  type ProjectRunConfiguration,
} from "@blame/agent-runtime";
import {
  type PreviewManifest,
  type PreviewManifestService,
} from "@blame/preview-contract";
import {
  activeProbes,
  compilePreviewManifest,
  probeEndpoint,
  probeFailureMessage,
  probeStatusAccepted,
  serviceProbeCommand,
  type PreviewExecutionPlan,
  type ProbePlan,
  type RuntimeProfileId,
  type ServiceEndpointPlan,
} from "@blame/preview-runtime";
import {
  ATTR_BLAME_AGENT_ROLE,
  ATTR_BLAME_AGENT_STRATEGY,
  ATTR_BLAME_EXECUTION_ID,
  ATTR_BLAME_EXECUTION_KIND,
  ATTR_BLAME_EXECUTION_STATUS,
  ATTR_BLAME_MULTI_AGENT_ENABLED,
  ATTR_BLAME_MULTI_AGENT_USED,
  ATTR_BLAME_OPERATION_NAME,
  ATTR_BLAME_REPOSITORY_LANGUAGE,
  ATTR_BLAME_REPOSITORY_SIZE_BUCKET,
  ATTR_BLAME_STORY_ID,
  ATTR_BLAME_TASK_COMPLEXITY_BUCKET,
  ATTR_BLAME_WORKTREE_ID,
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  boundedMetricDimensionName,
  errorAttributes,
  getBlameTelemetry,
  getExecutionRegistry,
  opaqueIdentifier,
  semanticGenAiProviderName,
  withoutTelemetryEnvironment,
  type BlameSpan,
  type ExecutionComponent,
  type ExecutionDescriptor,
  type TelemetryOutcome,
} from "@blame/telemetry";
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, posix, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  generateNewProjectWithAgent,
  releaseAgentWorkspaceSessions,
} from "./agent-ipc";
import {
  optimizeAttachmentForAiContext,
  type OptimizeAttachmentForAiContextInput,
} from "./attachment-ai-context";
import {
  containerRuntimeEnvironment,
  createContainerRuntime,
} from "./container-runtime";
import {
  assertHostDependencies,
  checkHostDependencies,
} from "./host-dependencies";
import { setupPath } from "./host-tool-path";
import { isProjectFolder } from "./worktree-safety";
import type { DesktopBridgeGrant } from "./preview-browser/preview-bridge-grant";
import {
  composeRuntimeServiceClosure,
  composeServiceHealthcheckCommand,
  composeSetupTaskEnvironment,
  previewComposePlan,
  type PreviewComposeConfig as ComposeConfig,
  type PreviewComposeService as ComposeService,
} from "./preview-compose-plan";
import {
  previewComposeEnvOverrides,
  validatePreviewComposeBindings,
} from "./preview-compose-validation";
import {
  containerMatchesWorktree,
  previewComposeProjectName,
  previewContainerFailure,
  previewFailureLogExcerpt,
} from "./preview-readiness";
import { PreviewRecoveryCircuit } from "./preview-recovery-circuit";
import { composeWithRememberedHostPorts } from "./preview-port-memory.ts";
import { stalePreviewSetupReason } from "./preview-setup-preflight.ts";
import {
  initialPreviewRuntimeSelection,
  previewRunConfigurationServiceIds,
  previewRunConfigurationStatus,
  selectedPreviewRunConfiguration,
  selectedPreviewRuntimeServiceIds,
  shouldStartBrowserPreview,
  type PreviewRuntimeSelectionState,
} from "./preview-run-state";
import {
  idleLocalPreviewLifecycle,
  localPreviewLifecycle,
  localPreviewStartStep,
  parseLocalPreviewRuntimeSelectionState,
  pendingLocalPreviewLifecycle,
  runLocalPreviewOperation,
} from "./preview-runtime/local/local-preview-lifecycle.js";
import { LocalPreviewService } from "./preview-runtime/local/local-preview-service";
import {
  createProject,
  setNewProjectAgentRuntime,
  setProjectCreationWindowsProvider,
  type CreateProjectInput,
} from "./project-creation";
import {
  collectProjectInitializationDiagnostics,
  type CollectProjectInitializationDiagnosticsInput,
} from "./project-initialization-diagnostics";
import {
  detectedStackUsesNext,
  packageJsonUsesNext,
} from "./project-stack-detection";
import {
  repositoryTelemetryCohorts,
  type RepositoryTelemetryCohorts,
} from "./repository-telemetry-cohorts";
import {
  ensureRuntimeReady,
  getRuntimeStatus,
  repairRuntime,
  resetRuntime,
  uninstallRuntime,
  type RuntimeProgress,
} from "./runtime-manager";
import {
  composeWithCurrentDependencyVolumes,
  composeWithNonMutatingNpmInstalls,
  composeWithoutNumericSuUser,
  composeWithRuntimePortPlaceholders,
  dockerComposeForPreview,
  dockerComposeWithHostFileMounts,
  dockerComposeWithPortableWindowsPaths,
} from "./workspace-compose";
import { dependencyVolumeHashFromInputs } from "./workspace-compose-volumes";
import {
  cleanupAbandonedBlamePreviews,
  removeBlamePreviewProjectResources,
  runtimeAddressPoolExhausted,
} from "./workspace-docker-cleanup";
import {
  envHostFileMounts,
  materializedPreviewEnvFilesMatch,
  materializedPreviewEnvHostFileMounts,
  syncProjectEnvFiles,
} from "./workspace-env";
import {
  ensureGitRepository,
  gitDiffBetween,
  gitDiffFrom,
  gitSnapshot,
  isGitRepository,
  listGitDirectory,
  readGitFile,
  storyWorktreeAddArguments,
  storyWorktreeRemoveArguments,
  type GitDiffFromInput,
  type GitDiffInput,
  type GitDirectoryInput,
  type GitFileInput,
  type GitSnapshotInput,
} from "./workspace-git";
import {
  workspaceExecution,
  workspaceMode,
  type WorkspaceMode,
} from "./workspace-mode.ts";
import {
  appendFile as appendRuntimeFile,
  chmod as chmodRuntime,
  dirnameWorkspacePath,
  findProjectFilesByName,
  joinWorkspacePath,
  mkdir as mkdirRuntime,
  readExistingFiles as readExistingRuntimeFiles,
  readDirectory as readRuntimeDirectory,
  readFile as readRuntimeFile,
  resetRuntimeGitIdentityConfigured,
  resolveWorkspacePath as resolveRuntimePath,
  rm as rmRuntime,
  run as runRuntime,
  runtimeManagedPath,
  pathExists as runtimePathExists,
  spawnRuntime,
  storyBranch,
  worktreePath,
  writeFile as writeRuntimeFile,
  writeFileAtomic as writeRuntimeFileAtomic,
} from "./workspace-runtime";
import {
  hasMissingWorkspaceNodeModules,
  sanitizeWorkspaceConfigFiles,
} from "./workspace-config-sanitizer";
import {
  branchExists,
  ensureRuntimeGitSafeDirectory,
  runRuntimeGit,
  worktreeRegistered,
} from "./workspace-runtime-git.ts";
import {
  startWorkspaceStep,
  traceWorkspaceStep,
} from "./workspace-step-telemetry";
import {
  commandText,
  gitAbortConflict,
  gitAcceptConflictFile,
  gitCommit,
  gitCommitCount,
  gitCommitDiff,
  gitConflictFile,
  gitContinueConflict,
  gitDeleteFiles,
  gitDiff,
  gitDiffStats,
  gitFileDiff,
  gitLog,
  gitPush,
  gitRepositoryFingerprint,
  gitResolveConflictFile,
  gitRollbackFiles,
  gitStageFiles,
  gitStatus,
  gitUnstageFiles,
  type GitAcceptConflictFileInput,
  type GitCommitDiffInput,
  type GitCommitInput,
  type GitConflictFileInput,
  type GitFilesInput,
  type GitLogInput,
  type GitPathInput,
  type GitResolveConflictFileInput,
} from "./workspaces/workspace-git-service";

const previewStartupIntervalMs = 1_000;
const previewDiscoveryGraceMs = 15_000;
const previewResponseTimeoutMs = 120_000;
const previewRequestTimeoutMs = 5_000;
const previewStopTimeoutSeconds = 3;
const containerMetadataTimeoutMs = 15_000;
const composeStartTimeoutMs = 10 * 60_000;
const composeSetupTimeoutMs = 15 * 60_000;
const setupDependencyReadinessTimeoutMs = 90_000;
const repositoryLanguageCohorts = new Set([
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "go",
  "html",
  "java",
  "javascript",
  "kotlin",
  "mixed",
  "other",
  "php",
  "python",
  "ruby",
  "rust",
  "shell",
  "swift",
  "typescript",
  "vue",
]);
const repositorySizeCohorts = new Set([
  "small",
  "medium",
  "large",
  "very_large",
]);
const taskComplexityCohorts = new Set(["small", "medium", "large"]);
const repositoryTelemetryCache = new Map<
  string,
  Promise<RepositoryTelemetryCohorts | undefined>
>();
const forceKillDelayMs = 1_500;
const previewResolveTimeoutMs = 45_000;
const composeUpRetryDelaysMs = [2_000, 5_000, 10_000, 15_000];
const setupEnvironmentCacheTtlMs = 2_000;
const worktreeSetupOperationName = "blame.worktree.setup";
const previewPrepareOperationName = "blame.preview.prepare";
const projectSetupOperationName = "blame.project.setup";
const previewStartOperationName = "blame.preview.start";
const composeCallPromises = new Map<string, Promise<unknown>>();
const globalPreviewVolumes = [
  "blame_bun_cache",
  "blame_corepack_cache",
  "blame_npm_cache",
  "blame_package_store",
  "blame_pnpm_cache",
  "blame_pnpm_store",
  "blame_yarn_cache",
];

type WorkspacePathInput = {
  root: string;
  path?: string;
};

type WorkspaceSearchInput = WorkspacePathInput & {
  query: string;
  limit?: number;
};

type ExecutionContextInput = {
  executionId: string;
  storyId?: string;
  telemetryCohorts?: ExecutionTelemetryCohorts;
};

type CreateWorktreeInput = ExecutionContextInput & {
  // Run in the project folder instead of a new worktree.
  direct?: boolean;
  repositoryRoot: string;
  runtimeProfile: RuntimeProfileId;
  storyId: string;
  storyReference: string;
  title: string;
};

type RunProjectSetupInput = ExecutionContextInput & {
  storyId: string;
  worktree: string;
  previewManifest: PreviewManifest;
  runConfigurations: ProjectRunConfiguration[];
  runConfigurationId?: string | null;
  hostDependenciesChecked?: boolean;
  runtimeProfile: RuntimeProfileId;
};

type PrepareProjectPreviewInput = RunProjectSetupInput;

type ApplyProjectPreviewInitializationInput = ApplyPreviewInitializationInput;

type CheckHostDependenciesInput = {
  includeRuntime?: boolean;
  runtimeProfile?: RuntimeProfileId;
  setupScript?: string;
  worktree?: string;
};

type RuntimeOperationInput = {
  operationId?: string;
};

type StopProjectSetupInput = {
  workspaceMode?: WorkspaceMode;
  worktree: string;
};

type ProjectServiceLogsInput = {
  service: string;
  worktree: string;
};

type RemoveWorktreeInput = {
  projectSetupStopped?: boolean;
  repositoryRoot: string;
  workspaceMode?: WorkspaceMode;
  worktree: string;
};

type ResolveProjectPreviewUrlInput = {
  worktree: string;
};

type EnsureProjectPreviewUrlInput = ExecutionContextInput &
  ResolveProjectPreviewUrlInput & {
    workspaceMode?: WorkspaceMode;
  };

type RuntimeContainer = {
  Config?: {
    Env?: string[];
    Labels?: Record<string, string>;
  };
  Id?: string;
  NetworkSettings?: {
    Ports?: Record<
      string,
      Array<{ HostIp?: string; HostPort?: string }> | null
    >;
  };
  Name?: string;
  State?: {
    ExitCode?: number;
    Health?: {
      Status?: string;
    };
    Status?: string;
  };
};

type SetupRun = {
  id: string;
  process: ChildProcessWithoutNullStreams;
  processSpan: BlameSpan;
  startedAt: number;
  startLocalPreview: boolean;
  telemetry: ExecutionOperation;
  worktree: string;
};

type ExecutionOperation = {
  component: ExecutionComponent;
  descriptor: ExecutionDescriptor;
  finished: boolean;
  operationName: string;
};

type ProjectSetupFiles = {
  composePath: string;
  directory: string;
  dockerCompose: string;
  manifest: PreviewManifest;
  manifestPath: string;
  runConfigurations: ProjectRunConfiguration[];
  runConfigurationsPath: string;
  runtimeState: PreviewRuntimeSelectionState;
  runtimeStatePath: string;
  scriptPath: string;
  setupScript: string;
  symlinkEnvMounts: Awaited<ReturnType<typeof envHostFileMounts>>;
  worktree: string;
};

type ControlProjectPreviewInput = {
  action: "start" | "stop" | "restart";
  configurationId?: string;
  worktree: string;
};

type PreviewControlSelection = {
  current?: ProjectRunConfiguration;
  selected: ProjectRunConfiguration;
  worktree: string;
};

type WorktreeCreationContext = {
  branch: string;
  mode: WorkspaceMode;
  repositoryRoot: string;
  startedAt: number;
  timings: Array<{ duration: number; label: string }>;
  worktree: string;
};

type ProjectLogStream = {
  process?: ChildProcessWithoutNullStreams;
  retry?: NodeJS.Timeout;
  stopped: boolean;
};

type ProjectServiceLogStream = {
  hasOutput: boolean;
  process?: ChildProcessWithoutNullStreams;
  retry?: NodeJS.Timeout;
  service: string;
  stopped: boolean;
  worktree: string;
};

type SetupEnvironment = NodeJS.ProcessEnv & {
  COMPOSE_PROJECT_NAME: string;
};

type PreviewRuntimeErrorCode =
  | "preview_container_missing"
  | "preview_container_stopped"
  | "preview_dependency_timeout"
  | "preview_manifest_invalid"
  | "preview_probe_failed"
  | "preview_probe_unsupported"
  | "preview_response_timeout"
  | "preview_setup_stale"
  | "preview_url_timeout";

class PreviewRuntimeError extends Error {
  constructor(
    readonly code: PreviewRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewRuntimeError";
  }
}

const setupRuns = new Map<string, SetupRun>();
const projectLogStreams = new Map<string, ProjectLogStream>();
const projectServiceLogStreams = new Map<string, ProjectServiceLogStream>();
const previewRecoveries = new Map<string, Promise<string | null>>();
const previewRecoveryCircuit = new PreviewRecoveryCircuit();
const setupEnvironmentCache = new Map<
  string,
  { env?: SetupEnvironment; promise?: Promise<SetupEnvironment>; ts: number }
>();
const removingWorktrees = new Set<string>();
const removedWorktrees = new Set<string>();
const workspaceProcesses = new Set<ChildProcessWithoutNullStreams>();
const containerRuntime = createContainerRuntime();
const localPreviewService = new LocalPreviewService();
function runtimeProgressReporter(
  event: IpcMainInvokeEvent,
  operationId?: string,
) {
  if (!operationId || !/^[a-f0-9-]{36}$/.test(operationId)) return undefined;
  const channel = `workspace:runtime-progress:${operationId}`;
  return (progress: RuntimeProgress) => {
    if (event.sender.isDestroyed()) return;
    try {
      event.sender.send(channel, progress);
    } catch {
      return;
    }
  };
}

function registerRuntimeOperationHandler(
  channel: string,
  operation: typeof ensureRuntimeReady,
  onRuntimeReady?: () => void,
) {
  ipcMain.handle(channel, async (event, input: RuntimeOperationInput = {}) => {
    resetRuntimeGitIdentityConfigured();
    const report = await operation({
      env: runtimeManagerEnvironment(),
      onProgress: runtimeProgressReporter(event, input.operationId),
    });
    if (report.status === "ready") onRuntimeReady?.();
    return report;
  });
}

export function registerWorkspaceIpcHandlers(
  input: {
    beforeGitWrite?(worktree: string): Promise<void>;
    onRuntimeReady?(): void;
  } = {},
) {
  setProjectCreationWindowsProvider(() => BrowserWindow.getAllWindows());
  setNewProjectAgentRuntime({ generate: generateNewProjectWithAgent });
  ipcMain.handle("workspace:path-exists", (_event, input: { path: string }) =>
    pathExists(input.path),
  );
  ipcMain.handle(
    "workspace:optimize-attachment-for-ai-context",
    (_event, input: OptimizeAttachmentForAiContextInput) =>
      optimizeAttachmentForAiContext(input),
  );
  ipcMain.handle(
    "workspace:list-directory",
    (_event, input: WorkspacePathInput) => listDirectory(input),
  );
  ipcMain.handle("workspace:read-file", (_event, input: WorkspacePathInput) =>
    readWorkspaceFile(input),
  );
  ipcMain.handle(
    "workspace:search-files",
    (_event, input: WorkspaceSearchInput) => searchFiles(input),
  );
  ipcMain.handle("workspace:git-diff", (_event, input: { root: string }) =>
    gitDiff(input.root),
  );
  ipcMain.handle(
    "workspace:git-diff-stats",
    (_event, input: { from?: string; root: string; to?: string }) =>
      gitDiffStats(input),
  );
  ipcMain.handle("workspace:git-diff-between", (_event, input: GitDiffInput) =>
    gitDiffBetween(input),
  );
  ipcMain.handle("workspace:git-diff-from", (_event, input: GitDiffFromInput) =>
    gitDiffFrom(input),
  );
  ipcMain.handle("workspace:git-snapshot", (_event, input: GitSnapshotInput) =>
    gitSnapshot(input),
  );
  ipcMain.handle("workspace:git-status", (_event, input: { root: string }) =>
    gitStatus(input.root),
  );
  ipcMain.handle(
    "workspace:git-commit-count",
    (_event, input: { root: string }) => gitCommitCount(input.root),
  );
  ipcMain.handle("workspace:git-log", (_event, input: GitLogInput) =>
    gitLog(input),
  );
  ipcMain.handle("workspace:git-file-diff", (_event, input: GitPathInput) =>
    gitFileDiff(input),
  );
  ipcMain.handle(
    "workspace:git-commit-diff",
    (_event, input: GitCommitDiffInput) => gitCommitDiff(input),
  );
  ipcMain.handle(
    "workspace:git-conflict-file",
    (_event, input: GitConflictFileInput) => gitConflictFile(input),
  );
  ipcMain.handle(
    "workspace:git-accept-conflict-file",
    (_event, input: GitAcceptConflictFileInput) => gitAcceptConflictFile(input),
  );
  ipcMain.handle(
    "workspace:git-resolve-conflict-file",
    (_event, input: GitResolveConflictFileInput) =>
      gitResolveConflictFile(input),
  );
  ipcMain.handle(
    "workspace:git-abort-conflict",
    (_event, input: { root: string }) => gitAbortConflict(input.root),
  );
  ipcMain.handle(
    "workspace:git-continue-conflict",
    (_event, input: { root: string }) => gitContinueConflict(input.root),
  );
  ipcMain.handle("workspace:git-stage-files", (_event, input: GitFilesInput) =>
    gitStageFiles(input),
  );
  ipcMain.handle(
    "workspace:git-unstage-files",
    (_event, input: GitFilesInput) => gitUnstageFiles(input),
  );
  ipcMain.handle(
    "workspace:git-rollback-files",
    (_event, input: GitFilesInput) => gitRollbackFiles(input),
  );
  ipcMain.handle("workspace:git-delete-files", (_event, input: GitFilesInput) =>
    gitDeleteFiles(input),
  );
  ipcMain.handle("workspace:git-commit", (_event, value: GitCommitInput) =>
    Promise.resolve(input.beforeGitWrite?.(value.root)).then(() =>
      gitCommit(value),
    ),
  );
  ipcMain.handle("workspace:git-push", (_event, value: { root: string }) =>
    Promise.resolve(input.beforeGitWrite?.(value.root)).then(() =>
      gitPush(value.root),
    ),
  );
  ipcMain.handle(
    "workspace:list-git-directory",
    (_event, input: GitDirectoryInput) => listGitDirectory(input),
  );
  ipcMain.handle("workspace:read-git-file", (_event, input: GitFileInput) =>
    readGitFile(input),
  );
  ipcMain.handle(
    "workspace:git-repository-fingerprint",
    (_event, input: { root: string }) => gitRepositoryFingerprint(input.root),
  );
  ipcMain.handle(
    "workspace:ensure-git-repository",
    (_event, input: { root: string }) =>
      ensureWorkspaceGitRepository(input.root),
  );
  ipcMain.handle(
    "workspace:create-project",
    (_event, input: CreateProjectInput) => createProject(input),
  );
  ipcMain.handle(
    "workspace:create-worktree",
    (_event, input: CreateWorktreeInput) => createWorktree(input),
  );
  ipcMain.handle(
    "workspace:prepare-project-preview",
    (_event, input: PrepareProjectPreviewInput) => prepareProjectPreview(input),
  );
  ipcMain.handle(
    "workspace:run-project-setup",
    (_event, input: RunProjectSetupInput) => runProjectSetup(input),
  );
  ipcMain.handle(
    "workspace:collect-project-initialization-diagnostics",
    async (_event, input: CollectProjectInitializationDiagnosticsInput) =>
      collectProjectInitializationDiagnostics(
        input,
        await setupEnvironment(resolveRuntimePath(input.worktree)),
      ),
  );
  ipcMain.handle(
    "workspace:check-host-dependencies",
    async (_event, input: CheckHostDependenciesInput) =>
      checkHostDependencies({
        env: await setupEnvironment(
          input.worktree ? resolveRuntimePath(input.worktree) : "",
        ),
        includeRuntime: input.includeRuntime,
        runtimeProfile: input.runtimeProfile,
        setupScript: input.setupScript ?? "",
      }),
  );
  ipcMain.handle("workspace:get-runtime-status", () =>
    getRuntimeStatus({ env: runtimeManagerEnvironment() }),
  );
  registerRuntimeOperationHandler(
    "workspace:ensure-runtime-ready",
    ensureRuntimeReady,
    input.onRuntimeReady,
  );
  registerRuntimeOperationHandler(
    "workspace:repair-runtime",
    repairRuntime,
    input.onRuntimeReady,
  );
  registerRuntimeOperationHandler(
    "workspace:reset-runtime",
    resetRuntime,
    input.onRuntimeReady,
  );
  ipcMain.handle("workspace:uninstall-runtime", async () => {
    resetRuntimeGitIdentityConfigured();
    return uninstallRuntime({ env: runtimeManagerEnvironment() });
  });
  ipcMain.handle(
    "workspace:stop-project-setup",
    (_event, input: StopProjectSetupInput) => stopProjectSetup(input),
  );
  ipcMain.handle(
    "workspace:remove-worktree",
    (_event, input: RemoveWorktreeInput) => removeWorktree(input),
  );
  ipcMain.handle(
    "workspace:resolve-project-preview-url",
    (_event, input: ResolveProjectPreviewUrlInput) =>
      resolveProjectPreviewUrl(input),
  );
  ipcMain.handle(
    "workspace:ensure-project-preview-url",
    (_event, input: EnsureProjectPreviewUrlInput) =>
      ensureProjectPreviewUrl(input),
  );
  ipcMain.handle(
    "workspace:project-runtime-healthy",
    (_event, input: ResolveProjectPreviewUrlInput) =>
      projectRuntimeHealthy(input.worktree),
  );
  ipcMain.handle(
    "workspace:project-preview-runtime-state",
    (_event, input: { worktree: string; workspaceMode?: WorkspaceMode }) =>
      projectPreviewRuntimeState(input.worktree, input.workspaceMode),
  );
  ipcMain.handle(
    "workspace:control-project-preview",
    (_event, input: ControlProjectPreviewInput) =>
      localPreviewService.control(input),
  );
  ipcMain.handle(
    "workspace:apply-project-preview-initialization",
    (_event, input: ApplyProjectPreviewInitializationInput) =>
      applyProjectPreviewInitialization(input),
  );
  ipcMain.handle(
    "workspace:list-project-services",
    (_event, input: { worktree: string }) =>
      listProjectServices(input.worktree),
  );
  ipcMain.handle(
    "workspace:start-project-service-logs",
    (_event, input: ProjectServiceLogsInput) => startProjectServiceLogs(input),
  );
  ipcMain.handle(
    "workspace:stop-project-service-logs",
    (_event, input: { streamId: string }) =>
      stopProjectServiceLogs(input.streamId),
  );
}
async function listDirectory(input: WorkspacePathInput) {
  const directory = resolveWorkspacePath(input);
  const entries = runtimeManagedPath(directory)
    ? await readRuntimeDirectory(directory)
    : await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith(".git"))
    .map((entry) => ({
      name: entry.name,
      path: toWorkspacePath(
        input.root,
        joinWorkspacePath(directory, entry.name),
      ),
      type: entry.isDirectory() ? "directory" : "file",
    }))
    .sort((left, right) =>
      `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`),
    );
}

async function pathExists(path: string) {
  try {
    await stat(resolve(path));
    return true;
  } catch {
    return false;
  }
}

async function readWorkspaceFile(input: WorkspacePathInput) {
  const filePath = resolveWorkspacePath(input);
  if (runtimeManagedPath(filePath)) return readRuntimeFile(filePath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("Path is not a file");
  return readFile(filePath, "utf8");
}

async function searchFiles(input: WorkspaceSearchInput) {
  const root = resolveRuntimePath(input.root);
  const query = normalizeWorkspaceSearchText(input.query);
  if (!query) return [];
  const limit = Math.min(input.limit ?? 30, 100);
  if (runtimeManagedPath(root)) return searchRuntimeFiles(root, query, limit);
  const matches: Array<{ name: string; path: string; type: "file" }> = [];
  await walk(root, root, query, limit, matches);
  return matches;
}

async function searchRuntimeFiles(root: string, query: string, limit: number) {
  const { stdout } = await runRuntime("find", [root, "-type", "f"]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((path) => ({ name: posix.basename(path), path }))
    .map((entry) => ({
      name: entry.name,
      path: toWorkspacePath(root, entry.path),
      type: "file" as const,
    }))
    .filter(
      (entry) =>
        normalizeWorkspaceSearchText(entry.name).includes(query) ||
        normalizeWorkspaceSearchText(entry.path).includes(query),
    )
    .slice(0, limit);
}

async function createWorktree(input: CreateWorktreeInput) {
  const operation = beginExecutionOperation(
    input,
    worktreeSetupOperationName,
    createWorktreePath(input),
  );
  const cohorts = enrichExecutionRepositoryCohorts(
    operation,
    input.repositoryRoot,
  );
  return runExecutionOperation(operation, async () => {
    const result = await createWorktreeOperation(input);
    await waitForRepositoryCohorts(cohorts);
    return result;
  });
}

async function createWorktreeOperation(input: CreateWorktreeInput) {
  if (input.direct) return directWorkspace(input);
  const context = worktreeCreationContext(input);
  await prepareWorktreeCreation(context);
  if (await reuseRegisteredWorktree(context)) return worktreeResult(context);
  await assertWorktreePathAvailable(context);
  await addStoryWorktree(context);
  await completeWorktreeCreation(context);
  return worktreeResult(context);
}

function worktreeCreationContext(
  input: CreateWorktreeInput,
): WorktreeCreationContext {
  const mode = workspaceMode(input.runtimeProfile);
  return {
    branch: storyBranch(input.storyReference, input.title),
    mode,
    repositoryRoot: resolveRuntimePath(input.repositoryRoot),
    startedAt: Date.now(),
    timings: [],
    worktree: createWorktreePath(input),
  };
}

async function prepareWorktreeCreation(context: WorktreeCreationContext) {
  const { mode, repositoryRoot, timings, worktree } = context;
  if (mode === "local-container") {
    await timedWorktreeCreateStep(timings, "git safe directory", () =>
      ensureRuntimeGitSafeDirectory(repositoryRoot),
    );
  }
  await timedWorktreeCreateStep(timings, "git repository ensure", () =>
    ensureWorkspaceGitRepository(repositoryRoot),
  );
  await timedWorktreeCreateStep(timings, "worktree parent mkdir", () =>
    mkdirRuntime(dirnameWorkspacePath(worktree)),
  );
}

async function reuseRegisteredWorktree(context: WorktreeCreationContext) {
  const { mode, repositoryRoot, timings, worktree } = context;
  const registered = await timedWorktreeCreateStep(
    timings,
    "worktree registered check",
    () => worktreeRegistered(repositoryRoot, worktree, mode),
  );
  if (!registered) return false;
  try {
    await runRuntimeGit(
      repositoryRoot,
      ["worktree", "lock", "--reason", "Managed by Blame", worktree],
      workspaceExecution(mode),
    );
  } catch (error) {
    if (!commandErrorText(error).includes("already locked")) throw error;
  }
  await completeWorktreeCreation(context);
  return true;
}

async function assertWorktreePathAvailable(context: WorktreeCreationContext) {
  const exists = await timedWorktreeCreateStep(
    context.timings,
    "worktree path exists check",
    () => runtimePathExists(context.worktree),
  );
  if (exists)
    throw new Error("Worktree directory already exists but is not registered");
}

async function addStoryWorktree(context: WorktreeCreationContext) {
  const { branch, mode, repositoryRoot, timings, worktree } = context;
  const existing = await timedWorktreeCreateStep(
    timings,
    "branch exists check",
    () => branchExists(repositoryRoot, branch, mode),
  );
  const label = existing
    ? "git worktree add existing branch"
    : "git worktree add new branch";
  const args = storyWorktreeAddArguments({ branch, existing, worktree });
  await timedWorktreeCreateStep(timings, label, () =>
    runRuntimeGit(repositoryRoot, args, workspaceExecution(mode)),
  );
}

async function completeWorktreeCreation(context: WorktreeCreationContext) {
  const { repositoryRoot, startedAt, timings, worktree } = context;
  await timedWorktreeCreateStep(timings, "env sync", () =>
    syncProjectEnvFiles(repositoryRoot, worktree),
  );
  invalidateSetupEnvironment(worktree);
  removedWorktrees.delete(worktree);
  await appendWorktreeCreateTimings(worktree, timings, startedAt);
}

// Direct mode: the project folder on its current branch, untouched.
async function directWorkspace(input: CreateWorktreeInput) {
  const repositoryRoot = resolveRuntimePath(input.repositoryRoot);
  await ensureWorkspaceGitRepository(repositoryRoot);
  const branch = String(
    await runRuntimeGit(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"], "native"),
  ).trim();
  return {
    branch: branch && branch !== "HEAD" ? branch : "",
    workspaceMode: "direct" as const,
    worktree: repositoryRoot,
  };
}

function worktreeResult(context: WorktreeCreationContext) {
  return {
    branch: context.branch,
    workspaceMode: context.mode,
    worktree: context.worktree,
  };
}

function createWorktreePath(input: CreateWorktreeInput) {
  return worktreePath({
    mode: workspaceMode(input.runtimeProfile),
    repositoryRoot: input.repositoryRoot,
    storyId: input.storyReference,
    title: input.title,
  });
}

async function timedWorktreeCreateStep<T>(
  timings: Array<{ duration: number; label: string }>,
  label: string,
  action: () => Promise<T> | T,
) {
  const start = Date.now();
  try {
    return await traceWorkspaceStep(label, action);
  } finally {
    timings.push({ duration: Date.now() - start, label });
  }
}

async function appendWorktreeCreateTimings(
  worktree: string,
  timings: Array<{ duration: number; label: string }>,
  startedAt: number,
) {
  for (const timing of timings)
    await appendTimingLog(
      worktree,
      `create worktree ${timing.label}`,
      timing.duration,
    );
  await appendTimingLog(
    worktree,
    "create worktree total",
    Date.now() - startedAt,
  );
}

function beginExecutionOperation(
  input: ExecutionContextInput,
  operationName: string,
  worktree?: string,
): ExecutionOperation {
  const descriptor = executionDescriptor(input, worktree);
  const component = getExecutionRegistry().beginComponent(
    descriptor,
    operationName,
    { [ATTR_BLAME_OPERATION_NAME]: operationName },
  );
  return {
    component,
    descriptor,
    finished: false,
    operationName,
  };
}

async function runExecutionOperation<T>(
  operation: ExecutionOperation,
  action: () => Promise<T>,
  outcome = (_result: T): TelemetryOutcome => "succeeded",
) {
  return getBlameTelemetry().withinSpan(operation.component.span, async () => {
    try {
      const result = await action();
      finishExecutionOperation(operation, outcome(result));
      return result;
    } catch (error) {
      finishExecutionOperation(operation, "failed", error);
      throw error;
    }
  });
}

function finishExecutionOperation(
  operation: ExecutionOperation,
  outcome: TelemetryOutcome,
  error?: unknown,
) {
  if (operation.finished) return;
  operation.finished = true;
  recordOperationMetrics(
    operation.component.span,
    operation.operationName,
    outcome,
    error,
    operation.descriptor,
  );
  if (outcome === "failed") operation.component.fail(error ?? new Error());
  else if (outcome === "canceled") operation.component.cancel();
  else operation.component.succeed();
}

function executionDescriptor(
  input: ExecutionContextInput,
  worktree?: string,
): ExecutionDescriptor {
  return {
    attributes: executionCohortAttributes(input.telemetryCohorts),
    executionId: input.executionId,
    storyId: input.storyId,
    worktreeId: worktree ? opaqueIdentifier(worktree) : undefined,
  };
}

function executionCohortAttributes(
  cohorts: ExecutionTelemetryCohorts | undefined,
) {
  const workspaceAttributes = { [ATTR_BLAME_EXECUTION_KIND]: "workspace" };
  if (!cohorts) return workspaceAttributes;
  const strategy = boundedAgentStrategy(cohorts.agentStrategy);
  return {
    ...workspaceAttributes,
    [ATTR_BLAME_AGENT_ROLE]: "lead",
    [ATTR_BLAME_AGENT_STRATEGY]: strategy,
    [ATTR_BLAME_MULTI_AGENT_ENABLED]: strategy === "multi_agent",
    [ATTR_BLAME_MULTI_AGENT_USED]: false,
    [ATTR_BLAME_REPOSITORY_LANGUAGE]: boundedRepositoryLanguage(
      cohorts.repositoryLanguage,
    ),
    [ATTR_BLAME_REPOSITORY_SIZE_BUCKET]: boundedCohortValue(
      cohorts.repositorySizeBucket,
      repositorySizeCohorts,
    ),
    [ATTR_BLAME_TASK_COMPLEXITY_BUCKET]: boundedCohortValue(
      cohorts.taskComplexityBucket,
      taskComplexityCohorts,
    ),
    [ATTR_GEN_AI_PROVIDER_NAME]: semanticGenAiProviderName(cohorts.providerId),
    [ATTR_GEN_AI_REQUEST_MODEL]: boundedMetricDimensionName(cohorts.modelId),
  };
}

function boundedAgentStrategy(value: string) {
  return value === "multi_agent" ? value : "single_agent";
}

function boundedRepositoryLanguage(value: string | undefined) {
  if (!value) return undefined;
  return repositoryLanguageCohorts.has(value) ? value : "other";
}

function boundedCohortValue(value: string | undefined, allowed: Set<string>) {
  return value && allowed.has(value) ? value : undefined;
}

async function enrichExecutionRepositoryCohorts(
  operation: ExecutionOperation,
  repositoryRoot: string,
) {
  const cohorts = await loadRepositoryTelemetryCohorts(repositoryRoot);
  if (!cohorts) return;
  const attributes = {
    [ATTR_BLAME_REPOSITORY_LANGUAGE]: cohorts.repositoryLanguage,
    [ATTR_BLAME_REPOSITORY_SIZE_BUCKET]: cohorts.repositorySizeBucket,
  };
  operation.descriptor.attributes = {
    ...operation.descriptor.attributes,
    ...attributes,
  };
  getExecutionRegistry().setAttributes(
    operation.descriptor.executionId,
    attributes,
  );
}

function loadRepositoryTelemetryCohorts(repositoryRoot: string) {
  const root = resolveRuntimePath(repositoryRoot);
  const cached = repositoryTelemetryCache.get(root);
  if (cached) return cached;
  const pending = readRepositoryTelemetryCohorts(root);
  repositoryTelemetryCache.set(root, pending);
  void pending.then((cohorts) => {
    if (!cohorts) repositoryTelemetryCache.delete(root);
  });
  return pending;
}

async function readRepositoryTelemetryCohorts(root: string) {
  try {
    const result = await runRuntime("git", ["ls-files", "-z"], { cwd: root });
    return repositoryTelemetryCohorts(result.stdout);
  } catch {
    return undefined;
  }
}

async function waitForRepositoryCohorts(preparation: Promise<void>) {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, 100);
  });
  await Promise.race([preparation, deadline]);
  if (timeout) clearTimeout(timeout);
}

async function runProjectSetup(input: RunProjectSetupInput) {
  const operation = beginExecutionOperation(
    input,
    projectSetupOperationName,
    input.worktree,
  );
  void enrichExecutionRepositoryCohorts(operation, input.worktree);
  try {
    return await getBlameTelemetry().withinSpan(operation.component.span, () =>
      runProjectSetupOperation(input, operation),
    );
  } catch (error) {
    finishExecutionOperation(operation, "failed", error);
    throw error;
  }
}

async function prepareProjectPreview(input: PrepareProjectPreviewInput) {
  const operation = beginExecutionOperation(
    input,
    previewPrepareOperationName,
    input.worktree,
  );
  void enrichExecutionRepositoryCohorts(operation, input.worktree);
  return runExecutionOperation(operation, async () => {
    await prepareProjectPreviewArtifacts(input);
    return { prepared: true };
  });
}

async function runProjectSetupOperation(
  input: RunProjectSetupInput,
  operation: ExecutionOperation,
) {
  const { env, scriptPath, worktree } =
    await prepareProjectPreviewArtifacts(input);
  return timedRecoveryStep(worktree, "setup process spawn", () =>
    startProjectSetupProcess(
      worktree,
      scriptPath,
      env,
      operation,
      input.runtimeProfile === "local-container",
    ),
  );
}

async function prepareProjectPreviewArtifacts(
  input: PrepareProjectPreviewInput,
) {
  const worktree = resolveRuntimePath(input.worktree);
  const env = await setupEnvironment(worktree);
  const manifest = manifestWithProjectPackageManager(
    parsePreviewManifest(input.previewManifest),
    projectPackageManager(
      await readRuntimeFile(joinWorkspacePath(worktree, "package.json")).catch(
        () => undefined,
      ),
    ),
  );
  compiledPreviewPlan(manifest);
  const generated = generatePreviewArtifacts(manifest);
  const dockerCompose = generated.dockerCompose;
  const runConfigurations = parseRunConfigurations(input.runConfigurations);
  validateContainerizedRunConfigurations(runConfigurations, manifest);
  const setupScript = setupScriptWithoutDockerRuntimeChecks(
    generated.setupScript,
  );
  await validateProjectSetup(
    worktree,
    setupScript,
    env,
    input.hostDependenciesChecked,
    input.runtimeProfile,
  );
  const scriptPath = await prepareProjectSetupFiles(
    worktree,
    setupScript,
    dockerCompose,
    manifest,
    runConfigurations,
    input.runConfigurationId,
  );
  return { env, scriptPath, worktree };
}

async function validateProjectSetup(
  worktree: string,
  setupScript: string,
  env: NodeJS.ProcessEnv,
  hostDependenciesChecked?: boolean,
  runtimeProfile?: RuntimeProfileId,
) {
  if (!hostDependenciesChecked) {
    await timedRecoveryStep(worktree, "host dependencies", () =>
      assertHostDependencies({ env, runtimeProfile, setupScript }),
    );
  }
  await timedRecoveryStep(worktree, "git repository check", () =>
    assertGitRepository(worktree),
  );
}

async function prepareProjectSetupFiles(
  worktree: string,
  setupScript: string,
  dockerCompose: string,
  previewManifest: PreviewManifest,
  runConfigurations: ProjectRunConfiguration[],
  runConfigurationId?: string | null,
) {
  const directory = joinWorkspacePath(worktree, ".blame", "initialization");
  const scriptPath = joinWorkspacePath(directory, "setup.sh");
  const composePath = joinWorkspacePath(directory, "docker-compose.yml");
  const manifestPath = joinWorkspacePath(directory, "preview-manifest.json");
  const runConfigurationsPath = joinWorkspacePath(
    directory,
    "run-configurations.json",
  );
  const runtimeStatePath = joinWorkspacePath(
    directory,
    "preview-runtime-state.json",
  );
  const logPath = setupLogPath(worktree);
  await mkdirRuntime(dirnameWorkspacePath(logPath));
  await writeRuntimeFile(logPath, "");
  const symlinkEnvMounts = await timedRecoveryStep(
    worktree,
    "env file scan",
    () => envHostFileMounts(worktree),
  );
  const runtimeState = initialPreviewRuntimeSelection(
    runConfigurations,
    runConfigurationId,
  );
  await writeProjectSetupFiles({
    composePath,
    directory,
    dockerCompose,
    manifest: parsePreviewManifest(previewManifest),
    manifestPath,
    runConfigurations,
    runConfigurationsPath,
    runtimeState,
    runtimeStatePath,
    scriptPath,
    setupScript,
    symlinkEnvMounts,
    worktree,
  });
  return scriptPath;
}

function validateContainerizedRunConfigurations(
  configurations: ProjectRunConfiguration[],
  manifest: PreviewManifest,
) {
  const serviceIds = new Set(manifest.services.map(({ id }) => id));
  for (const configuration of configurations) {
    for (const service of configuration.services) {
      if (!serviceIds.has(service)) {
        throw new PreviewRuntimeError(
          "preview_manifest_invalid",
          `Run configuration ${configuration.id} references unknown service ${service}`,
        );
      }
    }
  }
}

async function writeProjectSetupFiles(input: ProjectSetupFiles) {
  await timedRecoveryStep(input.worktree, "initialization files", async () => {
    await timedRecoveryStep(
      input.worktree,
      "initialization directory mkdir",
      () => mkdirRuntime(input.directory),
    );
    await timedRecoveryStep(input.worktree, "setup script write", () =>
      writeRuntimeFile(input.scriptPath, input.setupScript),
    );
    const compose = await prepareProjectSetupCompose(input);
    await timedRecoveryStep(input.worktree, "compose file write", () =>
      writeRuntimeFile(input.composePath, compose),
    );
    await timedRecoveryStep(input.worktree, "preview manifest write", () =>
      writeProjectPreviewManifest(input),
    );
    await timedRecoveryStep(input.worktree, "run configurations write", () =>
      writePreviewRuntimeFiles(input),
    );
    await timedRecoveryStep(input.worktree, "setup script chmod", () =>
      chmodRuntime(input.scriptPath, 0o755),
    );
  });
}

async function writePreviewRuntimeFiles(input: ProjectSetupFiles) {
  await writeRuntimeJson(input.runConfigurationsPath, input.runConfigurations);
  await writeRuntimeJson(input.runtimeStatePath, input.runtimeState);
}

function writeRuntimeJson(path: string, value: unknown) {
  return writeRuntimeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeProjectPreviewManifest(input: ProjectSetupFiles) {
  await writeRuntimeFile(
    input.manifestPath,
    `${JSON.stringify(input.manifest, null, 2)}\n`,
  );
}

function prepareProjectSetupCompose(input: ProjectSetupFiles) {
  return timedRecoveryStep(input.worktree, "compose prepare", () =>
    prepareProjectCompose(
      input.worktree,
      input.dockerCompose,
      input.symlinkEnvMounts,
    ),
  );
}

function startProjectSetupProcess(
  worktree: string,
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  telemetry: ExecutionOperation,
  startLocalPreview: boolean,
) {
  const runId = randomUUID();
  const child = spawnRuntime("bash", [scriptPath], {
    cwd: worktree,
    env,
  });
  const processSpan = startWorkspaceStep(
    "setup process runtime",
    telemetry.component.span.context,
  );
  trackWorkspaceProcess(child);
  setupRuns.set(runId, {
    id: runId,
    process: child,
    processSpan,
    startedAt: Date.now(),
    startLocalPreview,
    telemetry,
    worktree,
  });
  registerProjectSetupProcessEvents(child, runId, worktree);
  return { runId };
}

function registerProjectSetupProcessEvents(
  child: ChildProcessWithoutNullStreams,
  runId: string,
  worktree: string,
) {
  child.stdout.on("data", (data: Buffer) =>
    emitSetupOutput(runId, worktree, "stdout", data.toString()),
  );
  child.stderr.on("data", (data: Buffer) =>
    emitSetupOutput(runId, worktree, "stderr", data.toString()),
  );
  child.once("error", (error) => {
    failProjectSetupProcess(runId, worktree, error);
  });
  child.on("exit", (code) => {
    void completeProjectSetup(runId, worktree, code);
  });
}

function setupScriptWithoutDockerRuntimeChecks(script: string) {
  return script
    .replace(/\n?if\s+!\s+command\s+-v\s+docker\b[\s\S]*?\nfi\s*/g, "\n")
    .replace(/\n?if\s+!\s+docker\s+compose\s+version\b[\s\S]*?\nfi\s*/g, "\n")
    .replace(/^\s*command\s+-v\s+docker\b.*$/gm, "")
    .replace(/^\s*docker\s+compose\s+version\b.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

async function completeProjectSetup(
  runId: string,
  worktree: string,
  code: number | null,
) {
  const run = setupRuns.get(runId);
  if (!run) return;
  finishSetupProcessSpan(run, code);
  await getBlameTelemetry().withinSpan(
    run.telemetry.component.span,
    async () => {
      run.telemetry.component.span.setAttributes({
        "process.exit.code": code ?? -1,
      });
      await appendTimingLog(
        worktree,
        "setup process runtime",
        Date.now() - run.startedAt,
      );
      if (code === 0) return completeSuccessfulProjectSetup(run);
      finishSetupRun(run, "failed", new Error("Project setup process failed"));
      emitSetupOutput(runId, worktree, "exit", String(code ?? ""));
    },
  );
}

function finishSetupProcessSpan(run: SetupRun, code: number | null) {
  const outcome = code === 0 ? "succeeded" : "failed";
  run.processSpan.setAttributes({
    "process.exit.code": code ?? -1,
    ...(outcome === "failed" ? { [ATTR_ERROR_TYPE]: "Error" } : {}),
  });
  run.processSpan.end(outcome);
}

async function completeSuccessfulProjectSetup(run: SetupRun) {
  const { id: runId, worktree } = run;
  try {
    const previewUrl = run.startLocalPreview
      ? await traceSetupPreview(run, () => completeSetupPreview(worktree))
      : null;
    finishSetupRun(run, "succeeded");
    emitSetupOutput(
      runId,
      worktree,
      "stdout",
      previewUrl
        ? "Project preview containers are running.\n"
        : "Project runtime is ready.\n",
    );
    emitSetupOutput(runId, worktree, "exit", "0");
  } catch (error) {
    await stopProjectLogStream(worktree);
    finishSetupRun(run, "failed", error);
    emitSetupOutput(runId, worktree, "stderr", errorMessage(error));
    emitSetupOutput(runId, worktree, "exit", "1");
  }
}

async function completeSetupPreview(worktree: string) {
  return startProjectCompose(worktree);
}

function failProjectSetupProcess(
  runId: string,
  worktree: string,
  error: unknown,
) {
  const run = setupRuns.get(runId);
  if (!run) return;
  finishSetupRun(run, "failed", error);
  emitSetupOutput(runId, worktree, "stderr", errorMessage(error));
  emitSetupOutput(runId, worktree, "exit", "1");
}

function finishSetupRun(
  run: SetupRun,
  outcome: TelemetryOutcome,
  error?: unknown,
) {
  setupRuns.delete(run.id);
  run.processSpan.end(outcome);
  finishExecutionOperation(run.telemetry, outcome, error);
}

async function traceSetupPreview<T>(run: SetupRun, action: () => Promise<T>) {
  const telemetry = getBlameTelemetry();
  const operationName = previewStartOperationName;
  const span = telemetry.startSpan(operationName, {
    attributes: operationSpanAttributes(
      run.telemetry.descriptor,
      operationName,
    ),
    parent: run.telemetry.component.span.context,
  });
  return telemetry.withinSpan(span, () =>
    runSpanOperation(span, operationName, run.telemetry.descriptor, action),
  );
}

async function runSpanOperation<T>(
  span: BlameSpan,
  operationName: string,
  descriptor: ExecutionDescriptor,
  action: () => Promise<T>,
) {
  try {
    const result = await action();
    recordOperationMetrics(
      span,
      operationName,
      "succeeded",
      undefined,
      descriptor,
    );
    span.end("succeeded");
    return result;
  } catch (error) {
    span.recordError(error);
    recordOperationMetrics(span, operationName, "failed", error, descriptor);
    span.end("failed");
    throw error;
  }
}

function recordOperationMetrics(
  span: BlameSpan,
  operationName: string,
  outcome: TelemetryOutcome,
  error?: unknown,
  descriptor?: ExecutionDescriptor,
) {
  const attributes = operationMetricAttributes(
    operationName,
    outcome,
    error,
    descriptor,
  );
  const telemetry = getBlameTelemetry();
  telemetry.count(`${operationName}.count`, 1, attributes, span.context);
  telemetry.record(
    `${operationName}.duration`,
    span.durationSeconds(),
    attributes,
    span.context,
  );
  recordOperationLog(span, outcome, attributes, error);
}

function operationMetricAttributes(
  operationName: string,
  outcome: TelemetryOutcome,
  error?: unknown,
  descriptor?: ExecutionDescriptor,
) {
  return {
    ...metricCohortAttributes(descriptor),
    [ATTR_BLAME_EXECUTION_STATUS]: outcome,
    [ATTR_BLAME_OPERATION_NAME]: operationName,
    ...(outcome === "failed"
      ? { [ATTR_ERROR_TYPE]: operationErrorType(error) }
      : {}),
  };
}

function recordOperationLog(
  span: BlameSpan,
  outcome: TelemetryOutcome,
  attributes: Record<string, unknown>,
  error?: unknown,
) {
  const telemetry = getBlameTelemetry();
  telemetry.log(
    outcome === "failed" ? "error" : "info",
    "blame.operation.completed",
    {
      ...attributes,
      ...(error ? errorAttributes(error) : {}),
    },
    span.context,
  );
}

function metricCohortAttributes(descriptor: ExecutionDescriptor | undefined) {
  const latest = descriptor
    ? getExecutionRegistry().attributes(descriptor.executionId)
    : undefined;
  return latest ?? descriptor?.attributes;
}

function operationSpanAttributes(
  descriptor: ExecutionDescriptor,
  operationName: string,
) {
  return {
    [ATTR_BLAME_EXECUTION_ID]: descriptor.executionId,
    [ATTR_BLAME_OPERATION_NAME]: operationName,
    [ATTR_BLAME_STORY_ID]: descriptor.storyId,
    [ATTR_BLAME_WORKTREE_ID]: descriptor.worktreeId,
  };
}

function operationErrorType(error: unknown) {
  if (error instanceof PreviewRuntimeError) return error.code;
  if (error instanceof Error && error.name) {
    return boundedMetricDimensionName(error.name);
  }
  return "Error";
}

function startProjectCompose(
  worktree: string,
  options: { reallocatePorts?: boolean } = {},
) {
  return dedupeComposeCall(`start:${worktree}`, () =>
    startProjectComposeOperation(worktree, options),
  );
}

async function startProjectComposeOperation(
  worktree: string,
  options: { reallocatePorts?: boolean },
) {
  if (await stopPreviewStartWhenRequested(worktree)) return undefined;
  // A likely stale setup explains a failed start; it never blocks one.
  const stale = await timedRecoveryStep(worktree, "setup preflight", async () =>
    stalePreviewSetupReason(worktree, await readProjectPreviewManifest(worktree)),
  );
  try {
    return await startCheckedProjectCompose(worktree, options);
  } catch (error) {
    if (!stale || !(error instanceof PreviewRuntimeError)) throw error;
    throw new PreviewRuntimeError(
      "preview_setup_stale",
      `${stale} (${error.message})`,
    );
  }
}

async function startCheckedProjectCompose(
  worktree: string,
  options: { reallocatePorts?: boolean },
) {
  if (!(await projectSetupCompleted(worktree))) {
    await timedRecoveryStep(worktree, "project setup", () =>
      runExistingProjectSetup(worktree),
    );
  }
  if (await stopPreviewStartWhenRequested(worktree)) return undefined;
  await timedRecoveryStep(worktree, "compose repair", () =>
    repairProjectCompose(worktree, options),
  );
  if (await stopPreviewStartWhenRequested(worktree)) return undefined;
  await timedRecoveryStep(worktree, "compose up", () =>
    runProjectComposeUp(worktree),
  );
  if (await stopPreviewStartWhenRequested(worktree)) return undefined;
  if (!(await projectRuntimeShouldStartBrowserPreview(worktree))) {
    await timedRecoveryStep(worktree, "preview probes", () =>
      runPreviewProbes(worktree),
    );
    return undefined;
  }
  return startSelectedWebPreview(worktree);
}

async function startSelectedWebPreview(worktree: string) {
  const previewUrl = await timedRecoveryStep(
    worktree,
    "preview url resolve",
    () => waitForPreviewUrl(worktree),
  );
  if (!previewUrl) return undefined;
  if (
    await timedRecoveryStep(worktree, "preview environment sync", () =>
      syncPreviewRuntimeEnvironment(worktree, previewUrl),
    )
  ) {
    await timedRecoveryStep(worktree, "preview service restart", () =>
      restartPreviewService(worktree, true),
    );
  }
  if (await stopPreviewStartWhenRequested(worktree)) return undefined;
  await timedRecoveryStep(worktree, "preview response wait", () =>
    waitForPreview(worktree, previewUrl),
  );
  if (await stopPreviewStartWhenRequested(worktree)) return undefined;
  await timedRecoveryStep(worktree, "preview probes", () =>
    runPreviewProbes(worktree),
  );
  return previewUrl;
}

async function projectRuntimeShouldStartBrowserPreview(worktree: string) {
  const [configurations, state, manifest] = await Promise.all([
    readProjectRunConfigurations(worktree),
    readPreviewRuntimeFileState(worktree),
    readProjectPreviewManifest(worktree),
  ]);
  return shouldStartBrowserPreview(configurations, state, manifest);
}

async function syncPreviewRuntimeEnvironment(
  worktree: string,
  previewUrl: string,
) {
  const origin = previewOrigin(previewUrl);
  if (!origin) return false;
  const overrides = await projectPreviewEnvOverrides(worktree);
  if (await materializedPreviewEnvFilesMatch(worktree, origin, overrides)) {
    return false;
  }
  await materializedPreviewEnvHostFileMounts(worktree, origin, overrides);
  invalidateSetupEnvironment(worktree);
  return true;
}

async function projectPreviewEnvOverrides(worktree: string) {
  const composePath = projectComposePath(worktree);
  if (!(await runtimePathExists(composePath))) return [];
  return previewComposeEnvOverrides(await readRuntimeFile(composePath));
}

async function clearPreviewBuildCache(worktree: string) {
  await rmRuntime(joinWorkspacePath(worktree, ".next"));
}

async function restartPreviewService(
  worktree: string,
  clearBuildCache = false,
) {
  const container = await previewContainerForWorktree(worktree);
  if (!container?.Id) return;
  const env = await setupEnvironment(worktree);
  await containerRuntime.container(["stop", container.Id], {
    cwd: worktree,
    env,
  });
  if (clearBuildCache) await clearPreviewBuildCache(worktree);
  await containerRuntime.container(["start", container.Id], {
    cwd: worktree,
    env,
  });
}

async function runProjectComposeUp(worktree: string) {
  const args = composeArgs(worktree);
  await timedRecoveryStep(worktree, "compose volumes", () =>
    ensureGlobalPreviewVolumes(worktree),
  );
  const config = await timedRecoveryStep(worktree, "compose config", () =>
    composeConfig(worktree, projectComposePath(worktree)),
  );
  const plan = previewComposePlan(config);
  const selectedServices = await selectedComposeRuntimeServices(
    worktree,
    plan.runtimeServices,
  );
  const runtimeContainers = composeRuntimeServiceClosure(
    config,
    uniqueStrings([...plan.setupRuntimeDependencies, ...selectedServices]),
  );
  await timedRecoveryStep(worktree, "compose reset runtime containers", () =>
    resetProjectComposeRuntimeContainers(worktree, runtimeContainers),
  );
  await timedRecoveryStep(worktree, "compose one-shot dependencies", () =>
    runCompletedDependencyServices(worktree, config, plan.oneShotDependencies),
  );
  await timedRecoveryStep(worktree, "compose runtime containers", () =>
    createProjectComposeRuntimeContainers(worktree, runtimeContainers),
  );
  await timedRecoveryStep(worktree, "compose setup dependencies", () =>
    startSetupRuntimeDependencies(
      worktree,
      config,
      plan.setupRuntimeDependencies,
    ),
  );
  await timedRecoveryStep(worktree, "compose setup services", () =>
    runSetupTaskServices(worktree, config, plan.setupTasks),
  );
  if (!selectedServices.length) return;
  await timedRecoveryStep(worktree, "compose log stream", () =>
    startProjectLogStream(worktree),
  );
  await timedRecoveryStep(worktree, "compose runtime services", () =>
    runComposeWithRetry(
      worktree,
      [...args, "start", ...runtimeContainers],
      composeUpRetryDelaysMs,
      "compose start",
      composeStartTimeoutMs,
    ),
  );
}

async function selectedComposeRuntimeServices(
  worktree: string,
  runtimeServiceIds: string[],
) {
  const [configurations, state, manifest] = await Promise.all([
    readProjectRunConfigurations(worktree),
    readPreviewRuntimeFileState(worktree),
    readProjectPreviewManifest(worktree),
  ]);
  return selectedPreviewRuntimeServiceIds(
    configurations,
    state,
    runtimeServiceIds,
    manifest,
  );
}

async function runSetupTaskServices(
  worktree: string,
  config: ComposeConfig,
  services = setupTaskServices(config),
) {
  for (const service of services) {
    const serviceConfig = config.services?.[service];
    if (
      serviceConfig &&
      (await timedRecoveryStep(
        worktree,
        `dependency cache check ${service}`,
        () => dependencyCacheReady(worktree, serviceConfig),
      ))
    ) {
      await appendRecoveryLog(worktree, `dependency cache hit: ${service}`);
      continue;
    }
    await timedRecoveryStep(worktree, `compose setup service ${service}`, () =>
      runProjectComposeSetupService(worktree, service, config),
    );
    if (serviceConfig)
      await timedRecoveryStep(
        worktree,
        `dependency cache mark ${service}`,
        () => markDependencyCacheReady(worktree, serviceConfig),
      );
  }
  return new Set(services);
}

async function runCompletedDependencyServices(
  worktree: string,
  config: ComposeConfig,
  services: string[],
) {
  for (const service of services) {
    if (
      skippableDependencyInitService(service) &&
      (await timedRecoveryStep(
        worktree,
        `dependency init cache check ${service}`,
        () => setupDependencyCachesReady(worktree, config),
      ))
    ) {
      await appendRecoveryLog(
        worktree,
        `dependency init cache hit: ${service}`,
      );
      continue;
    }
    await timedRecoveryStep(
      worktree,
      `compose dependency service ${service}`,
      () => runProjectComposeOneShotService(worktree, service),
    );
  }
  return new Set(services);
}

async function startSetupRuntimeDependencies(
  worktree: string,
  config: ComposeConfig,
  services: string[],
) {
  if (!services.length) return;
  await runComposeWithRetry(
    worktree,
    [...composeArgs(worktree), "start", ...services],
    composeUpRetryDelaysMs,
    "compose setup dependencies",
    composeStartTimeoutMs,
  );
  for (const service of services) {
    await waitForComposeServiceReadiness(
      worktree,
      service,
      config.services?.[service],
    );
  }
}

async function createProjectComposeRuntimeContainers(
  worktree: string,
  services: string[],
) {
  if (!services.length) return;
  await runComposeWithRetry(
    worktree,
    [...composeArgs(worktree), "create", "--pull", "missing", ...services],
    composeUpRetryDelaysMs,
    "compose create",
    composeStartTimeoutMs,
  );
}

async function resetProjectComposeRuntimeContainers(
  worktree: string,
  services: string[],
) {
  if (!services.length) return;
  await containerRuntime.compose(
    [
      ...composeArgs(worktree),
      "rm",
      "--force",
      "--stop",
      "--volumes",
      ...services,
    ],
    {
      cwd: worktree,
      env: await setupEnvironment(worktree),
      timeoutMs: composeStartTimeoutMs,
    },
  );
}

async function waitForComposeServiceReadiness(
  worktree: string,
  service: string,
  config: ComposeService | undefined,
) {
  const healthcheck = composeServiceHealthcheckCommand(config);
  if (!healthcheck) return;
  const deadline = Date.now() + setupDependencyReadinessTimeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      await containerRuntime.compose(
        [...composeArgs(worktree), "exec", "-T", service, ...healthcheck],
        {
          cwd: worktree,
          env: await setupEnvironment(worktree),
          timeoutMs: containerMetadataTimeoutMs,
        },
      );
      await appendRecoveryLog(
        worktree,
        `dependency ${service} ready after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      );
      return;
    } catch {
      if (await previewRuntimeStopped(worktree)) return;
      await delay(previewStartupIntervalMs);
    }
  }
  await appendComposeDiagnostics(worktree);
  throw new PreviewRuntimeError(
    "preview_dependency_timeout",
    `Preview dependency ${service} did not become ready within ${setupDependencyReadinessTimeoutMs / 1_000} seconds`,
  );
}

function skippableDependencyInitService(service: string) {
  return (
    service === "blame-dependencies-init" || service === "blame-volumes-init"
  );
}

async function setupDependencyCachesReady(
  worktree: string,
  config: ComposeConfig,
) {
  const services = setupTaskServices(config)
    .map((service) => config.services?.[service])
    .filter((service): service is ComposeService => Boolean(service));
  if (services.length === 0) return false;
  for (const service of services) {
    if (!(await dependencyCacheReady(worktree, service))) return false;
  }
  return true;
}

async function dependencyCacheReady(worktree: string, service: ComposeService) {
  const cache = dependencyCache(service);
  if (!cache) return false;
  if (await hasMissingWorkspaceNodeModules(worktree)) {
    return false;
  }
  const env = await setupEnvironment(worktree);
  for (const volume of cache.volumes) {
    try {
      await containerRuntime.container(
        [
          "run",
          "--rm",
          "--pull=never",
          "-v",
          `${volume}:/node_modules`,
          ...(cache.pnpmStore ? ["-v", `${cache.pnpmStore}:/pnpm/store`] : []),
          dependencyCacheImage(service),
          "sh",
          "-lc",
          dependencyCacheReadyCommand(cache),
        ],
        { cwd: worktree, env },
      );
    } catch {
      return false;
    }
  }
  return true;
}

async function markDependencyCacheReady(
  worktree: string,
  service: ComposeService,
) {
  const cache = dependencyCache(service);
  if (!cache) return;
  try {
    const env = await setupEnvironment(worktree);
    for (const volume of cache.volumes) {
      await containerRuntime.container(
        [
          "run",
          "--rm",
          "--pull=never",
          "-v",
          `${volume}:/node_modules`,
          ...(cache.pnpmStore ? ["-v", `${cache.pnpmStore}:/pnpm/store`] : []),
          dependencyCacheImage(service),
          "sh",
          "-lc",
          dependencyCacheMarkCommand(cache),
        ],
        { cwd: worktree, env },
      );
    }
  } catch (error) {
    await appendRecoveryLog(
      worktree,
      `dependency cache marker failed: ${errorMessage(error).trim()}`,
    );
  }
}

function dependencyCache(service: ComposeService) {
  const labels = serviceLabels(service);
  if (labels["blame.dependencies.cache"] !== "true") return undefined;
  const key = labels["blame.dependencies.cache.key"];
  const volumes = nodeModulesVolumeSources(service);
  if (!key || volumes.length === 0) return undefined;
  return {
    key,
    volumes,
    pnpmStore: pnpmStoreVolumeSource(service),
  };
}

function dependencyCacheReadyCommand(
  cache: NonNullable<ReturnType<typeof dependencyCache>>,
) {
  const checks = [`test -e /node_modules/${dependencyCacheMarker(cache.key)}`];
  if (cache.pnpmStore) {
    checks.push("test -d /node_modules/.pnpm", "test -d /pnpm/store");
  }
  return checks.join(" && ");
}

function dependencyCacheMarkCommand(
  cache: NonNullable<ReturnType<typeof dependencyCache>>,
) {
  const checks = cache.pnpmStore
    ? ["test -d /node_modules/.pnpm", "test -d /pnpm/store"]
    : [];
  checks.push(`touch /node_modules/${dependencyCacheMarker(cache.key)}`);
  return checks.join(" && ");
}

function pnpmStoreVolumeSource(service: ComposeService) {
  return (service.volumes ?? []).flatMap((volume) => {
    const parsed = composeVolume(volume);
    return parsed?.target.replace(/\/$/u, "") === "/pnpm/store"
      ? [parsed.source]
      : [];
  })[0];
}

function dependencyCacheImage(service: ComposeService) {
  return service.image || "node:22-bookworm-slim";
}

function dependencyCacheMarker(key: string) {
  return `.blame-deps-${key.replace(/[^a-f0-9]/gi, "")}.ready`;
}

function nodeModulesVolumeSources(service: ComposeService) {
  return uniqueStrings(
    (service.volumes ?? []).flatMap((volume) => {
      const parsed = composeVolume(volume);
      return parsed?.target.replace(/\/$/, "").endsWith("/node_modules")
        ? [parsed.source]
        : [];
    }),
  );
}

function composeVolume(volume: NonNullable<ComposeService["volumes"]>[number]) {
  if (typeof volume !== "string") {
    if (!volume.source || !volume.target) return undefined;
    if (volume.type && volume.type !== "volume") return undefined;
    return { source: volume.source, target: volume.target };
  }
  const [source, target] = volume.split(":");
  if (!source || !target || target.startsWith("./") || target.startsWith("../"))
    return undefined;
  return { source, target };
}

async function runProjectComposeOneShotService(
  worktree: string,
  service: string,
) {
  const result = await containerRuntime.compose(
    [...composeArgs(worktree), "up", service],
    {
      cwd: worktree,
      env: await setupEnvironment(worktree),
      timeoutMs: composeSetupTimeoutMs,
    },
  );
  if (result.stdout) await appendRecoveryLog(worktree, result.stdout.trimEnd());
  if (result.stderr) await appendRecoveryLog(worktree, result.stderr.trimEnd());
  const container = (await composeProjectContainers(worktree)).find(
    (candidate) => runtimeContainerService(candidate) === service,
  );
  const exitCode = container?.State?.ExitCode;
  if (exitCode !== 0) {
    throw new Error(
      `Preview dependency task ${service} exited with code ${exitCode ?? "unknown"}`,
    );
  }
}

async function runProjectComposeSetupService(
  worktree: string,
  service: string,
  config: ComposeConfig,
) {
  const environment = composeSetupTaskEnvironment(config, service);
  const containerName = setupTaskContainerName(service);
  try {
    const result = await containerRuntime.compose(
      [
        ...composeArgs(worktree),
        "run",
        "--name",
        containerName,
        "--no-deps",
        "--interactive=false",
        ...Object.entries(environment).flatMap(([key, value]) => [
          "--env",
          `${key}=${value}`,
        ]),
        service,
      ],
      {
        cwd: worktree,
        env: await setupEnvironment(worktree),
        timeoutMs: composeSetupTimeoutMs,
      },
    );
    if (result.stdout)
      await appendRecoveryLog(worktree, result.stdout.trimEnd());
    if (result.stderr)
      await appendRecoveryLog(worktree, result.stderr.trimEnd());
    const [container] = await containerRuntime.inspect<RuntimeContainer>(
      [containerName],
      { timeoutMs: containerMetadataTimeoutMs },
    );
    const exitCode = container?.State?.ExitCode;
    if (exitCode !== 0) {
      throw new Error(
        `Preview setup task ${service} exited with code ${exitCode ?? "unknown"}`,
      );
    }
  } finally {
    await removeSetupTaskContainer(worktree, containerName);
  }
}

function setupTaskContainerName(service: string) {
  const id = service.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 24);
  return `blame-setup-${id}-${randomUUID().slice(0, 8)}`;
}

async function removeSetupTaskContainer(
  worktree: string,
  containerName: string,
) {
  try {
    await containerRuntime.container(["rm", "--force", containerName], {
      cwd: worktree,
      env: await setupEnvironment(worktree),
      timeoutMs: containerMetadataTimeoutMs,
    });
  } catch (error) {
    await appendRecoveryLog(
      worktree,
      `setup container cleanup failed: ${errorMessage(error).trim()}`,
    );
  }
}

function setupTaskServices(config: ComposeConfig) {
  return previewComposePlan(config).setupTasks;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

async function ensureGlobalPreviewVolumes(worktree: string) {
  const env = await setupEnvironment(worktree);
  await Promise.all(
    globalPreviewVolumes.map((volume) =>
      timedRecoveryStep(worktree, `compose volume create ${volume}`, () =>
        containerRuntime.volume(["create", volume], {
          cwd: worktree,
          env,
        }),
      ),
    ),
  );
}

function composeArgs(worktree: string) {
  return ["-f", projectComposePath(worktree), "--project-directory", worktree];
}

async function runComposeWithRetry(
  worktree: string,
  args: string[],
  retryDelays: number[],
  label: string,
  timeoutMs = composeStartTimeoutMs,
) {
  let cleanupAttempted = false;
  for (let attempt = 0; ; attempt += 1) {
    const start = Date.now();
    try {
      await containerRuntime.compose(args, {
        cwd: worktree,
        env: await setupEnvironment(worktree),
        timeoutMs,
      });
      await appendTimingLog(
        worktree,
        `${label} attempt ${attempt + 1} success`,
        Date.now() - start,
      );
      return;
    } catch (error) {
      await appendTimingLog(
        worktree,
        `${label} attempt ${attempt + 1} failed`,
        Date.now() - start,
      );
      if (!cleanupAttempted && runtimeAddressPoolExhausted(error)) {
        cleanupAttempted = true;
        await appendRecoveryLog(
          worktree,
          "container runtime address pools exhausted, cleaning abandoned Blame previews",
        );
        const projects = await cleanupAbandonedBlamePreviews();
        await appendRecoveryLog(
          worktree,
          projects.length
            ? `cleaned abandoned previews: ${projects.join(", ")}`
            : "no abandoned previews found",
        );
        continue;
      }
      const retryDelay = retryDelays[attempt];
      if (!retryDelay || !transientRuntimePullError(error)) throw error;
      await appendRecoveryLog(
        worktree,
        `${label} interrupted, retrying in ${Math.round(retryDelay / 1_000)}s`,
      );
      await delay(retryDelay);
    }
  }
}

async function waitForPreviewUrl(worktree: string) {
  const deadline = Date.now() + previewResolveTimeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (await previewRuntimeStopped(worktree)) return undefined;
    attempts += 1;
    const previewUrl = await resolveProjectPreviewUrl({ worktree });
    if (previewUrl) {
      await appendRecoveryLog(
        worktree,
        `preview url resolved after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      );
      return previewUrl;
    }
    await delay(previewStartupIntervalMs);
  }
  await appendRecoveryLog(
    worktree,
    `preview url resolve timed out after ${attempts} attempts`,
  );
  await appendComposeDiagnostics(worktree);
  throw new PreviewRuntimeError(
    "preview_url_timeout",
    "Unable to resolve project preview URL",
  );
}

async function stopProjectSetup(input: StopProjectSetupInput) {
  const worktree = resolveRuntimePath(input.worktree);
  await stopSetupRunsForWorktree(worktree);
  if (input.workspaceMode === "cloud-mirror" || input.workspaceMode === "direct")
    return true;
  const composePath = joinWorkspacePath(
    worktree,
    ".blame",
    "initialization",
    "docker-compose.yml",
  );
  if (!(await runtimePathExists(composePath))) return false;
  await repairComposeFile(worktree, composePath);
  try {
    await containerRuntime.compose(
      [
        "-f",
        composePath,
        "--project-directory",
        worktree,
        "down",
        "--remove-orphans",
      ],
      { cwd: worktree, env: await setupEnvironment(worktree) },
    );
    return true;
  } catch {
    return false;
  }
}

async function removeWorktree(input: RemoveWorktreeInput) {
  const repositoryRoot = resolveRuntimePath(input.repositoryRoot);
  const worktree = resolveRuntimePath(input.worktree);
  const mode = input.workspaceMode ?? "local-container";
  if (mode === "local-container")
    await ensureRuntimeGitSafeDirectory(repositoryRoot);
  await assertGitRepository(repositoryRoot);
  // Direct mode runs in the project folder: stop what runs there, never
  // delete it.
  if (mode === "direct" || (await isProjectFolder(repositoryRoot, worktree))) {
    await stopSetupRunsForWorktree(worktree);
    await stopProjectLogStream(worktree);
    await releaseAgentWorkspaceSessions(worktree);
    return true;
  }
  const registered = await worktreeRegistered(repositoryRoot, worktree, mode);
  const worktreeExists = await runtimePathExists(worktree);
  if (!registered && !worktreeExists) {
    if (mode === "local-container") {
      const env = await setupEnvironment(worktree);
      await removeBlamePreviewProjectResources(env.COMPOSE_PROJECT_NAME);
    }
    removedWorktrees.add(worktree);
    return true;
  }
  removingWorktrees.add(worktree);
  try {
    await stopSetupRunsForWorktree(worktree);
    await stopProjectLogStream(worktree);
    await releaseAgentWorkspaceSessions(worktree);
    previewRecoveries.delete(worktree);
    if (!input.projectSetupStopped)
      await stopProjectSetup({ workspaceMode: mode, worktree });
    if (mode === "local-container") {
      const env = await setupEnvironment(worktree);
      await removeBlamePreviewProjectResources(env.COMPOSE_PROJECT_NAME);
    }
    if (registered) await removeGitWorktree(repositoryRoot, worktree, mode);
    else await rmRuntime(worktree);
    removedWorktrees.add(worktree);
    return true;
  } finally {
    removingWorktrees.delete(worktree);
  }
}

async function resolveProjectPreviewUrl(input: ResolveProjectPreviewUrlInput) {
  const worktree = resolveRuntimePath(input.worktree);
  if (removedWorktrees.has(worktree)) return null;
  if (!(await isWorkspaceGitRepository(worktree))) return null;
  const [configurations, runtimeState, manifest] = await Promise.all([
    readProjectRunConfigurations(worktree),
    readPreviewRuntimeFileState(worktree),
    readProjectPreviewManifest(worktree),
  ]);
  if (runtimeState.desiredStatus === "stopped") return null;
  if (!shouldStartBrowserPreview(configurations, runtimeState, manifest)) {
    return null;
  }
  const composePath = projectComposePath(worktree);
  if (!(await runtimePathExists(composePath))) return null;
  const previewTarget = await composePreviewTarget(worktree, composePath);
  if (!previewTarget) return null;
  const address = await composePublishedAddress(
    worktree,
    composePath,
    previewTarget.service,
    previewTarget.port,
  );
  if (!address) return null;
  return previewUrl(address, previewTarget.protocol, previewTarget.path);
}

export async function localPreviewBridgeGrant(
  worktreeInput: string,
): Promise<DesktopBridgeGrant> {
  const worktree = resolveRuntimePath(worktreeInput);
  if (removedWorktrees.has(worktree))
    throw new Error("Local preview worktree was removed");
  if (!(await isWorkspaceGitRepository(worktree)))
    throw new Error("Local preview worktree is invalid");
  const composePath = projectComposePath(worktree);
  if (!(await runtimePathExists(composePath)))
    throw new Error("Local preview Compose configuration is missing");
  const config = await composeConfig(worktree, composePath);
  const primary = await composePreviewTarget(worktree, composePath);
  const endpoints = composeBridgeEndpoints(config, primary);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const sessionId = `local:${createHash("sha256")
    .update(worktree)
    .digest("hex")
    .slice(0, 24)}`;
  const routes = (
    await Promise.all(
      endpoints.map(async (endpoint) => {
        const address = await composePublishedAddress(
          worktree,
          composePath,
          endpoint.serviceId,
          endpoint.port,
        );
        if (!address) return undefined;
        const provider = localPreviewProvider(address, endpoint.protocol);
        const logicalPort = Number(provider.port);
        if (!Number.isSafeInteger(logicalPort) || logicalPort < 1) {
          return undefined;
        }
        return {
          routeId: `${sessionId}:${endpoint.serviceId}:${endpoint.endpointId}`,
          serviceId: endpoint.serviceId,
          endpointId: endpoint.endpointId,
          logicalHost: "localhost" as const,
          logicalPort,
          protocol: endpoint.protocol,
          providerUrl: provider.toString(),
          provider: "local" as const,
          capabilityExpiresAt: expiresAt,
        };
      }),
    )
  ).filter((route) => route !== undefined);
  const primaryRoute = primary
    ? routes.find(
        (route) =>
          route.serviceId === primary.service &&
          endpoints.find(
            (endpoint) =>
              endpoint.serviceId === route.serviceId &&
              endpoint.endpointId === route.endpointId,
          )?.port === primary.port,
      )
    : undefined;
  return {
    sessionId,
    endpointRevision: 1,
    integratedPreviewRequired: true,
    primaryRouteId: primaryRoute?.routeId ?? routes[0]?.routeId ?? "",
    routes,
  };
}

async function ensureProjectPreviewUrl(input: EnsureProjectPreviewUrlInput) {
  if (input.workspaceMode === "cloud-mirror" || input.workspaceMode === "direct")
    return null;
  const worktree = resolveRuntimePath(input.worktree);
  if (removedWorktrees.has(worktree)) return null;
  if (removingWorktrees.has(worktree)) return null;
  if (!(await isWorkspaceGitRepository(worktree))) return null;
  if (setupRunningForWorktree(worktree)) return null;
  const [configurations, runtimeState, manifest] = await Promise.all([
    readProjectRunConfigurations(worktree),
    readPreviewRuntimeFileState(worktree),
    readProjectPreviewManifest(worktree),
  ]);
  if (runtimeState.desiredStatus === "stopped") return null;
  if (!shouldStartBrowserPreview(configurations, runtimeState, manifest)) {
    return null;
  }
  const currentUrl = await resolveProjectPreviewUrl({ worktree });
  if (currentUrl && (await previewResponds(currentUrl))) {
    const currentOrigin = previewOrigin(currentUrl);
    const envMatches = await materializedPreviewEnvFilesMatch(
      worktree,
      currentOrigin,
      await projectPreviewEnvOverrides(worktree),
    );
    if (envMatches && (await previewProbesPass(worktree))) return currentUrl;
  }
  const recovery = previewRecoveries.get(worktree);
  if (recovery) return recovery;
  const configurationFingerprint =
    await previewRecoveryConfigurationFingerprint(
      worktree,
      configurations,
      runtimeState,
      manifest,
    );
  const decision = previewRecoveryCircuit.decision(
    worktree,
    configurationFingerprint,
  );
  if (!decision.allowed) {
    await appendRecoveryLog(
      worktree,
      `preview recovery deferred for ${decision.retryAfterMs}ms`,
    );
    return null;
  }
  getBlameTelemetry().count("blame.harness.preview_recoveries", 1, {});
  const nextRecovery = runPreviewRecovery(input, worktree, {
    reallocatePorts: Boolean(currentUrl),
  })
    .then((result) => {
      previewRecoveryCircuit.succeeded(worktree);
      return result;
    })
    .catch((error) => {
      getBlameTelemetry().count(
        "blame.harness.preview_recoveries_by_failure",
        1,
        {},
      );
      previewRecoveryCircuit.failed(
        worktree,
        configurationFingerprint,
        previewRecoveryFailureFingerprint(
          configurationFingerprint,
          configurations,
          runtimeState,
          error,
        ),
      );
      throw error;
    })
    .finally(() => {
      previewRecoveries.delete(worktree);
    });
  previewRecoveries.set(worktree, nextRecovery);
  return nextRecovery;
}

export async function projectPreviewRuntimeState(
  worktreeInput: string,
  workspaceMode: WorkspaceMode = "local-container",
): Promise<ProjectPreviewRuntimeState> {
  const worktree = resolveRuntimePath(worktreeInput);
  // No managed preview runs for these: report it as stopped.
  if (workspaceMode === "cloud-mirror" || workspaceMode === "direct") {
    return cloudMirrorPreviewRuntimeState(worktree);
  }
  const [configurations, runtimeState, containers, manifest] =
    await Promise.all([
      readProjectRunConfigurations(worktree),
      readPreviewRuntimeFileState(worktree),
      composeProjectContainers(worktree),
      readProjectPreviewManifest(worktree),
    ]);
  const selected = selectedPreviewRunConfiguration(
    configurations,
    runtimeState,
  );
  const runtimeContainers = containers.map(previewRuntimeContainerState);
  const statuses = previewConfigurationStatuses(
    configurations,
    runtimeContainers,
    runtimeState,
    manifest,
  );
  const previewUrl =
    runtimeState.desiredStatus === "running" && selected?.previewService
      ? ((await resolveProjectPreviewUrl({ worktree })) ?? undefined)
      : undefined;
  const lifecycle = localPreviewLifecycle(
    runtimeState,
    selected ? statuses[selected.id] : undefined,
    Boolean(selected?.previewService),
    previewUrl,
  );
  return {
    configurations,
    desiredStatus: runtimeState.desiredStatus,
    lifecycle,
    ...(previewUrl ? { previewUrl } : {}),
    ...(selected ? { selectedConfigurationId: selected.id } : {}),
    statuses,
  };
}

export async function projectPreviewLifecycleState(worktreeInput: string) {
  const worktree = resolveRuntimePath(worktreeInput);
  const persisted = await readPreviewRuntimeFileState(worktree);
  if (persisted.desiredStatus === "stopped") {
    if (
      persisted.lifecycle?.status === "error" ||
      persisted.lifecycle?.phase === "stopping"
    ) {
      return persisted.lifecycle;
    }
    return idleLocalPreviewLifecycle(persisted.lifecycle?.since);
  }
  if (persisted.lifecycle?.status === "error") {
    return persisted.lifecycle;
  }
  return (await projectPreviewRuntimeState(worktree)).lifecycle;
}

async function cloudMirrorPreviewRuntimeState(
  worktree: string,
): Promise<ProjectPreviewRuntimeState> {
  const [configurations, runtimeState] = await Promise.all([
    readProjectRunConfigurations(worktree),
    readPreviewRuntimeFileState(worktree),
  ]);
  const selected = selectedPreviewRunConfiguration(
    configurations,
    runtimeState,
  );
  return {
    configurations,
    desiredStatus: "stopped",
    lifecycle: idleLocalPreviewLifecycle(runtimeState.lifecycle?.since),
    ...(selected ? { selectedConfigurationId: selected.id } : {}),
    statuses: Object.fromEntries(
      configurations.map(({ id }) => [id, "stopped"]),
    ),
  };
}

function previewConfigurationStatuses(
  configurations: ProjectRunConfiguration[],
  containers: ReturnType<typeof previewRuntimeContainerState>[],
  runtimeState: PreviewRuntimeSelectionState,
  manifest: PreviewManifest | undefined,
) {
  return Object.fromEntries(
    configurations.map((configuration) => [
      configuration.id,
      previewRunConfigurationStatus(
        previewStatusConfiguration(configuration, manifest),
        containers,
        runtimeState,
      ),
    ]),
  );
}

function previewStatusConfiguration(
  configuration: ProjectRunConfiguration,
  manifest: PreviewManifest | undefined,
) {
  if (!manifest) return configuration;
  return {
    ...configuration,
    services: previewRunConfigurationServiceIds(configuration, manifest),
  };
}

export async function controlProjectPreview(input: ControlProjectPreviewInput) {
  const selection = await previewControlSelection(input);
  await appendRecoveryLog(
    selection.worktree,
    `run configuration ${input.action}: ${selection.selected.id}`,
  );
  if (input.action === "stop") return stopProjectPreview(selection);
  previewRecoveryCircuit.reset(selection.worktree);
  return startProjectPreview(selection, input.action === "restart");
}

export async function refreshProjectPreviewDependencies(worktreeInput: string) {
  const worktree = resolveRuntimePath(worktreeInput);
  const state = await readPreviewRuntimeFileState(worktree);
  if (state.desiredStatus !== "running")
    return { status: "not_running" as const };
  await refreshProjectDependencyArtifacts(worktree);
  previewRecoveryCircuit.reset(worktree);
  await controlProjectPreview({ action: "restart", worktree });
  return { status: "ready" as const };
}

export async function applyProjectPreviewInitialization(
  input: ApplyProjectPreviewInitializationInput,
) {
  const worktree = resolveRuntimePath(input.worktree);
  const state = await readPreviewRuntimeFileState(worktree);
  if (state.desiredStatus === "running") {
    await controlProjectPreview({ action: "stop", worktree });
  }
  await prepareProjectPreviewArtifacts({
    executionId: `preview-repair:${input.storyId}`,
    storyId: input.storyId,
    worktree,
    previewManifest: input.previewManifest,
    runConfigurations: input.runConfigurations,
    runConfigurationId:
      state.desiredStatus === "running"
        ? state.selectedConfigurationId
        : undefined,
    hostDependenciesChecked: true,
    runtimeProfile: "local-container",
  });
  if (state.desiredStatus === "running") {
    await controlProjectPreview({ action: "start", worktree });
    await writeProjectPreviewRepairCandidate(worktree, input);
  }
}

async function writeProjectPreviewRepairCandidate(
  worktree: string,
  input: ApplyProjectPreviewInitializationInput,
) {
  const sourceTree = await gitSnapshot({
    id: `preview-repair-${input.storyId}`,
    root: worktree,
  });
  await writeRuntimeJson(
    joinWorkspacePath(
      worktree,
      ".blame",
      "initialization",
      "preview-repair.json",
    ),
    {
      databaseMode: input.databaseMode,
      previewManifest: input.previewManifest,
      reason: input.reason,
      repairSessionId: input.repairSessionId,
      runConfigurations: input.runConfigurations,
      sourceTree,
    },
  );
}

async function refreshProjectDependencyArtifacts(worktree: string) {
  const [manifest, runConfigurations, state] = await Promise.all([
    readProjectPreviewManifest(worktree),
    readProjectRunConfigurations(worktree),
    readPreviewRuntimeFileState(worktree),
  ]);
  if (!manifest) return repairProjectCompose(worktree);
  await prepareProjectPreviewArtifacts({
    executionId: "preview-dependency-refresh",
    storyId: "preview-dependency-refresh",
    worktree,
    previewManifest: manifest,
    runConfigurations,
    runConfigurationId: state.selectedConfigurationId,
    hostDependenciesChecked: true,
    runtimeProfile: "local-container",
  });
}

async function previewRecoveryConfigurationFingerprint(
  worktree: string,
  configurations: ProjectRunConfiguration[],
  runtimeState: PreviewRuntimeSelectionState,
  manifest: PreviewManifest | undefined,
) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      configurations,
      desiredStatus: runtimeState.desiredStatus,
      manifest,
      selectedConfigurationId: runtimeState.selectedConfigurationId,
    }),
  );
  for (const { content, file } of await previewRecoveryFingerprintFiles(
    worktree,
  )) {
    hash.update("\0");
    hash.update(file);
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
}

async function previewRecoveryFingerprintFiles(worktree: string) {
  const paths = await dependencyInputPaths(worktree);
  const contents = await readExistingRuntimeFiles(
    paths.map(({ path }) => path),
  );
  return paths.flatMap(({ file, path }) => {
    const content = contents[path];
    return typeof content === "string" ? [{ content, file }] : [];
  });
}

function previewRecoveryFailureFingerprint(
  configurationFingerprint: string,
  configurations: ProjectRunConfiguration[],
  runtimeState: PreviewRuntimeSelectionState,
  error: unknown,
) {
  const diagnostic = errorMessage(error).trim().split(/\r?\n/u, 1)[0] ?? "";
  const selected = configurations.find(
    ({ id }) => id === runtimeState.selectedConfigurationId,
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: selected?.command,
        configurationFingerprint,
        diagnostic,
        errorType: operationErrorType(error),
        exitCode: previewRecoveryExitCode(error),
        service: selected?.previewService ?? selected?.services[0],
      }),
    )
    .digest("hex");
}

function previewRecoveryExitCode(error: unknown) {
  if (error && typeof error === "object") {
    const value = "exitCode" in error ? error.exitCode : undefined;
    if (typeof value === "number") return value;
  }
  const match = errorMessage(error).match(/exited? with code (\d+)/iu);
  return match ? Number(match[1]) : undefined;
}

async function previewControlSelection(input: ControlProjectPreviewInput) {
  assertPreviewRunnerAction(input.action);
  const worktree = resolveRuntimePath(input.worktree);
  const configurations = await readProjectRunConfigurations(worktree);
  const state = await readPreviewRuntimeFileState(worktree);
  const current = selectedPreviewRunConfiguration(configurations, state);
  const selected = input.configurationId
    ? configurations.find(({ id }) => id === input.configurationId)
    : current;
  if (!selected) throw new Error("Preview run configuration not found");
  return {
    current,
    selected,
    worktree,
  } satisfies PreviewControlSelection;
}

async function stopProjectPreview(selection: PreviewControlSelection) {
  const { current, selected, worktree } = selection;
  return runLocalPreviewOperation(
    worktree,
    selected.id,
    "stopped",
    "stopping",
    async () => {
      if (current && current.id !== selected.id) {
        await stopRunConfigurationServices(worktree, current);
      }
      await stopRunConfigurationServices(worktree, selected);
      return projectPreviewRuntimeState(worktree);
    },
    writePreviewRuntimeState,
  );
}

async function startProjectPreview(
  selection: PreviewControlSelection,
  restart: boolean,
) {
  const { current, selected, worktree } = selection;
  return runLocalPreviewOperation(
    worktree,
    selected.id,
    "running",
    restart ? "stopping" : "starting",
    async () => {
      if (current && current.id !== selected.id) {
        await stopRunConfigurationServices(worktree, current);
      }
      if (restart) {
        await stopRunConfigurationServices(worktree, selected);
        await writePreviewRuntimeState(worktree, {
          desiredStatus: "running",
          lifecycle: pendingLocalPreviewLifecycle("starting"),
          selectedConfigurationId: selected.id,
        });
      }
      await stopInactiveRunConfigurationServices(worktree, selected);
      await startProjectCompose(worktree);
      return projectPreviewRuntimeState(worktree);
    },
    writePreviewRuntimeState,
  );
}

function assertPreviewRunnerAction(action: string) {
  if (action === "start" || action === "stop" || action === "restart") return;
  throw new Error("Preview runner action is invalid");
}

async function stopRunConfigurationServices(
  worktree: string,
  configuration: ProjectRunConfiguration,
) {
  const services = await runConfigurationServiceIds(worktree, configuration);
  await stopComposeServices(worktree, services);
}

async function stopInactiveRunConfigurationServices(
  worktree: string,
  configuration: ProjectRunConfiguration,
) {
  const config = await composeConfig(worktree, projectComposePath(worktree));
  const active = new Set(
    await runConfigurationServiceIds(worktree, configuration),
  );
  const inactive = composeRuntimeServices(config).filter(
    (service) => !active.has(service),
  );
  await stopComposeServices(worktree, inactive);
}

async function runConfigurationServiceIds(
  worktree: string,
  configuration: ProjectRunConfiguration,
) {
  const manifest = await readProjectPreviewManifest(worktree);
  if (!manifest) {
    throw new PreviewRuntimeError(
      "preview_manifest_invalid",
      "A canonical preview manifest is required",
    );
  }
  return previewRunConfigurationServiceIds(configuration, manifest);
}

async function stopComposeServices(worktree: string, services: string[]) {
  if (!services.length) return;
  await containerRuntime.compose(
    [
      ...composeArgs(worktree),
      "stop",
      "--timeout",
      String(previewStopTimeoutSeconds),
      ...services,
    ],
    { cwd: worktree, env: await setupEnvironment(worktree) },
  );
}

function composeRuntimeServices(config: ComposeConfig) {
  return previewComposePlan(config).runtimeServices;
}

function composeServiceDependencies(service: ComposeService | undefined) {
  if (!service?.depends_on) return [];
  return Array.isArray(service.depends_on)
    ? service.depends_on
    : Object.keys(service.depends_on);
}

async function stopPreviewStartWhenRequested(worktree: string) {
  const state = await readPreviewRuntimeFileState(worktree);
  if (state.desiredStatus === "running") return false;
  const configurations = await readProjectRunConfigurations(worktree);
  const selected = selectedPreviewRunConfiguration(configurations, state);
  if (selected) await stopRunConfigurationServices(worktree, selected);
  return true;
}

async function previewRuntimeStopped(worktree: string) {
  return (
    (await readPreviewRuntimeFileState(worktree)).desiredStatus === "stopped"
  );
}

async function readProjectRunConfigurations(worktree: string) {
  const path = projectRunConfigurationsPath(worktree);
  if (!(await runtimePathExists(path))) return [];
  return parseRunConfigurations(JSON.parse(await readRuntimeFile(path)));
}

async function readPreviewRuntimeFileState(
  worktree: string,
): Promise<PreviewRuntimeSelectionState> {
  const path = projectPreviewRuntimeStatePath(worktree);
  if (!(await runtimePathExists(path))) return { desiredStatus: "stopped" };
  try {
    return parseLocalPreviewRuntimeSelectionState(
      JSON.parse(await readRuntimeFile(path)),
    );
  } catch {
    return { desiredStatus: "stopped" };
  }
}

function writePreviewRuntimeState(
  worktree: string,
  state: PreviewRuntimeSelectionState,
) {
  return writeRuntimeJson(projectPreviewRuntimeStatePath(worktree), state);
}

function runtimeContainerService(container: RuntimeContainer) {
  return container.Config?.Labels?.["com.docker.compose.service"] ?? "";
}

function previewRuntimeContainerState(container: RuntimeContainer) {
  return {
    exitCode: container.State?.ExitCode,
    health: container.State?.Health?.Status,
    service: runtimeContainerService(container),
    status: container.State?.Status,
  };
}

async function previewProbesPass(worktree: string) {
  try {
    await runPreviewProbes(worktree);
    return true;
  } catch (error) {
    await appendRecoveryLog(
      worktree,
      `preview functional check failed: ${operationErrorType(error)}`,
    );
    return false;
  }
}

function setupRunningForWorktree(worktree: string) {
  return Array.from(setupRuns.values()).some(
    (run) => run.worktree === worktree,
  );
}

async function projectSetupCompleted(worktree: string) {
  try {
    const log = await readRuntimeFile(setupLogPath(worktree));
    return (
      log.includes("Project preview containers are running.") ||
      log.includes("[setup exited with code 0]")
    );
  } catch {
    return false;
  }
}

async function runPreviewRecovery(
  input: EnsureProjectPreviewUrlInput,
  worktree: string,
  options: { reallocatePorts?: boolean },
) {
  const operation = beginExecutionOperation(
    input,
    previewStartOperationName,
    worktree,
  );
  void enrichExecutionRepositoryCohorts(operation, worktree);
  const action = () => recoverProjectPreview(worktree, options);
  return runExecutionOperation(operation, action, (result) =>
    result ? "succeeded" : "canceled",
  );
}

async function recoverProjectPreview(
  worktree: string,
  options: { reallocatePorts?: boolean } = {},
) {
  if (await previewRuntimeStopped(worktree)) return null;
  if (removedWorktrees.has(worktree)) return null;
  if (removingWorktrees.has(worktree)) return null;
  if (await previewRuntimeStopped(worktree)) return null;
  await appendRecoveryLog(worktree, "compose starting");
  try {
    const previewUrl = await startProjectCompose(worktree, options);
    await appendRecoveryLog(
      worktree,
      previewUrl ? `preview ready at ${previewUrl}` : "run configuration ready",
    );
    return previewUrl ?? null;
  } catch (error) {
    await stopProjectLogStream(worktree);
    await appendRecoveryLog(worktree, errorMessage(error).trim());
    throw error;
  }
}

async function runExistingProjectSetup(worktree: string) {
  const scriptPath = joinWorkspacePath(
    worktree,
    ".blame",
    "initialization",
    "setup.sh",
  );
  if (!(await runtimePathExists(scriptPath))) return;
  await appendRecoveryLog(worktree, "setup starting");
  const env = await setupEnvironment(worktree);
  await new Promise<void>((resolve, reject) => {
    const child = spawnRuntime("bash", [scriptPath], {
      cwd: worktree,
      env,
    });
    trackWorkspaceProcess(child);
    child.stdout.on("data", (data: Buffer) =>
      appendRecoveryOutput(worktree, data),
    );
    child.stderr.on("data", (data: Buffer) =>
      appendRecoveryOutput(worktree, data),
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      void appendRecoveryLog(worktree, `setup exited with code ${code ?? ""}`);
      if (code === 0) resolve();
      else reject(new Error(`Project setup exited with code ${code ?? ""}`));
    });
  });
}

export async function shutdownWorkspaceProcesses() {
  const activeProcesses = Array.from(workspaceProcesses);
  Array.from(setupRuns.values()).forEach((run) =>
    finishSetupRun(run, "canceled"),
  );
  setupRuns.clear();
  projectLogStreams.clear();
  projectServiceLogStreams.clear();
  workspaceProcesses.clear();
  await Promise.all(activeProcesses.map(stopChildProcess));
  await cleanupAbandonedBlamePreviews();
}

function trackWorkspaceProcess(child: ChildProcessWithoutNullStreams) {
  workspaceProcesses.add(child);
  child.once("exit", () => workspaceProcesses.delete(child));
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams) {
  killChildProcess(child, "SIGTERM");
  await waitForExit(child);
}

async function stopSetupRunsForWorktree(worktree: string) {
  const runs = Array.from(setupRuns.values()).filter(
    (run) => run.worktree === worktree,
  );
  await Promise.all(
    runs.map(async (run) => {
      finishSetupRun(run, "canceled");
      await stopChildProcess(run.process);
    }),
  );
}

async function listProjectServices(worktreeInput: string) {
  const worktree = resolveRuntimePath(worktreeInput);
  const composePath = projectComposePath(worktree);
  try {
    if (await runtimePathExists(composePath)) {
      return composeRuntimeServiceNames(await readRuntimeFile(composePath));
    }
  } catch {}
  return listProjectServicesWithCompose(worktree);
}

async function listProjectServicesWithCompose(worktree: string) {
  const config = await composeConfig(worktree, projectComposePath(worktree));
  return composeRuntimeServices(config).sort(serviceSort);
}

function composeRuntimeServiceNames(compose: string) {
  const parsed = parseYaml(compose) as unknown;
  if (!parsed || typeof parsed !== "object") return [];
  return composeRuntimeServices(parsed as ComposeConfig).sort(serviceSort);
}

async function startProjectServiceLogs(input: ProjectServiceLogsInput) {
  const worktree = resolveRuntimePath(input.worktree);
  const streamId = randomUUID();
  const stream = {
    hasOutput: false,
    service: input.service,
    stopped: false,
    worktree,
  };
  projectServiceLogStreams.set(streamId, stream);
  setTimeout(() => {
    void startProjectServiceLogProcess(streamId, stream).catch((error) =>
      emitProjectServiceLog(streamId, "stderr", errorMessage(error)),
    );
  }, 0);
  return { streamId };
}

async function startProjectServiceLogProcess(
  streamId: string,
  stream: ProjectServiceLogStream,
) {
  if (stream.stopped || projectServiceLogStreams.get(streamId) !== stream)
    return;
  const child = containerRuntime.spawnCompose(
    [
      ...composeArgs(stream.worktree),
      "logs",
      "--tail",
      "120",
      "--follow",
      stream.service,
    ],
    {
      cwd: stream.worktree,
      env: await setupEnvironment(stream.worktree),
    },
  );
  stream.process = child;
  trackWorkspaceProcess(child);
  child.stdout.on("data", (data: Buffer) => {
    stream.hasOutput = true;
    emitProjectServiceLog(streamId, "stdout", data.toString());
  });
  child.stderr.on("data", (data: Buffer) => {
    stream.hasOutput = true;
    emitProjectServiceLog(streamId, "stderr", data.toString());
  });
  child.once("error", (error) => {
    emitProjectServiceLog(streamId, "stderr", errorMessage(error));
  });
  child.once("exit", (code) => {
    if (projectServiceLogStreams.get(streamId) !== stream) return;
    stream.process = undefined;
    if (stream.stopped || stream.hasOutput) {
      projectServiceLogStreams.delete(streamId);
      emitProjectServiceLog(streamId, "exit", String(code ?? ""));
      return;
    }
    void fallbackProjectServiceLog(streamId, stream, code);
  });
}

async function fallbackProjectServiceLog(
  streamId: string,
  stream: ProjectServiceLogStream,
  code: number | null,
) {
  if (await emitArchivedProjectServiceLog(streamId, stream)) {
    projectServiceLogStreams.delete(streamId);
    emitProjectServiceLog(streamId, "exit", String(code ?? ""));
    return;
  }
  stream.retry = setTimeout(() => {
    void startProjectServiceLogProcess(streamId, stream).catch((error) =>
      emitProjectServiceLog(streamId, "stderr", errorMessage(error)),
    );
  }, 1_000);
}

async function emitArchivedProjectServiceLog(
  streamId: string,
  stream: ProjectServiceLogStream,
) {
  const content = await archivedProjectServiceLog(
    stream.worktree,
    stream.service,
  );
  if (!content) return false;
  stream.hasOutput = true;
  emitProjectServiceLog(streamId, "stdout", content);
  return true;
}

async function archivedProjectServiceLog(worktree: string, service: string) {
  try {
    const log = await readRuntimeFile(setupLogPath(worktree));
    return archivedServiceLogSection(log, service);
  } catch {
    return "";
  }
}

function archivedServiceLogSection(log: string, service: string) {
  const normalized = normalizedServiceName(service);
  const lines = log
    .split("\n")
    .filter((line) => archivedServiceLogLine(line, normalized));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function archivedServiceLogLine(line: string, service: string) {
  const normalized = normalizedServiceName(line);
  if (service === "deps")
    return (
      /\bdeps(?:-|_)?run\b/.test(normalized) ||
      /\bservice deps\b/.test(normalized)
    );
  return normalized.includes(service);
}

function normalizedServiceName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function stopProjectServiceLogs(streamId: string) {
  const stream = projectServiceLogStreams.get(streamId);
  if (!stream) return false;
  stream.stopped = true;
  if (stream.retry) clearTimeout(stream.retry);
  projectServiceLogStreams.delete(streamId);
  if (stream.process) await stopChildProcess(stream.process);
  return true;
}

export async function readProjectServiceLogs(input: {
  service?: string;
  tailLines?: number;
  timeoutMs?: number;
  worktree: string;
}) {
  const worktree = resolveRuntimePath(input.worktree);
  const services = await listProjectServices(worktree);
  const service = selectedProjectService(input.service, services);
  if (!service) {
    return {
      available: false,
      reason: input.service
        ? `Service "${input.service}" was not found.`
        : "No services found yet.",
      services,
    };
  }
  const snapshot = await projectServiceLogSnapshot(
    worktree,
    service,
    input.tailLines,
    input.timeoutMs,
  );
  return { service, services, ...snapshot };
}

async function projectServiceLogSnapshot(
  worktree: string,
  service: string,
  tailLines?: number,
  timeoutMs?: number,
) {
  const lineCount = serviceLogTailLines(tailLines);
  try {
    const { stdout, stderr } = await containerRuntime.compose(
      [...composeArgs(worktree), "logs", "--tail", String(lineCount), service],
      {
        cwd: worktree,
        env: await setupEnvironment(worktree),
        timeoutMs: timeoutMs ?? containerMetadataTimeoutMs,
      },
    );
    if (stdout || stderr)
      return { available: true, source: "container", stderr, stdout };
  } catch (error) {
    return projectServiceLogFallback(worktree, service, error);
  }
  return projectServiceLogFallback(worktree, service);
}

async function projectServiceLogFallback(
  worktree: string,
  service: string,
  error?: unknown,
) {
  const archived = await archivedProjectServiceLog(worktree, service);
  if (archived)
    return {
      available: false,
      reason:
        "The container log command failed; archived setup logs are shown.",
      source: "setup-log",
      stderr: "",
      stdout: archived,
    };
  return {
    available: false,
    reason: "The container log command did not return usable logs.",
    source: "container",
    stderr: error ? commandErrorText(error).trim() : "",
    stdout: "",
  };
}

function selectedProjectService(
  service: string | undefined,
  services: string[],
) {
  if (!service) return services[0];
  return services.includes(service) ? service : undefined;
}

function serviceLogTailLines(value: number | undefined) {
  if (!Number.isFinite(value)) return 120;
  return Math.min(Math.max(Math.trunc(value ?? 120), 1), 1000);
}

function serviceSort(left: string, right: string) {
  return (
    servicePriority(left) - servicePriority(right) || left.localeCompare(right)
  );
}

function servicePriority(service: string) {
  if (/front|web|app/i.test(service)) return 0;
  if (/back|api|server/i.test(service)) return 1;
  if (/migrat/i.test(service)) return 2;
  if (/db|postgres|mysql|mongo|redis/i.test(service)) return 3;
  if (/install|deps|depend|init|volume/i.test(service)) return 4;
  return 5;
}

async function startProjectLogStream(worktree: string) {
  await stopProjectLogStream(worktree);
  await appendRunLogSection(worktree, "container logs");
  const stream = { stopped: false };
  projectLogStreams.set(worktree, stream);
  await startProjectLogProcess(worktree, stream);
}

async function startProjectLogProcess(
  worktree: string,
  stream: ProjectLogStream,
) {
  if (stream.stopped) return;
  const process = containerRuntime.spawnCompose(
    [...composeArgs(worktree), "logs", "--tail", "120", "--follow"],
    {
      cwd: worktree,
      env: await setupEnvironment(worktree),
    },
  );
  stream.process = process;
  trackWorkspaceProcess(process);
  process.stdout.on("data", (data: Buffer) =>
    appendRecoveryOutput(worktree, data),
  );
  process.stderr.on("data", (data: Buffer) =>
    appendRecoveryOutput(worktree, data),
  );
  process.once("error", (error) => {
    void appendRunLogSection(worktree, errorMessage(error).trim());
  });
  process.once("exit", () => {
    if (projectLogStreams.get(worktree) !== stream) return;
    stream.process = undefined;
    if (stream.stopped) projectLogStreams.delete(worktree);
    else
      stream.retry = setTimeout(() => {
        void startProjectLogProcess(worktree, stream).catch((error) => {
          void appendRunLogSection(worktree, errorMessage(error).trim());
        });
      }, 1_000);
  });
}

async function stopProjectLogStream(worktree: string) {
  const stream = projectLogStreams.get(worktree);
  if (!stream) return;
  stream.stopped = true;
  if (stream.retry) clearTimeout(stream.retry);
  projectLogStreams.delete(worktree);
  if (stream.process) await stopChildProcess(stream.process);
}

async function appendRunLogSection(worktree: string, message: string) {
  await mkdirRuntime(dirnameWorkspacePath(setupLogPath(worktree)));
  await appendRuntimeFile(setupLogPath(worktree), `\n[${message}]\n`);
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      killChildProcess(child, "SIGKILL");
      resolve();
    }, forceKillDelayMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killChildProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

function appendRecoveryOutput(worktree: string, data: Buffer) {
  void appendRuntimeFile(setupLogPath(worktree), data.toString());
}

async function appendRecoveryLog(worktree: string, message: string) {
  await mkdirRuntime(dirnameWorkspacePath(setupLogPath(worktree)));
  await appendRuntimeFile(setupLogPath(worktree), `\n[recovery ${message}]\n`);
}

async function timedRecoveryStep<T>(
  worktree: string,
  label: string,
  action: () => Promise<T> | T,
) {
  const start = Date.now();
  const step = localPreviewStartStep(label);
  if (step) await recordPreviewStartStep(worktree, step);
  try {
    return await traceWorkspaceStep(label, action);
  } finally {
    await appendTimingLog(worktree, label, Date.now() - start);
  }
}

async function recordPreviewStartStep(worktree: string, step: string) {
  try {
    const state = await readPreviewRuntimeFileState(worktree);
    const lifecycle = state.lifecycle;
    if (lifecycle?.status !== "pending" || lifecycle.phase !== "starting") return;
    await writePreviewRuntimeState(worktree, {
      ...state,
      lifecycle: { ...lifecycle, step },
    });
  } catch {}
}

async function appendTimingLog(
  worktree: string,
  label: string,
  duration: number,
) {
  try {
    await appendRecoveryLog(worktree, `timing ${label}: ${duration}ms`);
    await appendRuntimeFile(
      timingLogPath(worktree),
      `${JSON.stringify({
        at: new Date().toISOString(),
        durationMs: duration,
        label,
      })}\n`,
    );
  } catch {}
}

async function walk(
  root: string,
  directory: string,
  query: string,
  limit: number,
  matches: Array<{ name: string; path: string; type: "file" }>,
) {
  if (matches.length >= limit) return;
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (matches.length >= limit || shouldSkip(entry.name)) continue;
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, entryPath, query, limit, matches);
      continue;
    }
    const relativePath = toWorkspacePath(root, entryPath);
    if (
      entry.isFile() &&
      (normalizeWorkspaceSearchText(entry.name).includes(query) ||
        normalizeWorkspaceSearchText(relativePath).includes(query))
    ) {
      matches.push({
        name: entry.name,
        path: relativePath,
        type: "file",
      });
    }
  }
}

function normalizeWorkspaceSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function resolveWorkspacePath(input: WorkspacePathInput) {
  const root = resolveRuntimePath(input.root);
  const target = joinWorkspacePath(root, input.path ?? ".");
  const separator = root.includes("/") ? "/" : sep;
  if (target !== root && !target.startsWith(`${root}${separator}`))
    throw new Error("Path escapes workspace");
  return target;
}

function toWorkspacePath(root: string, target: string) {
  const resolvedRoot = resolveRuntimePath(root);
  const path = resolvedRoot.includes("/")
    ? posix.relative(resolvedRoot, target.replace(/\\/g, "/"))
    : relative(resolve(root), target);
  return path || ".";
}

function shouldSkip(name: string) {
  return [".git", "node_modules", "dist", "build", ".turbo"].includes(name);
}

async function assertGitRepository(cwd: string) {
  await runRuntimeGit(cwd, ["rev-parse", "--show-toplevel"]);
}

async function ensureWorkspaceGitRepository(root: string) {
  if (!runtimeManagedPath(root)) return ensureGitRepository(root);
  if (await isWorkspaceGitRepository(root)) return false;
  await runRuntime("git", ["init"], { cwd: root });
  return true;
}

async function isWorkspaceGitRepository(root: string) {
  if (!runtimeManagedPath(root)) return isGitRepository(root);
  try {
    await assertGitRepository(root);
    return true;
  } catch {
    return false;
  }
}

async function removeGitWorktree(
  repositoryRoot: string,
  worktree: string,
  mode: WorkspaceMode,
) {
  await assertRemovableWorktree(repositoryRoot, worktree);
  if (mode === "local-container")
    await ensureRuntimeGitSafeDirectory(repositoryRoot);
  try {
    await runRuntimeGit(
      repositoryRoot,
      storyWorktreeRemoveArguments(worktree),
      workspaceExecution(mode),
    );
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      await removeStaleGitWorktree(repositoryRoot, worktree, mode);
      return;
    }
    if (!isDirectoryNotEmptyError(error)) throw error;
    if (await worktreeRegistered(repositoryRoot, worktree, mode)) throw error;
  }

  await rmRuntime(worktree);
}

async function assertRemovableWorktree(repositoryRoot: string, worktree: string) {
  if (await isProjectFolder(repositoryRoot, worktree))
    throw new Error(`Refusing to delete the project folder ${worktree}.`);
}

async function removeStaleGitWorktree(
  repositoryRoot: string,
  worktree: string,
  mode: WorkspaceMode,
) {
  await assertRemovableWorktree(repositoryRoot, worktree);
  await rmRuntime(worktree);
  if (await worktreeRegistered(repositoryRoot, worktree, mode)) {
    await runRuntimeGit(
      repositoryRoot,
      storyWorktreeRemoveArguments(worktree),
      workspaceExecution(mode),
    );
  }
  if (await worktreeRegistered(repositoryRoot, worktree, mode))
    throw new Error("Unable to unregister worktree.");
}

function isDirectoryNotEmptyError(error: unknown) {
  return commandText(error, "stderr").includes("Directory not empty");
}

function isPermissionDeniedError(error: unknown) {
  return commandErrorText(error).includes("Permission denied");
}

function transientRuntimePullError(error: unknown) {
  return /failed to copy|httpReadSeeker|unexpected EOF|\bEOF\b|TLS handshake timeout|connection reset|i\/o timeout|context deadline exceeded|cloudfront\.docker\.com/i.test(
    commandErrorText(error),
  );
}

function commandErrorText(error: unknown) {
  return [
    errorMessageText(error),
    commandText(error, "stdout"),
    commandText(error, "stderr"),
  ].join("\n");
}

function errorMessageText(error: unknown) {
  return error instanceof Error ? error.message : "";
}

async function setupEnvironment(worktree: string) {
  const cached = setupEnvironmentCache.get(worktree);
  const now = Date.now();
  if (cached?.promise) return cached.promise;
  if (cached?.env && now - cached.ts < setupEnvironmentCacheTtlMs)
    return cached.env;
  const promise = buildSetupEnvironment(worktree);
  setupEnvironmentCache.set(worktree, {
    promise,
    ts: now,
    env: cached?.env,
  });
  try {
    const env = await promise;
    setupEnvironmentCache.set(worktree, { env, ts: Date.now() });
    return env;
  } catch (error) {
    setupEnvironmentCache.delete(worktree);
    throw error;
  }
}

async function buildSetupEnvironment(
  worktree: string,
): Promise<SetupEnvironment> {
  const hostEnvironment = withoutTelemetryEnvironment(process.env);
  const environment = {
    ...containerRuntimeEnvironment(hostEnvironment),
    ...(await worktreeRuntimeEnvironment(worktree)),
    ...hostEnvironment,
    BLAME_HOST_GID: hostGroupId(),
    BLAME_HOST_UID: hostUserId(),
    CI: "true",
    BLAME_DOCKER_COMPOSE_FILE: projectComposePath(worktree),
    BLAME_INITIALIZATION_DIR: joinWorkspacePath(
      worktree,
      ".blame",
      "initialization",
    ),
    BLAME_PROJECT_ROOT: worktree,
    BLAME_WORKTREE_ROOT: worktree,
    COMPOSE_PROJECT_NAME: previewComposeProjectName(worktree),
    npm_config_yes: "true",
    PATH: setupPath(),
  };
  return withoutTelemetryEnvironment(environment) as SetupEnvironment;
}

function invalidateSetupEnvironment(worktree: string) {
  setupEnvironmentCache.delete(worktree);
}

function runtimeManagerEnvironment() {
  return {
    ...withoutTelemetryEnvironment(process.env),
    PATH: setupPath(),
  };
}

async function worktreeRuntimeEnvironment(worktree: string) {
  if (!worktree) return {};
  const environment: Record<string, string> = {};
  const envFiles = await worktreeRuntimeEnvFiles(worktree);
  const envValues = await Promise.all(envFiles.map(runtimeEnvValues));
  for (const values of envValues) {
    Object.assign(environment, values);
  }
  return environment;
}

async function worktreeRuntimeEnvFiles(root: string) {
  const files: string[] = [];
  await collectRuntimeEnvFiles(root, files);
  return files.sort();
}

async function collectRuntimeEnvFiles(directory: string, files: string[]) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredRuntimeEnvDirectory(entry.name)) {
          await collectRuntimeEnvFiles(path, files);
        }
        return;
      }
      if (entry.isFile() && runtimeEnvFile(entry.name)) {
        files.push(path);
      }
    }),
  );
}

async function runtimeEnvValues(path: string) {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match && match[2].trim()) values[match[1]] = match[2];
  }
  return values;
}

function ignoredRuntimeEnvDirectory(name: string) {
  return [
    ".git",
    ".blame",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
  ].includes(name);
}

function runtimeEnvFile(name: string) {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return ![".example", ".sample", ".template"].some((suffix) =>
    name.endsWith(suffix),
  );
}

function hostUserId() {
  return typeof process.getuid === "function"
    ? String(process.getuid())
    : "1000";
}

function hostGroupId() {
  return typeof process.getgid === "function"
    ? String(process.getgid())
    : "1000";
}

function projectComposePath(worktree: string) {
  return joinWorkspacePath(
    worktree,
    ".blame",
    "initialization",
    "docker-compose.yml",
  );
}

function projectPreviewManifestPath(worktree: string) {
  return joinWorkspacePath(
    worktree,
    ".blame",
    "initialization",
    "preview-manifest.json",
  );
}

function projectRunConfigurationsPath(worktree: string) {
  return joinWorkspacePath(
    worktree,
    ".blame",
    "initialization",
    "run-configurations.json",
  );
}

function projectPreviewRuntimeStatePath(worktree: string) {
  return joinWorkspacePath(
    worktree,
    ".blame",
    "initialization",
    "preview-runtime-state.json",
  );
}

function setupLogPath(worktree: string) {
  return joinWorkspacePath(worktree, ".blame", "logs", "setup.log");
}

function timingLogPath(worktree: string) {
  return joinWorkspacePath(worktree, ".blame", "logs", "timing.jsonl");
}

async function composePreviewTarget(worktree: string, composePath: string) {
  const config = await composeConfig(worktree, composePath);
  const services = Object.entries(config.services ?? {});
  const selectedService = await selectedPreviewServiceId(worktree);
  const labeledTarget = services
    .map(([service, config]) => labeledPreviewTarget(service, config))
    .sort((left, right) =>
      previewTargetSelectionOrder(left, right, selectedService),
    )
    .find(Boolean);
  if (labeledTarget) return labeledTarget;
  return services
    .map(([service, config]) => exposedPreviewTarget(service, config))
    .find(Boolean);
}

type ComposeBridgeEndpoint = {
  endpointId: string;
  port: number;
  protocol: "http" | "https" | "ws" | "wss";
  serviceId: string;
};

function composeBridgeEndpoints(
  config: ComposeConfig,
  primary: Awaited<ReturnType<typeof composePreviewTarget>>,
) {
  const endpoints = Object.entries(config.services ?? {}).flatMap(
    ([serviceId, service]) =>
      declaredComposeBridgeEndpoints(serviceId, service),
  );
  if (
    primary &&
    !endpoints.some(
      (endpoint) =>
        endpoint.serviceId === primary.service &&
        endpoint.port === primary.port,
    )
  ) {
    const protocol = previewBridgeProtocol(primary.protocol);
    if (protocol) {
      endpoints.push({
        endpointId: "preview",
        port: primary.port,
        protocol,
        serviceId: primary.service,
      });
    }
  }
  return endpoints;
}

function declaredComposeBridgeEndpoints(
  serviceId: string,
  service: ComposeService,
) {
  const labels = serviceLabels(service);
  return Object.keys(labels).flatMap((key) => {
    const match = /^blame\.endpoint\.(\d+)\.id$/.exec(key);
    if (!match) return [];
    const index = match[1];
    const port = numberValue(labels[`blame.endpoint.${index}.port`]);
    const protocol = previewBridgeProtocol(
      labels[`blame.endpoint.${index}.protocol`] ?? "http",
    );
    if (!port || !protocol) return [];
    return [
      {
        endpointId: labels[key],
        port,
        protocol,
        serviceId,
      } satisfies ComposeBridgeEndpoint,
    ];
  });
}

function previewBridgeProtocol(value: string | undefined) {
  return ["http", "https", "ws", "wss"].includes(value ?? "")
    ? (value as ComposeBridgeEndpoint["protocol"])
    : undefined;
}

function localPreviewProvider(
  address: string,
  protocol: ComposeBridgeEndpoint["protocol"],
) {
  const provider = new URL(
    previewUrl(
      address,
      protocol === "https" || protocol === "wss" ? "https" : "http",
      "/",
    ),
  );
  provider.hostname = "127.0.0.1";
  return provider;
}

async function selectedPreviewServiceId(worktree: string) {
  const [configurations, state] = await Promise.all([
    readProjectRunConfigurations(worktree),
    readPreviewRuntimeFileState(worktree),
  ]);
  return selectedPreviewRunConfiguration(configurations, state)?.previewService;
}

function previewTargetSelectionOrder(
  left: ReturnType<typeof labeledPreviewTarget>,
  right: ReturnType<typeof labeledPreviewTarget>,
  selectedService: string | undefined,
) {
  if (left?.service === selectedService) return -1;
  if (right?.service === selectedService) return 1;
  return 0;
}

async function composeConfig(
  worktree: string,
  composePath: string,
): Promise<ComposeConfig> {
  return dedupeComposeCall(`config:${worktree}:${composePath}`, () =>
    loadComposeConfig(worktree, composePath),
  );
}

async function loadComposeConfig(
  worktree: string,
  composePath: string,
): Promise<ComposeConfig> {
  const { stdout } = await containerRuntime.compose(
    ["-f", composePath, "--project-directory", worktree, "config"],
    { cwd: worktree, env: await setupEnvironment(worktree) },
  );
  const parsed = parseYaml(stdout) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as ComposeConfig;
}

function labeledPreviewTarget(service: string, config: ComposeService) {
  const labels = serviceLabels(config);
  if (labels["blame.preview"] !== "true") return undefined;
  const port = numberValue(labels["blame.preview.port"]);
  if (!port) return undefined;
  return {
    service,
    port,
    protocol: labels["blame.preview.protocol"] || "http",
    path: labels["blame.preview.path"] || "/",
  };
}

function exposedPreviewTarget(service: string, config: ComposeService) {
  const port = config.ports?.find((port) => numberValue(port.target));
  const target = numberValue(port?.target);
  if (!target) return undefined;
  return {
    service,
    port: target,
    protocol: "http",
    path: "/",
  };
}

function serviceLabels(config: ComposeService) {
  if (!config.labels) return {};
  if (!Array.isArray(config.labels)) return config.labels;
  return Object.fromEntries(
    config.labels
      .map((label) => label.split("=", 2))
      .filter(([key]) => Boolean(key))
      .map(([key, value]) => [key, value ?? "true"]),
  );
}

async function composePublishedAddress(
  worktree: string,
  composePath: string,
  service: string,
  port: number,
) {
  return dedupeComposeCall(
    `port:${worktree}:${composePath}:${service}:${port}`,
    () => loadComposePublishedAddress(worktree, composePath, service, port),
  );
}

async function loadComposePublishedAddress(
  worktree: string,
  composePath: string,
  service: string,
  port: number,
) {
  try {
    const { stdout } = await containerRuntime.compose(
      [
        "-f",
        composePath,
        "--project-directory",
        worktree,
        "port",
        service,
        String(port),
      ],
      { cwd: worktree, env: await setupEnvironment(worktree) },
    );
    return stdout.trim().split("\n").find(Boolean);
  } catch {
    return undefined;
  }
}

function dedupeComposeCall<T>(key: string, action: () => Promise<T>) {
  const current = composeCallPromises.get(key) as Promise<T> | undefined;
  if (current) return current;
  const next = action().finally(() => composeCallPromises.delete(key));
  composeCallPromises.set(key, next);
  return next;
}

async function repairProjectCompose(
  worktree: string,
  options: { reallocatePorts?: boolean } = {},
) {
  await sanitizeWorkspaceConfigFiles(worktree);
  await repairComposeFile(worktree, projectComposePath(worktree), options);
}

async function repairComposeFile(
  worktree: string,
  composePath: string,
  options: { reallocatePorts?: boolean } = {},
) {
  if (!(await runtimePathExists(composePath))) return;
  const compose = await readRuntimeFile(composePath);
  const dependencyCompose = composeWithCurrentDependencyVolumes(
    compose,
    await dependencyVolumeHashForWorktree(worktree, compose, true),
  );
  const nextCompose = (await worktreeHasNextProject(worktree))
    ? commandWithNextWebpackFallback(dependencyCompose)
    : dependencyCompose;
  const allocatedCompose = await composeWithRememberedHostPorts(
    worktree,
    composeWithNonMutatingNpmInstalls(
      composeWithoutNumericSuUser(
        composeWithRuntimePortPlaceholders(
          dockerComposeWithPortableWindowsPaths(nextCompose),
          options.reallocatePorts,
        ),
      ),
    ),
  );
  validatePreviewComposeBindings(allocatedCompose);
  const overrides = previewComposeEnvOverrides(allocatedCompose);
  await logPreviewEnvOverrides(worktree, overrides);
  const envMounts = await materializedPreviewEnvHostFileMounts(
    worktree,
    composePreviewOrigin(allocatedCompose),
    overrides,
  );
  const repairedCompose = dockerComposeWithHostFileMounts(
    allocatedCompose,
    worktree,
    envMounts,
  );
  if (repairedCompose !== compose)
    await writeRuntimeFile(composePath, repairedCompose);
}

async function worktreeHasNextProject(worktree: string) {
  const manifest = await readProjectPreviewManifest(worktree).catch(
    () => undefined,
  );
  const detectedStackResult = detectedStackUsesNext(manifest);
  if (detectedStackResult !== undefined) return detectedStackResult;
  const paths = await findProjectFilesByName(worktree, "package.json");
  return projectPackageFilesUseNext(paths);
}

async function projectPackageFilesUseNext(paths: string[]) {
  const batchSize = 64;
  for (let index = 0; index < paths.length; index += batchSize) {
    const files = await readExistingRuntimeFiles(
      paths.slice(index, index + batchSize),
    );
    if (Object.values(files).some(packageJsonUsesNext)) return true;
  }
  return false;
}

async function prepareProjectCompose(
  worktree: string,
  compose: string,
  symlinkEnvMounts: Awaited<ReturnType<typeof envHostFileMounts>>,
) {
  const dependencyKey = await timedRecoveryStep(
    worktree,
    "dependency hash",
    () => dependencyVolumeHashForWorktree(worktree, compose),
  );
  const normalizedCompose = await timedRecoveryStep(
    worktree,
    "compose normalize",
    () =>
      composeWithNonMutatingNpmInstalls(
        composeWithoutNumericSuUser(
          dockerComposeForPreview(compose, worktree, dependencyKey),
        ),
      ),
  );
  const allocatedCompose = await timedRecoveryStep(
    worktree,
    "compose allocate ports",
    () => composeWithRememberedHostPorts(worktree, normalizedCompose),
  );
  await timedRecoveryStep(worktree, "compose binding validation", () =>
    validatePreviewComposeBindings(allocatedCompose),
  );
  const overrides = previewComposeEnvOverrides(allocatedCompose);
  await logPreviewEnvOverrides(worktree, overrides);
  const envMounts = await timedRecoveryStep(
    worktree,
    "preview env host mounts",
    () =>
      materializedPreviewEnvHostFileMounts(
        worktree,
        composePreviewOrigin(allocatedCompose),
        overrides,
      ),
  );
  return timedRecoveryStep(worktree, "compose inject host mounts", () =>
    dockerComposeWithHostFileMounts(allocatedCompose, worktree, [
      ...symlinkEnvMounts,
      ...envMounts,
    ]),
  );
}

async function logPreviewEnvOverrides(
  worktree: string,
  overrides: Array<{ values: Record<string, string> }>,
) {
  const bindings = overrides.reduce(
    (count, override) => count + Object.keys(override.values).length,
    0,
  );
  if (bindings === 0) return;
  await appendRecoveryLog(
    worktree,
    `preview env overrides prepared: ${bindings} bindings`,
  );
}

const dependencyHashFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

async function dependencyVolumeHashForWorktree(
  worktree: string,
  compose: string,
  requireInputs = false,
) {
  const paths = await dependencyInputPaths(worktree);
  const contents = await readExistingRuntimeFiles(
    paths.map(({ path }) => path),
  );
  const foundInputs = paths.flatMap(({ file, path }) => {
    const content = contents[path];
    return typeof content === "string" ? [{ content, file }] : [];
  });
  for (const { file } of foundInputs) {
    await appendRecoveryLog(worktree, `dependency hash input: ${file}`);
  }
  // Hashing an already-keyed compose file would rotate an empty cache forever.
  if (requireInputs && foundInputs.length === 0) return "";
  return dependencyVolumeHashFromInputs(foundInputs, compose);
}

async function dependencyInputPaths(worktree: string) {
  const rootPaths = dependencyHashFiles.map((file) => ({
    file,
    path: joinWorkspacePath(worktree, file),
  }));
  const manifests = await findProjectFilesByName(worktree, "package.json");
  const manifestPaths = manifests.map((path) => ({
    file: relative(worktree, path).split(sep).join("/"),
    path,
  }));
  return uniqueDependencyInputPaths([...rootPaths, ...manifestPaths]);
}

function uniqueDependencyInputPaths(
  paths: Array<{ file: string; path: string }>,
) {
  return Array.from(
    new Map(paths.map((input) => [input.path, input])).values(),
  );
}

function composePreviewOrigin(compose: string) {
  const match = /(?:127\.0\.0\.1|localhost):(\d+):\d+/.exec(compose);
  return match ? `http://localhost:${match[1]}` : undefined;
}

// Returns the preview service logs it recorded, for error messages.
async function appendComposeDiagnostics(worktree: string) {
  await appendRecoveryLog(worktree, "compose diagnostics");
  await appendComposeOutput(worktree, ["ps", "-a"]);
  const target = await composePreviewTarget(
    worktree,
    projectComposePath(worktree),
  );
  return appendComposeOutput(
    worktree,
    target
      ? ["logs", "--tail", "120", target.service]
      : ["logs", "--tail", "120"],
  );
}

async function appendComposeOutput(worktree: string, args: string[]) {
  try {
    const { stdout, stderr } = await containerRuntime.compose(
      [...composeArgs(worktree), ...args],
      {
        cwd: worktree,
        env: await setupEnvironment(worktree),
        timeoutMs: containerMetadataTimeoutMs,
      },
    );
    if (stdout) await appendRecoveryLog(worktree, stdout.trimEnd());
    if (stderr) await appendRecoveryLog(worktree, stderr.trimEnd());
    return `${stdout}\n${stderr}`;
  } catch (error) {
    await appendRecoveryLog(worktree, commandErrorText(error).trim());
    return "";
  }
}

function withPreviewLogExcerpt(message: string, logs: string) {
  const excerpt = previewFailureLogExcerpt(logs);
  return excerpt ? `${message}: ${excerpt}` : message;
}

async function previewContainers(includeStopped: boolean, worktree: string) {
  try {
    const { stdout } = await containerRuntime.container(
      [
        "ps",
        ...(includeStopped ? ["-a"] : []),
        "--filter",
        "label=blame.preview=true",
        "--format",
        "{{.ID}}",
      ],
      {
        cwd: worktree,
        env: await setupEnvironment(worktree),
        timeoutMs: containerMetadataTimeoutMs,
      },
    );
    const ids = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (ids.length === 0) return [];
    return containerRuntime.inspect<RuntimeContainer>(ids, {
      timeoutMs: containerMetadataTimeoutMs,
    });
  } catch {
    return [];
  }
}

async function waitForPreview(worktree: string, url: string) {
  const startedAt = Date.now();
  const deadline = startedAt + previewResponseTimeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (await previewRuntimeStopped(worktree)) return;
    attempts += 1;
    if (await previewResponds(url)) {
      await appendRecoveryLog(
        worktree,
        `preview responded after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      );
      return;
    }
    await assertPreviewContainerCanStillStart(worktree, startedAt);
    await delay(previewStartupIntervalMs);
  }
  const logs = await appendComposeDiagnostics(worktree);
  throw new PreviewRuntimeError(
    "preview_response_timeout",
    withPreviewLogExcerpt(
      `Preview did not respond within ${previewResponseTimeoutMs / 1_000} seconds`,
      logs,
    ),
  );
}

async function runPreviewProbes(worktree: string) {
  const manifest = await readProjectPreviewManifest(worktree);
  if (!manifest?.probes?.length) return;
  const plan = compiledPreviewPlan(manifest);
  const probes = activeProbes(
    plan,
    await activeRunConfigurationServices(worktree, manifest),
  );
  let passed = 0;
  for (const probe of probes) {
    try {
      await executePreviewProbe(worktree, plan, probe);
      passed += 1;
    } catch (error) {
      await appendRecoveryLog(worktree, `preview probe ${probe.id} failed`);
      if (probe.required) throw previewProbeError(error, probe);
    }
  }
  await appendRecoveryLog(
    worktree,
    `preview probes passed: ${passed}/${probes.length}`,
  );
}

// Local previews read the manifest through the same compiler as cloud
// previews, so both accept, refuse and probe a manifest the same way.
function compiledPreviewPlan(manifest: PreviewManifest) {
  try {
    return compilePreviewManifest(manifest);
  } catch (error) {
    throw new PreviewRuntimeError(
      "preview_manifest_invalid",
      `Preview manifest is invalid: ${errorMessageText(error)}`,
    );
  }
}

async function activeRunConfigurationServices(
  worktree: string,
  manifest: PreviewManifest,
) {
  const [configurations, state] = await Promise.all([
    readProjectRunConfigurations(worktree),
    readPreviewRuntimeFileState(worktree),
  ]);
  if (!configurations.length) return undefined;
  const selected = selectedPreviewRunConfiguration(configurations, state);
  return selected
    ? new Set(previewRunConfigurationServiceIds(selected, manifest))
    : new Set<string>();
}

async function readProjectPreviewManifest(worktree: string) {
  const path = projectPreviewManifestPath(worktree);
  if (!(await runtimePathExists(path))) return undefined;
  try {
    return parsePreviewManifest(JSON.parse(await readRuntimeFile(path)));
  } catch (error) {
    throw new PreviewRuntimeError(
      "preview_manifest_invalid",
      `Persisted preview manifest is invalid: ${errorMessageText(error)}`,
    );
  }
}

async function executePreviewProbe(
  worktree: string,
  plan: PreviewExecutionPlan,
  probe: ProbePlan,
) {
  const endpoint = probeEndpoint(plan, probe);
  if (!endpoint) {
    throw new PreviewRuntimeError(
      "preview_manifest_invalid",
      `Preview probe ${probe.id} references an unknown endpoint`,
    );
  }
  if (probe.from === "host") {
    await executeHostPreviewProbe(worktree, probe, endpoint);
    return;
  }
  const consumer = plan.services.find(({ id }) => id === probe.from);
  const command = consumer && serviceProbeCommand(consumer, probe, endpoint);
  if (!command) {
    throw new PreviewRuntimeError(
      "preview_probe_unsupported",
      `Preview probe ${probe.id} has no supported runtime`,
    );
  }
  await containerRuntime.compose(
    [...composeArgs(worktree), "exec", "-T", probe.from, ...command],
    { cwd: worktree, env: await setupEnvironment(worktree) },
  );
}

async function executeHostPreviewProbe(
  worktree: string,
  probe: ProbePlan,
  endpoint: ServiceEndpointPlan,
) {
  const address = await composePublishedAddress(
    worktree,
    projectComposePath(worktree),
    probe.target.serviceId,
    endpoint.port,
  );
  if (!address) throw new Error("Probe target is not published to the host");
  if (probe.type === "tcp") {
    await connectToProbeAddress(address, probe.timeoutMs);
    return;
  }
  const response = await fetch(
    previewUrl(address, endpoint.protocol, probe.target.path),
    { method: "GET", signal: AbortSignal.timeout(probe.timeoutMs) },
  );
  if (probeStatusAccepted(response.status, probe.acceptedStatuses)) return;
  throw new Error(`Unexpected probe status ${response.status}`);
}

function connectToProbeAddress(address: string, timeoutMs: number) {
  const url = new URL(previewUrl(address, "http", "/"));
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(Number(url.port), url.hostname);
    const timeout = setTimeout(
      () => socket.destroy(new Error("Probe timed out")),
      timeoutMs,
    );
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function previewProbeError(error: unknown, probe: ProbePlan) {
  if (error instanceof PreviewRuntimeError) return error;
  return new PreviewRuntimeError(
    "preview_probe_failed",
    probeFailureMessage(probe, errorMessageText(error)),
  );
}

async function assertPreviewContainerCanStillStart(
  worktree: string,
  startedAt: number,
) {
  const container = await previewContainerForWorktree(worktree);
  const status = container?.State?.Status;
  const health = container?.State?.Health?.Status;
  const failure = previewContainerFailure({
    discoveryGraceMs: previewDiscoveryGraceMs,
    elapsedMs: Date.now() - startedAt,
    found: Boolean(container),
    health,
    status,
  });
  if (!failure) return;
  const logs = await appendComposeDiagnostics(worktree);
  const state = health || status || "missing";
  throw new PreviewRuntimeError(
    failure,
    withPreviewLogExcerpt(
      `Preview container cannot become ready (${state})`,
      logs,
    ),
  );
}

async function projectRuntimeHealthy(worktreeInput: string) {
  const worktree = resolveRuntimePath(worktreeInput);
  const composePath = projectComposePath(worktree);
  if (!(await runtimePathExists(composePath))) return false;
  const containers = await composeProjectContainers(worktree);
  const runtimeContainers = containers.filter(
    (container) => !completedSetupContainer(container),
  );
  if (runtimeContainers.length === 0) return false;
  return runtimeContainers.every(containerCanStillRun);
}

async function composeProjectContainers(worktree: string) {
  return dedupeComposeCall(`containers:${worktree}`, () =>
    loadComposeProjectContainers(worktree),
  );
}

async function loadComposeProjectContainers(worktree: string) {
  try {
    const { stdout } = await containerRuntime.compose(
      [...composeArgs(worktree), "ps", "-a", "--format", "json"],
      {
        cwd: worktree,
        env: await setupEnvironment(worktree),
        timeoutMs: containerMetadataTimeoutMs,
      },
    );
    const ids = composePsContainerIds(stdout);
    if (ids.length === 0) return [];
    return containerRuntime.inspect<RuntimeContainer>(ids, {
      timeoutMs: containerMetadataTimeoutMs,
    });
  } catch {
    return [];
  }
}

function composePsContainerIds(stdout: string) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[")) return composePsEntriesContainerIds(trimmed);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap(composePsEntryContainerId);
}

function composePsEntriesContainerIds(stdout: string) {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) =>
      composePsContainerId(entry as Record<string, unknown>),
    );
  } catch {
    return [];
  }
}

function composePsEntryContainerId(line: string) {
  try {
    return composePsContainerId(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function composePsContainerId(parsed: Record<string, unknown>) {
  const id = parsed.ID ?? parsed.Id ?? parsed.ContainerID;
  return typeof id === "string" && id ? [id] : [];
}

function completedSetupContainer(container: RuntimeContainer) {
  const labels = container.Config?.Labels ?? {};
  return (
    container.State?.Status === "exited" &&
    container.State.ExitCode === 0 &&
    labels["blame.preview"] !== "true"
  );
}

function containerCanStillRun(container: RuntimeContainer) {
  const status = container.State?.Status;
  const health = container.State?.Health?.Status;
  return health !== "unhealthy" && !failedContainerStatus(status);
}

async function previewContainerForWorktree(worktree: string) {
  const containers = await previewContainers(true, worktree);
  const selectedService = await selectedPreviewServiceId(worktree);
  const labeled = containers.find(
    (container) =>
      containerMatchesWorktree(container, worktree) &&
      (!selectedService ||
        runtimeContainerService(container) === selectedService),
  );
  if (labeled) return labeled;
  const projectContainers = await composeProjectContainers(worktree);
  return projectContainers.find(
    (container) =>
      !completedSetupContainer(container) &&
      containerMatchesWorktree(container, worktree) &&
      (!selectedService ||
        runtimeContainerService(container) === selectedService),
  );
}

function failedContainerStatus(status: string | undefined) {
  return status === "dead" || status === "exited" || status === "removing";
}

async function previewResponds(url: string) {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(previewRequestTimeoutMs),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function previewUrl(address: string, protocol: string, path: string) {
  const normalizedAddress = address
    .replace(/^(?:0\.0\.0\.0|127\.0\.0\.1):/, "localhost:")
    .replace(/^\[::\]:/, "localhost:")
    .replace(/^\[::1\]:/, "localhost:");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${protocol}://${normalizedAddress}${normalizedPath}`;
}

function previewOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown) {
  if (error instanceof PreviewRuntimeError)
    return `[${error.code}] ${error.message}\n`;
  return error instanceof Error
    ? `${error.message}\n`
    : "Project setup failed.\n";
}

function emitSetupEvent(
  runId: string,
  type: "stdout" | "stderr" | "exit",
  data: string,
) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(`workspace:setup:event:${runId}`, {
      runId,
      type,
      data,
    });
  });
}

function emitSetupOutput(
  runId: string,
  worktree: string,
  type: "stdout" | "stderr" | "exit",
  data: string,
) {
  void appendRuntimeFile(setupLogPath(worktree), setupLogText(type, data));
  emitSetupEvent(runId, type, data);
}

function emitProjectServiceLog(
  streamId: string,
  type: "stdout" | "stderr" | "exit",
  data: string,
) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(`workspace:project-service-log:${streamId}`, {
      streamId,
      type,
      data,
    });
  });
}

function setupLogText(type: "stdout" | "stderr" | "exit", data: string) {
  if (type !== "exit") return data;
  return `\n[setup exited with code ${data}]\n`;
}
