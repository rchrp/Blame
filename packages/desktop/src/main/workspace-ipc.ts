import {
  parsePreviewManifest,
  parseRunConfigurations,
  manifestWithProjectPackageManager,
  projectPackageManager,
  type ApplyPreviewInitializationInput,
  type ExecutionTelemetryCohorts,
  type ProjectPreviewRuntimeState,
  type ProjectRunConfiguration,
} from "@blame/agent-runtime";
import { type PreviewManifest } from "@blame/preview-contract";
import { type RuntimeProfileId } from "@blame/preview-runtime";
import type { ServiceState } from "@blame/preview-runtime/compose";
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
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import {
  generateNewProjectWithAgent,
  releaseAgentWorkspaceSessions,
} from "./agent-ipc";
import { containerRuntimeEnvironment } from "./container-runtime";
import {
  assertHostDependencies,
  checkHostDependencies,
} from "./host-dependencies";
import { setupPath } from "./host-tool-path";
import { isProjectFolder } from "./worktree-safety";
import { inspectWorktreeRemoval } from "./worktree-removal.ts";
import { WorktreeActivity } from "./worktree-activity.ts";
import { WorktreeLogs } from "./worktree-logs.ts";
import type { DesktopBridgeGrant } from "./preview-browser/preview-bridge-grant";
import { previewComposeProjectName } from "./preview-readiness";
import { PreviewRecoveryCircuit } from "./preview-recovery-circuit";
import { stalePreviewSetupReason } from "./preview-setup-preflight.ts";
import {
  previewRunConfigurationServiceIds,
  previewRunConfigurationStatus,
  selectedPreviewRunConfiguration,
  shouldStartBrowserPreview,
  type PreviewRuntimeSelectionState,
} from "./preview-run-state";
import {
  idleLocalPreviewLifecycle,
  localPreviewLifecycle,
  localPreviewOperationInFlight,
  persistLocalPreviewFailure,
  readyLocalPreviewLifecycle,
  selectsBrowserPreview,
  pendingLocalPreviewLifecycle,
  suspendedLocalPreviewLifecycle,
  runLocalPreviewOperation,
  trackLocalPreviewOperation,
} from "./preview-runtime/local/local-preview-lifecycle.js";
import { LocalPreviewService } from "./preview-runtime/local/local-preview-service";
import {
  previewRecoveryConfigurationFingerprint,
  previewRecoveryFailureFingerprint,
} from "./preview-recovery-fingerprint.ts";
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
  collectPreviewGarbage,
  removePreviewProject,
  runningPreviewWorktrees,
} from "./preview-runtime/local/local-preview-cleanup.ts";
import {
  previewIdleTimeoutMs,
  recordPreviewUse,
  startIdlePreviewSweeper,
} from "./preview-runtime/local/local-preview-idle.ts";
import {
  compileLocalPreviewPlan,
  localPreviewPaths,
  LocalPreviewError as PreviewRuntimeError,
  readLocalPreviewManifest,
  readLocalRunConfigurations,
  readLocalRuntimeState,
  writeLocalPreviewInitialization,
  writeLocalRuntimeState,
} from "./preview-runtime/local/local-preview-files.ts";
import {
  followLocalPreviewLogs,
  localPreviewEndpoints,
  localPreviewHealthy,
  localPreviewLogs,
  localPreviewProbesPass,
  assertLocalPreviewHasServices,
  localPreviewServices,
  localPreviewUrl,
  prefetchLocalPreview,
  removeLocalPreview,
  startLocalPreview,
  stopLocalPreview,
} from "./preview-runtime/local/local-preview-runner.ts";
import { syncProjectEnvFiles } from "./workspace-env";
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
  platformWorktreeRoot,
  workspaceExecution,
  workspaceMode,
  type WorkspaceMode,
} from "./workspace-mode.ts";
import {
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
  storyBranch,
  worktreePath,
  writeFileAtomic as writeRuntimeFileAtomic,
} from "./workspace-runtime";
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

const previewRequestTimeoutMs = 5_000;
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
const setupEnvironmentCacheTtlMs = 2_000;
const worktreeSetupOperationName = "blame.worktree.setup";
const previewPrepareOperationName = "blame.preview.prepare";
const projectSetupOperationName = "blame.project.setup";
const previewStartOperationName = "blame.preview.start";
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
  workspaceMode?: WorkspaceMode;
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

type SetupRun = {
  id: string;
  abort: AbortController;
  processSpan: BlameSpan;
  startedAt: number;
  telemetry: ExecutionOperation;
  worktree: string;
};

type ExecutionOperation = {
  component: ExecutionComponent;
  descriptor: ExecutionDescriptor;
  finished: boolean;
  operationName: string;
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
  abort: AbortController;
};

type ProjectServiceLogStream = {
  abort?: AbortController;
  hasOutput: boolean;
  retry?: NodeJS.Timeout;
  service: string;
  stopped: boolean;
  worktree: string;
};

type SetupEnvironment = NodeJS.ProcessEnv & {
  COMPOSE_PROJECT_NAME: string;
};

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
const worktreeActivity = new WorktreeActivity();
const worktreeLogs = new WorktreeLogs(worktreeActivity);
const {
  append: appendRunLog,
  flush: flushRunLogs,
  section: appendRunLogSection,
  recovery: appendRecoveryLog,
  timing: appendTimingLog,
} = worktreeLogs;
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
    if (report.status === "ready") {
      onRuntimeReady?.();
      schedulePreviewCleanup();
    }
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
  startIdlePreviewSuspension();
  ipcMain.handle("workspace:path-exists", (_event, input: { path: string }) =>
    pathExists(input.path),
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
        workspaceMode: input.workspaceMode,
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
    (event, input: { worktree: string; workspaceMode?: WorkspaceMode }) => {
      // The app reads the state while the preview is open and on screen.
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window?.isVisible() && !window.isMinimized()) {
        recordPreviewUse(resolveRuntimePath(input.worktree));
      }
      return projectPreviewRuntimeState(input.worktree, input.workspaceMode);
    },
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
  if (removingWorktrees.has(context.worktree))
    throw new Error("The workspace is still being removed.");
  if (worktreeActivity.isClosed(context.worktree))
    worktreeActivity.open(context.worktree);
  return worktreeActivity.run(context.worktree, async () => {
    await prepareWorktreeCreation(context);
    if (await reuseRegisteredWorktree(context)) return worktreeResult(context);
    await assertWorktreePathAvailable(context);
    await addStoryWorktree(context);
    await completeWorktreeCreation(context);
    return worktreeResult(context);
  });
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
    ensureWorkspaceGitRepository(repositoryRoot, mode),
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
  await ensureWorkspaceGitRepository(repositoryRoot, "direct");
  const branch = String(
    await runRuntimeGit(
      repositoryRoot,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      "native",
    ),
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
    const { worktree } = await prepareProjectPreviewArtifacts(input);
    if (
      input.runtimeProfile === "local-container" &&
      typeof input.runConfigurationId !== "string"
    ) {
      prefetchProjectPreview(worktree);
    }
    return { prepared: true };
  });
}

async function runProjectSetupOperation(
  input: RunProjectSetupInput,
  operation: ExecutionOperation,
) {
  const { worktree } = await prepareProjectPreviewArtifacts(input);
  return startProjectSetupRun(
    worktree,
    operation,
    input.runtimeProfile === "local-container",
  );
}

// Writes what a local preview starts from: the canonical manifest, compiled
// once here so an invalid one fails now, and the run configurations with
// the selected one.
function prepareProjectPreviewArtifacts(input: PrepareProjectPreviewInput) {
  return worktreeActivity.run(resolveRuntimePath(input.worktree), () =>
    writeProjectPreviewArtifacts(input),
  );
}

async function writeProjectPreviewArtifacts(input: PrepareProjectPreviewInput) {
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
  compileLocalPreviewPlan(manifest);
  const runConfigurations = parseRunConfigurations(input.runConfigurations);
  validateContainerizedRunConfigurations(runConfigurations, manifest);
  await validateProjectSetup(
    worktree,
    // Containerized previews need no tool on this computer.
    "",
    env,
    input.hostDependenciesChecked,
    input.runtimeProfile,
  );
  await timedRecoveryStep(worktree, "initialization files", () =>
    writeLocalPreviewInitialization(
      worktree,
      manifest,
      runConfigurations,
      input.runConfigurationId,
    ),
  );
  return { env, worktree };
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

function writeRuntimeJson(path: string, value: unknown) {
  return writeRuntimeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// The renderer subscribes to the run's events once it has the run id, so
// the run itself starts on the next tick.
function startProjectSetupRun(
  worktree: string,
  telemetry: ExecutionOperation,
  startLocalPreview: boolean,
) {
  const run: SetupRun = {
    id: randomUUID(),
    abort: new AbortController(),
    processSpan: startWorkspaceStep(
      "setup process runtime",
      telemetry.component.span.context,
    ),
    startedAt: Date.now(),
    telemetry,
    worktree,
  };
  setupRuns.set(run.id, run);
  setTimeout(() => void completeProjectSetupRun(run, startLocalPreview), 0);
  return { runId: run.id };
}

async function completeProjectSetupRun(
  run: SetupRun,
  startLocalPreview: boolean,
) {
  const { id: runId, worktree } = run;
  try {
    const previewUrl = startLocalPreview
      ? await traceSetupPreview(run, () =>
          startProjectCompose(worktree, {
            output: (chunk) =>
              emitSetupOutput(runId, worktree, "stdout", chunk),
            signal: run.abort.signal,
          }),
        )
      : null;
    if (run.abort.signal.aborted) return;
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
    if (run.abort.signal.aborted) return;
    finishSetupRun(run, "failed", error);
    emitSetupOutput(runId, worktree, "stderr", errorMessage(error));
    emitSetupOutput(runId, worktree, "exit", "1");
  }
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

type StartProjectComposeOptions = {
  /** Live output; without it the output goes to the run log. */
  output?: (chunk: string) => void;
  signal?: AbortSignal;
};

const previewStarts = new Map<string, Promise<string | undefined>>();
const previewPrefetches = new Map<string, Promise<void>>();

function startProjectCompose(
  worktree: string,
  options: StartProjectComposeOptions = {},
) {
  const current = previewStarts.get(worktree);
  if (current) return current;
  // A cleanup removes unused images and networks: let it finish first, and
  // a running prefetch of this worktree, whose work the start reuses.
  const next = worktreeActivity
    .run(worktree, async () => {
      await previewCleanup;
      const prefetch = previewPrefetches.get(worktree);
      if (prefetch) {
        void recordPreviewStartStep(
          worktree,
          "Finishing the preparation of images and dependencies",
        );
        await prefetch;
      }
      return startProjectComposeOperation(worktree, options);
    })
    .finally(() => previewStarts.delete(worktree));
  previewStarts.set(worktree, next);
  return next;
}

// A story whose run configuration is none starts no preview while the agent
// works. Its images and dependency installs are still prepared, so opening
// the preview later starts it in seconds.
function prefetchProjectPreview(worktree: string) {
  if (worktreeActivity.isClosed(worktree)) return;
  if (previewStarts.has(worktree) || previewPrefetches.has(worktree)) return;
  const next = worktreeActivity
    .run(worktree, async () => {
      await previewCleanup;
      await appendRunLogSection(worktree, "Preparing the preview");
      await prefetchLocalPreview(worktree, {
        log: (chunk) => appendRunLog(worktree, chunk),
      });
    })
    .catch((error) => {
      appendRunLog(
        worktree,
        `Preparing the preview failed: ${errorMessage(error)}\n`,
      );
    })
    .finally(() => {
      previewPrefetches.delete(worktree);
      schedulePreviewCleanup();
    });
  previewPrefetches.set(worktree, next);
}

async function startProjectComposeOperation(
  worktree: string,
  options: StartProjectComposeOptions,
) {
  if (await stopPreviewStartWhenRequested(worktree)) return undefined;
  // A likely stale setup explains a failed start; it never blocks one.
  const stale = await timedRecoveryStep(worktree, "setup preflight", async () =>
    stalePreviewSetupReason(worktree, await readLocalPreviewManifest(worktree)),
  );
  try {
    const previewUrl = await startLocalPreview(worktree, {
      log: options.output ?? ((chunk) => appendRunLog(worktree, chunk)),
      step: (step) => void recordPreviewStartStep(worktree, step),
      timing: (label, durationMs) =>
        void appendTimingLog(worktree, label, durationMs),
      wanted: async () =>
        !options.signal?.aborted &&
        !removingWorktrees.has(worktree) &&
        !(await previewRuntimeStopped(worktree)),
    });
    if (await stopPreviewStartWhenRequested(worktree)) return undefined;
    recordPreviewUse(worktree);
    await startProjectLogStream(worktree);
    return previewUrl;
  } catch (error) {
    await appendServiceLogTail(worktree);
    if (!stale || !(error instanceof Error)) throw error;
    throw new PreviewRuntimeError(
      "preview_setup_stale",
      `${stale} (${error.message})`,
    );
  }
}

// The last lines of every service, so the run log says why a start failed.
async function appendServiceLogTail(worktree: string) {
  const logs = await localPreviewLogs(worktree, undefined, {
    tail: 120,
    timeoutMs: 15_000,
  }).catch(() => undefined);
  const text = `${logs?.stdout ?? ""}${logs?.stderr ?? ""}`.trim();
  if (text) await appendRecoveryLog(worktree, `service logs\n${text}`);
}

async function stopProjectSetup(input: StopProjectSetupInput) {
  const worktree = resolveRuntimePath(input.worktree);
  await stopSetupRunsForWorktree(worktree);
  if (
    input.workspaceMode === "cloud-mirror" ||
    input.workspaceMode === "direct"
  )
    return true;
  try {
    await stopProjectLogStream(worktree);
    await stopLocalPreview(worktree);
    return true;
  } catch {
    return false;
  }
}

async function removeWorktree(input: RemoveWorktreeInput) {
  const repositoryRoot = resolveRuntimePath(input.repositoryRoot);
  const worktree = resolveRuntimePath(input.worktree);
  const { mode, state } = await inspectWorktreeRemoval({
    repositoryRoot,
    worktree,
    workspaceMode: input.workspaceMode,
  });
  // Direct mode runs in the project folder: stop what runs there, never
  // delete it.
  if (state === "project") {
    await stopSetupRunsForWorktree(worktree);
    await stopProjectLogStream(worktree);
    await releaseAgentWorkspaceSessions(worktree);
    return true;
  }
  if (removingWorktrees.has(worktree))
    throw new Error("The workspace is still being removed.");
  removingWorktrees.add(worktree);
  const settled = worktreeActivity.close(worktree);
  worktreeLogs.discard(worktree);
  try {
    await stopSetupRunsForWorktree(worktree);
    await stopProjectLogStream(worktree);
    await releaseAgentWorkspaceSessions(worktree);
    await settled;
    // A create or prefetch may have completed while removal was waiting.
    const current = await inspectWorktreeRemoval({
      repositoryRoot,
      worktree,
      workspaceMode: mode,
    });
    if (current.state === "project")
      throw new Error("Refusing to delete the project folder.");
    previewRecoveries.delete(worktree);
    if (mode === "local-container") await removeWorktreePreview(worktree);
    if (current.state === "registered")
      await removeGitWorktree(repositoryRoot, worktree, mode);
    else await rmRuntime(worktree);
    if (
      (await runtimePathExists(worktree)) ||
      (await worktreeRegistered(repositoryRoot, worktree, mode))
    )
      throw new Error(
        "Unable to completely remove the worktree. Please retry deletion.",
      );
    removedWorktrees.add(worktree);
    return true;
  } finally {
    removingWorktrees.delete(worktree);
  }
}

// A removed worktree takes its containers, network and volumes along; the
// dependency volumes it shared go at the next cleanup once unused.
async function removeWorktreePreview(worktree: string) {
  // Label-based cleanup also works when a failed setup left no valid manifest.
  await removeLocalPreview(worktree).catch(() => undefined);
  if (!(await removePreviewProject(previewComposeProjectName(worktree))))
    throw new Error(
      "Unable to remove the preview containers and volumes. Please retry deletion.",
    );
  schedulePreviewCleanup();
}

let previewCleanupTimer: NodeJS.Timeout | undefined;
let previewCleanup: Promise<void> | undefined;

/**
 * Cleans the Blame Runtime a minute after the last request, once no
 * preview is starting: an image just pulled for a start is not used by a
 * container yet, so the cleanup must not run alongside one.
 */
export function schedulePreviewCleanup() {
  if (previewCleanupTimer) clearTimeout(previewCleanupTimer);
  previewCleanupTimer = setTimeout(() => {
    previewCleanupTimer = undefined;
    if (previewStarts.size || previewPrefetches.size || setupRuns.size) {
      schedulePreviewCleanup();
      return;
    }
    const worktrees = platformWorktreeRoot(
      process.platform,
      process.env,
      "local-container",
    );
    previewCleanup = collectPreviewGarbage([
      worktrees,
      joinWorkspacePath(dirnameWorkspacePath(worktrees), "repos"),
    ])
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        previewCleanup = undefined;
      });
  }, 60_000);
  previewCleanupTimer.unref?.();
}

async function resolveProjectPreviewUrl(input: ResolveProjectPreviewUrlInput) {
  const worktree = resolveRuntimePath(input.worktree);
  if (removedWorktrees.has(worktree)) return null;
  if (!(await isWorkspaceGitRepository(worktree))) return null;
  if ((await readPreviewRuntimeFileState(worktree)).desiredStatus === "stopped")
    return null;
  return (await localPreviewUrl(worktree)) ?? null;
}

export async function localPreviewBridgeGrant(
  worktreeInput: string,
): Promise<DesktopBridgeGrant> {
  const worktree = resolveRuntimePath(worktreeInput);
  if (removedWorktrees.has(worktree))
    throw new Error("Local preview worktree was removed");
  if (!(await isWorkspaceGitRepository(worktree)))
    throw new Error("Local preview worktree is invalid");
  const { routes: endpoints, primary } = await localPreviewEndpoints(worktree);
  if (!endpoints.length)
    throw new Error("Local preview has no published endpoint");
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const sessionId = `local:${createHash("sha256")
    .update(worktree)
    .digest("hex")
    .slice(0, 24)}`;
  const routes = endpoints.map((endpoint) => ({
    routeId: `${sessionId}:${endpoint.serviceId}:${endpoint.endpointId}`,
    serviceId: endpoint.serviceId,
    endpointId: endpoint.endpointId,
    logicalHost: "localhost" as const,
    logicalPort: endpoint.port,
    protocol: endpoint.protocol,
    providerUrl: `${endpoint.protocol}://127.0.0.1:${endpoint.port}/`,
    provider: "local" as const,
    capabilityExpiresAt: expiresAt,
  }));
  const primaryRoute = routes.find(
    (route) =>
      route.serviceId === primary?.serviceId &&
      route.endpointId === primary?.endpoint.id,
  );
  return {
    sessionId,
    endpointRevision: 1,
    integratedPreviewRequired: true,
    primaryRouteId: primaryRoute?.routeId ?? routes[0]?.routeId ?? "",
    routes,
  };
}

async function ensureProjectPreviewUrl(input: EnsureProjectPreviewUrlInput) {
  if (
    input.workspaceMode === "cloud-mirror" ||
    input.workspaceMode === "direct"
  )
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
  if (
    currentUrl &&
    (await previewResponds(currentUrl)) &&
    (await previewProbesPass(worktree))
  )
    return currentUrl;
  const recovery = previewRecoveries.get(worktree);
  if (recovery) return recovery;
  const configurationFingerprint = previewRecoveryConfigurationFingerprint({
    configurations,
    files: await previewRecoveryFingerprintFiles(worktree),
    manifest,
    runtimeState,
  });
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
  const nextRecovery = runPreviewRecovery(input, worktree)
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
          operationErrorType(error),
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
  // Read before the files: an operation that settles during this read has
  // written its result by the time it stops being in flight.
  const inFlight =
    localPreviewOperationInFlight(worktree) || previewStarts.has(worktree);
  const [configurations, runtimeState, containers, manifest] =
    await Promise.all([
      readProjectRunConfigurations(worktree),
      readPreviewRuntimeFileState(worktree),
      localPreviewServices(worktree),
      readProjectPreviewManifest(worktree).catch(() => undefined),
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
  const browserPreview = selectsBrowserPreview(
    selected?.previewService,
    manifest,
  );
  const previewUrl =
    runtimeState.desiredStatus === "running" && browserPreview
      ? ((await resolveProjectPreviewUrl({ worktree })) ?? undefined)
      : undefined;
  const lifecycle = localPreviewLifecycle(
    runtimeState,
    selected ? statuses[selected.id] : undefined,
    browserPreview,
    previewUrl,
    inFlight,
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
      persisted.lifecycle?.phase === "stopping" ||
      persisted.lifecycle?.phase === "suspending" ||
      persisted.lifecycle?.phase === "suspended"
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
  const worktree = resolveRuntimePath(input.worktree);
  // In flight from the request on, so no read sees it half applied; the
  // state it returns is read once it settled.
  await trackLocalPreviewOperation(worktree, () =>
    controlProjectPreviewNow(input),
  );
  return projectPreviewRuntimeState(worktree);
}

async function controlProjectPreviewNow(input: ControlProjectPreviewInput) {
  return worktreeActivity.run(resolveRuntimePath(input.worktree), async () => {
    const selection = await previewControlSelection(input);
    recordPreviewUse(selection.worktree);
    await appendRecoveryLog(
      selection.worktree,
      `run configuration ${input.action}: ${selection.selected.id}`,
    );
    if (input.action === "stop") return stopProjectPreview(selection);
    previewRecoveryCircuit.reset(selection.worktree);
    return startProjectPreview(selection, input.action === "restart");
  });
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
  return worktreeActivity.run(worktree, async () => {
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
  });
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
  if (!manifest) return;
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

async function stopProjectPreview(
  selection: PreviewControlSelection,
  options: { suspend?: boolean } = {},
) {
  const { current, selected, worktree } = selection;
  await runLocalPreviewOperation(
    worktree,
    selected.id,
    "stopped",
    options.suspend ? "suspending" : "stopping",
    async () => {
      if (current && current.id !== selected.id) {
        await stopRunConfigurationServices(worktree, current);
      }
      await stopRunConfigurationServices(worktree, selected);
      return options.suspend
        ? suspendedLocalPreviewLifecycle()
        : idleLocalPreviewLifecycle();
    },
    writePreviewRuntimeState,
    readPreviewRuntimeFileState,
  );
  return projectPreviewRuntimeState(worktree);
}

// Stops a preview nobody used for a while, as suspended: opening it in the
// app starts it again, and so do the agent's preview tools.
async function suspendIdleProjectPreview(worktree: string) {
  if (previewStarts.has(worktree) || previewPrefetches.has(worktree)) return;
  const state = await readPreviewRuntimeFileState(worktree);
  if (state.desiredStatus !== "running") return;
  if (state.lifecycle?.status === "pending") return;
  const selection = await previewControlSelection({ action: "stop", worktree });
  await appendRecoveryLog(
    worktree,
    `run configuration suspended after ${previewIdleTimeoutMs / 60_000} minutes without use: ${selection.selected.id}`,
  );
  await stopProjectPreview(selection, { suspend: true });
}

/** Starts stopping the local previews nobody uses. */
export function startIdlePreviewSuspension() {
  startIdlePreviewSweeper({
    runningWorktrees: () => runningPreviewWorktrees(),
    suspend: suspendIdleProjectPreview,
  });
}

async function startProjectPreview(
  selection: PreviewControlSelection,
  restart: boolean,
) {
  const { current, selected, worktree } = selection;
  await runLocalPreviewOperation(
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
      await assertLocalPreviewHasServices(worktree, selected);
      await startProjectCompose(worktree);
      // Ready once the start has passed its readiness checks, not when
      // the containers merely run.
      return (await previewRuntimeStopped(worktree))
        ? undefined
        : readyLocalPreviewLifecycle();
    },
    writePreviewRuntimeState,
    readPreviewRuntimeFileState,
  );
  return projectPreviewRuntimeState(worktree);
}

function assertPreviewRunnerAction(action: string) {
  if (action === "start" || action === "stop" || action === "restart") return;
  throw new Error("Preview runner action is invalid");
}

async function stopRunConfigurationServices(
  worktree: string,
  configuration: ProjectRunConfiguration,
) {
  await stopLocalPreview(
    worktree,
    await runConfigurationServiceIds(worktree, configuration),
  );
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

async function stopPreviewStartWhenRequested(worktree: string) {
  if (worktreeActivity.isClosed(worktree)) return true;
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

const readProjectRunConfigurations = readLocalRunConfigurations;
const readPreviewRuntimeFileState = readLocalRuntimeState;
const writePreviewRuntimeState: typeof writeLocalRuntimeState = (
  worktree,
  state,
) =>
  worktreeActivity.write(worktree, () =>
    writeLocalRuntimeState(worktree, state),
  );
const readProjectPreviewManifest = readLocalPreviewManifest;

function previewRuntimeContainerState(service: ServiceState) {
  return {
    exitCode: service.exitCode,
    health: service.health,
    service: service.id,
    status: service.state,
  };
}

async function previewProbesPass(worktree: string) {
  const passed = await localPreviewProbesPass(worktree);
  if (!passed)
    await appendRecoveryLog(worktree, "preview functional check failed");
  return passed;
}

function setupRunningForWorktree(worktree: string) {
  return Array.from(setupRuns.values()).some(
    (run) => run.worktree === worktree,
  );
}

async function runPreviewRecovery(
  input: EnsureProjectPreviewUrlInput,
  worktree: string,
) {
  const operation = beginExecutionOperation(
    input,
    previewStartOperationName,
    worktree,
  );
  void enrichExecutionRepositoryCohorts(operation, worktree);
  const action = () => recoverProjectPreview(worktree);
  return runExecutionOperation(operation, action, (result) =>
    result ? "succeeded" : "canceled",
  );
}

async function recoverProjectPreview(worktree: string) {
  if (await previewRuntimeStopped(worktree)) return null;
  if (removedWorktrees.has(worktree)) return null;
  if (removingWorktrees.has(worktree)) return null;
  await appendRecoveryLog(worktree, "compose starting");
  // A recovery is a start: it owns the lifecycle until it settles.
  return trackLocalPreviewOperation(worktree, async () => {
    try {
      const previewUrl = await startProjectCompose(worktree);
      await appendRecoveryLog(
        worktree,
        previewUrl
          ? `preview ready at ${previewUrl}`
          : "run configuration ready",
      );
      await settleRecoveredPreview(worktree);
      return previewUrl ?? null;
    } catch (error) {
      await stopProjectLogStream(worktree);
      await appendRecoveryLog(worktree, errorMessage(error).trim());
      const state = await readPreviewRuntimeFileState(worktree);
      if (state.desiredStatus === "running" && state.selectedConfigurationId)
        await persistLocalPreviewFailure(
          worktree,
          state.selectedConfigurationId,
          "running",
          error,
          writePreviewRuntimeState,
        );
      throw error;
    }
  });
}

async function settleRecoveredPreview(worktree: string) {
  const state = await readPreviewRuntimeFileState(worktree);
  if (state.desiredStatus !== "running") return;
  await writePreviewRuntimeState(worktree, {
    ...state,
    lifecycle: readyLocalPreviewLifecycle(),
  });
}

export async function shutdownWorkspaceProcesses() {
  Array.from(setupRuns.values()).forEach((run) => {
    run.abort.abort();
    finishSetupRun(run, "canceled");
  });
  setupRuns.clear();
  for (const stream of projectLogStreams.values()) stream.abort.abort();
  for (const stream of projectServiceLogStreams.values()) {
    stream.stopped = true;
    stream.abort?.abort();
  }
  projectLogStreams.clear();
  projectServiceLogStreams.clear();
  await flushRunLogs();
}

async function stopSetupRunsForWorktree(worktree: string) {
  for (const run of Array.from(setupRuns.values())) {
    if (run.worktree !== worktree) continue;
    run.abort.abort();
    finishSetupRun(run, "canceled");
  }
}

async function listProjectServices(worktreeInput: string) {
  const worktree = resolveRuntimePath(worktreeInput);
  const manifest = await readProjectPreviewManifest(worktree).catch(
    () => undefined,
  );
  return (manifest?.services.map(({ id }) => id) ?? []).sort(serviceSort);
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
  stream.abort = new AbortController();
  const result = await followLocalPreviewLogs(
    stream.worktree,
    stream.service,
    (chunk) => {
      stream.hasOutput = true;
      emitProjectServiceLog(streamId, "stdout", chunk);
    },
    stream.abort.signal,
  ).catch((error: unknown) => {
    emitProjectServiceLog(streamId, "stderr", errorMessage(error));
    return undefined;
  });
  if (projectServiceLogStreams.get(streamId) !== stream) return;
  stream.abort = undefined;
  if (stream.stopped || stream.hasOutput) {
    projectServiceLogStreams.delete(streamId);
    emitProjectServiceLog(streamId, "exit", String(result?.exitCode ?? ""));
    return;
  }
  void fallbackProjectServiceLog(streamId, stream, result?.exitCode ?? null);
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

// Compose prefixes each line of a service with its container name, such
// as "api-1  | ": a line that only mentions the service is not its output.
function archivedServiceLogSection(log: string, service: string) {
  const prefix = new RegExp(
    `^${service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\s+\\|`,
  );
  const lines = log.split("\n").filter((line) => prefix.test(line));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

async function stopProjectServiceLogs(streamId: string) {
  const stream = projectServiceLogStreams.get(streamId);
  if (!stream) return false;
  stream.stopped = true;
  if (stream.retry) clearTimeout(stream.retry);
  projectServiceLogStreams.delete(streamId);
  stream.abort?.abort();
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
  const result = await localPreviewLogs(worktree, service, {
    tail: serviceLogTailLines(tailLines),
    timeoutMs: timeoutMs ?? 15_000,
  }).catch((error: unknown) => ({
    exitCode: 1,
    stdout: "",
    stderr: errorMessage(error),
  }));
  if (result?.exitCode === 0 && (result.stdout || result.stderr))
    return {
      available: true,
      source: "container",
      stderr: result.stderr,
      stdout: result.stdout,
    };
  return projectServiceLogFallback(
    worktree,
    service,
    result?.exitCode ? new Error(result.stderr) : undefined,
  );
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

// Follows the services' logs into the run log while the preview runs.
async function startProjectLogStream(worktree: string) {
  if (worktreeActivity.isClosed(worktree)) return;
  await stopProjectLogStream(worktree);
  await appendRunLogSection(worktree, "container logs");
  if (worktreeActivity.isClosed(worktree)) return;
  const stream: ProjectLogStream = { abort: new AbortController() };
  projectLogStreams.set(worktree, stream);
  void followLocalPreviewLogs(
    worktree,
    undefined,
    (chunk) => appendRunLog(worktree, chunk),
    stream.abort.signal,
  )
    .catch(() => undefined)
    .finally(() => {
      if (projectLogStreams.get(worktree) === stream)
        projectLogStreams.delete(worktree);
    });
}

async function stopProjectLogStream(worktree: string) {
  const stream = projectLogStreams.get(worktree);
  if (!stream) return;
  projectLogStreams.delete(worktree);
  stream.abort.abort();
}

async function timedRecoveryStep<T>(
  worktree: string,
  label: string,
  action: () => Promise<T> | T,
) {
  const start = Date.now();
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
    if (lifecycle?.status !== "pending" || lifecycle.phase !== "starting")
      return;
    await writePreviewRuntimeState(worktree, {
      ...state,
      lifecycle: { ...lifecycle, step },
    });
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

async function ensureWorkspaceGitRepository(
  root: string,
  mode?: WorkspaceMode,
) {
  return ensureGitRepository(
    root,
    mode
      ? workspaceExecution(mode)
      : runtimeManagedPath(root)
        ? "virtualized"
        : undefined,
  );
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

async function assertRemovableWorktree(
  repositoryRoot: string,
  worktree: string,
) {
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

function setupLogPath(worktree: string) {
  return localPreviewPaths(worktree).setupLog;
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

async function projectRuntimeHealthy(worktreeInput: string) {
  return localPreviewHealthy(resolveRuntimePath(worktreeInput));
}

async function previewResponds(url: string) {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(previewRequestTimeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status < 500;
  } catch {
    return false;
  }
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
  appendRunLog(worktree, setupLogText(type, data));
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
