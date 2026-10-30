import * as React from "react"
import { toast } from "sonner"

import type {
  GitLogCommit,
  GitStatusFile,
  GitStatusResult,
  WorkspaceClient,
} from "@/context/platform"
import { useCloudAuth } from "@/context/cloud-auth"
import { useGitIdentity } from "@/context/git-identity"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { useModelSelection } from "@/components/model/model-selection"
import { GitConflictDialog } from "@/components/git/git-conflict-dialog"
import { GitHistoryPanel } from "@/components/git/git-history-panel"
import { GitInspectorPanel } from "@/components/git/git-inspector-panel"
import { GitWorkspacePanel } from "@/components/git/git-workspace-panel"
import type { GitSelection } from "@/components/git/git-types"
import {
  gitCommitSelection,
  gitFileSelection,
} from "@/components/git/git-types"
import { Button } from "@/components/ui/button"
import { projectCodePractices } from "@/lib/project-code-practices"
import {
  gitCommitTotal,
  gitConflictFiles,
  gitConflictFingerprint,
  type GitRefreshOptions,
  gitStateFingerprint,
  selectedDiff,
  startGitStateMonitor,
  startSelectedDiffMonitor,
} from "./git-state-monitor"

type GitAction = (root: string, workspace: WorkspaceClient) => Promise<unknown>

type LoadMoreGitCommitsInput = {
  commitsRef: React.RefObject<GitLogCommit[]>
  commitTotalRef: React.RefObject<number | undefined>
  hasMoreCommitsRef: React.RefObject<boolean>
  loadedCommitCountRef: React.RefObject<number>
  loadingMoreCommitsRef: React.RefObject<boolean>
  root: string | undefined
  setCommits: React.Dispatch<React.SetStateAction<GitLogCommit[]>>
  setError(value: string): void
  setHasMoreCommits(value: boolean): void
  setLoadingMoreCommits(value: boolean): void
  workspace: WorkspaceClient | undefined
}
const gitLogPageSize = 100

export function GitPage() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const alternativeSelection = useModelSelection({ role: "alternative" })
  const root = projects.activeProject?.path
  const git = useGitController(root, platform.workspace)
  const conflicts = React.useMemo(
    () => gitConflictFiles(git.status),
    [git.status]
  )
  const conflictFingerprint = React.useMemo(
    () => gitConflictFingerprint(conflicts),
    [conflicts]
  )
  const [conflictDialogOpen, setConflictDialogOpen] = React.useState(false)
  const [conflictAgentResolving, setConflictAgentResolving] =
    React.useState(false)
  const [commitMessageGenerating, setCommitMessageGenerating] =
    React.useState(false)
  const openedConflictFingerprintRef = React.useRef("")
  const generateCommitMessageWithAgent = React.useCallback(async () => {
    const selectedPaths = selectedGitFilePaths(
      git.status,
      git.selectedFilePaths
    )
    const validationError = generateCommitMessageValidationError(
      auth,
      platform,
      root,
      alternativeSelection.currentModel,
      selectedPaths,
      conflicts
    )
    if (validationError) {
      toast.error("Unable to generate commit message", {
        description: validationError,
        position: "bottom-right",
      })
      return
    }
    const toastId = "git-ai-commit-message-generation"
    setCommitMessageGenerating(true)
    git.setError("")
    toast.loading("Generating commit message", {
      id: toastId,
      position: "bottom-right",
    })
    try {
      const codePractices = await projectCodePractices(auth, projects)
      const result = await platform.agent!.generateCommitMessage({
        apiConnection: auth.apiConnection,
        providerId: alternativeSelection.currentModel!.provider.id,
        modelId: alternativeSelection.currentModel!.id,
        credentialLabel: alternativeSelection.currentModel!.credentialLabel,
        reasoningEffort: alternativeSelection.currentVariant,
        repositoryRoot: root!,
        worktree: root!,
        selectedPaths,
        title: "Git commit",
        summary: `Generate a commit message for ${selectedPaths.length} selected file${
          selectedPaths.length > 1 ? "s" : ""
        }.`,
        codePractices,
      })
      git.setCommitMessage(result.message)
      toast.success("Commit message generated", {
        id: toastId,
        position: "bottom-right",
      })
    } catch (error) {
      const message = errorText(error)
      git.setError(message)
      toast.error("Commit message generation failed", {
        description: message,
        id: toastId,
        position: "bottom-right",
      })
    } finally {
      setCommitMessageGenerating(false)
    }
  }, [
    alternativeSelection.currentModel,
    alternativeSelection.currentVariant,
    auth,
    conflicts,
    git,
    platform,
    projects,
    root,
  ])
  const resolveConflictsWithAgent = React.useCallback(async () => {
    const validationError = resolveMergeConflictsValidationError(
      auth,
      platform,
      root,
      alternativeSelection.currentModel,
      conflicts
    )
    if (validationError) {
      toast.error("Unable to resolve conflicts with AI", {
        description: validationError,
        position: "bottom-right",
      })
      return
    }
    const toastId = "git-ai-merge-conflict-resolution"
    setConflictAgentResolving(true)
    git.setError("")
    toast.loading("Resolving conflicts with AI", {
      id: toastId,
      position: "bottom-right",
    })
    try {
      const codePractices = await projectCodePractices(auth, projects)
      const result = await platform.agent!.resolveMergeConflicts({
        apiConnection: auth.apiConnection,
        providerId: alternativeSelection.currentModel!.provider.id,
        modelId: alternativeSelection.currentModel!.id,
        credentialLabel: alternativeSelection.currentModel!.credentialLabel,
        reasoningEffort: alternativeSelection.currentVariant,
        repositoryRoot: root!,
        worktree: root!,
        targetBranch: git.status?.branch.current,
        title: "Resolve Git merge conflicts",
        summary: `Resolve ${conflicts.length} conflicted file${conflicts.length > 1 ? "s" : ""} in the active repository.`,
        codePractices,
      })
      await git.refresh({ quiet: true })
      if (result.resolved) {
        setConflictDialogOpen(false)
        toast.success("Merge conflicts resolved", {
          id: toastId,
          position: "bottom-right",
        })
      } else {
        toast.error("AI could not resolve every conflict", {
          description: result.conflicts.join(", "),
          id: toastId,
          position: "bottom-right",
        })
      }
    } catch (error) {
      const message = errorText(error)
      git.setError(message)
      toast.error("AI conflict resolution failed", {
        description: message,
        id: toastId,
        position: "bottom-right",
      })
    } finally {
      setConflictAgentResolving(false)
    }
  }, [
    alternativeSelection.currentModel,
    alternativeSelection.currentVariant,
    auth,
    conflicts,
    git,
    platform,
    projects,
    root,
  ])

  React.useEffect(() => {
    if (conflicts.length === 0) {
      openedConflictFingerprintRef.current = ""
      return
    }
    if (openedConflictFingerprintRef.current === conflictFingerprint) return
    openedConflictFingerprintRef.current = conflictFingerprint
    setConflictDialogOpen(true)
  }, [conflictFingerprint, conflicts.length])

  if (!root || !platform.workspace) return <GitUnavailable />

  return (
    <div className="flex h-svh min-h-0 min-w-0 flex-col gap-4 overflow-hidden px-4 pt-[calc(var(--header-height)+1rem)] pb-4 md:h-[calc(100svh_-_1rem)] lg:px-6 lg:pt-[calc(var(--header-height)+1.5rem)] lg:pb-6">
      {git.error ? (
        <GitError message={git.error} onDismiss={git.clearError} />
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto xl:grid-cols-[18rem_minmax(22rem,30rem)_minmax(0,1fr)] xl:overflow-visible">
        <GitWorkspacePanel
          busy={git.busy}
          commitMessage={git.commitMessage}
          generatingCommitMessage={commitMessageGenerating}
          loading={git.loading}
          selected={git.selected}
          selectedFilePaths={git.selectedFilePaths}
          status={git.status}
          onCommit={git.commit}
          onCommitMessageChange={git.setCommitMessage}
          onCommitPush={git.commitPush}
          onClearSelection={git.clearFileSelection}
          onDeleteFile={git.deleteFile}
          onFileSelect={git.setSelected}
          onGenerateCommitMessage={generateCommitMessageWithAgent}
          onGitAddFile={git.gitAddFile}
          onRefresh={git.refresh}
          onRollbackFile={git.rollbackFile}
          onSelectAll={git.selectAllFiles}
          onSelectFile={git.selectFile}
          onSelectFiles={git.selectFiles}
          onUnselectFile={git.unselectFile}
          onUnselectFiles={git.unselectFiles}
        />
        <GitHistoryPanel
          commits={git.commits}
          commitTotal={git.commitTotal}
          hasMoreCommits={git.hasMoreCommits}
          loading={git.loading}
          loadingMore={git.loadingMoreCommits}
          query={git.query}
          selected={git.selected}
          onCommitSelect={git.setSelected}
          onLoadMore={git.loadMoreCommits}
          onQueryChange={git.setQuery}
        />
        <GitInspectorPanel
          commits={git.commits}
          diff={git.diff}
          diffLoading={git.diffLoading}
          selected={git.selected}
          status={git.status}
        />
      </div>
      <GitConflictDialog
        agentResolving={conflictAgentResolving}
        conflicts={conflicts}
        open={conflictDialogOpen}
        root={root}
        workspace={platform.workspace}
        onError={git.setError}
        onOpenChange={setConflictDialogOpen}
        onRefresh={git.refresh}
        onResolveWithAgent={resolveConflictsWithAgent}
      />
    </div>
  )
}

function useGitController(root?: string, workspace?: WorkspaceClient) {
  const gitIdentity = useGitIdentity()
  const [busy, setBusy] = React.useState<string>()
  const [commitMessage, setCommitMessage] = React.useState("")
  const [commits, setCommits] = React.useState<GitLogCommit[]>([])
  const [commitTotal, setCommitTotal] = React.useState<number>()
  const [diff, setDiff] = React.useState("")
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [hasMoreCommits, setHasMoreCommits] = React.useState(true)
  const [loading, setLoading] = React.useState(Boolean(root && workspace))
  const [loadingMoreCommits, setLoadingMoreCommits] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState<GitSelection>()
  const [selectedFilePaths, setSelectedFilePaths] = React.useState(
    () => new Set<string>()
  )
  const [status, setStatus] = React.useState<GitStatusResult>()
  const [stateVersion, setStateVersion] = React.useState(0)
  const busyRef = React.useRef<string | undefined>(undefined)
  const commitsRef = React.useRef<GitLogCommit[]>([])
  const commitTotalRef = React.useRef<number | undefined>(undefined)
  const diffRef = React.useRef("")
  const fileSelectionInitialized = React.useRef(false)
  const hasMoreCommitsRef = React.useRef(true)
  const loadedCommitCountRef = React.useRef(gitLogPageSize)
  const loadingMoreCommitsRef = React.useRef(false)
  const stateFingerprintRef = React.useRef("")

  const refresh = React.useCallback(
    async (options: GitRefreshOptions = {}) => {
      if (!root || !workspace) return
      if (!options.quiet) setLoading(true)
      try {
        const [nextStatus, nextCommits, nextCommitTotal] = await Promise.all([
          workspace.gitStatus({ root }),
          workspace.gitLog({ root, limit: loadedCommitCountRef.current }),
          gitCommitTotal(root, workspace),
        ])
        const nextFingerprint = gitStateFingerprint(nextStatus, nextCommits)
        const stateChanged = nextFingerprint !== stateFingerprintRef.current
        stateFingerprintRef.current = nextFingerprint
        loadedCommitCountRef.current = Math.max(
          gitLogPageSize,
          nextCommits.length
        )
        hasMoreCommitsRef.current = moreGitCommitsAvailable(
          nextCommits.length,
          loadedCommitCountRef.current,
          nextCommitTotal
        )
        commitTotalRef.current = nextCommitTotal
        setStatus(nextStatus)
        setCommits(nextCommits)
        setCommitTotal(nextCommitTotal)
        setHasMoreCommits(hasMoreCommitsRef.current)
        setSelected((current) =>
          resolveSelection(current, nextStatus, nextCommits)
        )
        if (stateChanged) setStateVersion((current) => current + 1)
      } catch (error) {
        setError(errorText(error))
      } finally {
        if (!options.quiet) setLoading(false)
      }
    },
    [root, workspace]
  )

  React.useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  React.useEffect(() => {
    fileSelectionInitialized.current = false
    loadedCommitCountRef.current = gitLogPageSize
    stateFingerprintRef.current = ""
  }, [root])

  React.useEffect(() => {
    busyRef.current = busy
  }, [busy])

  React.useEffect(() => {
    commitsRef.current = commits
  }, [commits])

  React.useEffect(() => {
    diffRef.current = diff
  }, [diff])

  React.useEffect(() => {
    hasMoreCommitsRef.current = hasMoreCommits
  }, [hasMoreCommits])

  React.useEffect(() => {
    loadingMoreCommitsRef.current = loadingMoreCommits
  }, [loadingMoreCommits])

  React.useEffect(() => {
    return startGitStateMonitor(
      root,
      workspace,
      busyRef,
      stateFingerprintRef,
      refresh
    )
  }, [refresh, root, workspace])

  React.useEffect(() => {
    return startSelectedDiffMonitor(
      root,
      workspace,
      selected,
      busyRef,
      diffRef,
      setDiff
    )
  }, [root, selected, workspace])

  React.useEffect(() => {
    if (!status) return
    const includeStaged = !fileSelectionInitialized.current
    fileSelectionInitialized.current = true
    setSelectedFilePaths((current) =>
      reconcileSelectedFilePaths(current, status, includeStaged)
    )
  }, [status])

  React.useEffect(() => {
    return loadSelectionDiff(
      root,
      workspace,
      selected,
      setDiff,
      setDiffLoading,
      setError
    )
  }, [root, selected, stateVersion, workspace])

  const runAction = React.useCallback(
    (label: string, action: GitAction) => {
      void runGitAction(
        label,
        action,
        root,
        workspace,
        refresh,
        setBusy,
        setError,
        gitIdentity?.handleError
      )
    },
    [gitIdentity, refresh, root, workspace]
  )

  const loadMoreCommits = React.useCallback(
    () =>
      loadMoreGitCommits({
        commitTotalRef,
        root,
        workspace,
        commitsRef,
        hasMoreCommitsRef,
        loadingMoreCommitsRef,
        loadedCommitCountRef,
        setCommits,
        setError,
        setHasMoreCommits,
        setLoadingMoreCommits,
      }),
    [root, workspace]
  )

  return {
    busy,
    commit: () =>
      runAction(
        "Committing",
        commitAction(
          commitMessage,
          selectedFilePaths,
          status,
          setCommitMessage,
          setSelectedFilePaths
        )
      ),
    commitMessage,
    commitTotal,
    commitPush: () =>
      runAction(
        "Committing and pushing",
        commitPushAction(
          commitMessage,
          selectedFilePaths,
          status,
          setCommitMessage,
          setSelectedFilePaths
        )
      ),
    commits,
    diff,
    diffLoading,
    error,
    deleteFile: (path: string) =>
      runAction(
        "Deleting file",
        gitDeleteFileAction(path, setSelectedFilePaths)
      ),
    gitAddFile: (path: string) =>
      runAction(
        "Git add",
        gitAddFileAction(path, setSelected, setSelectedFilePaths)
      ),
    hasMoreCommits,
    loadMoreCommits,
    loading,
    loadingMoreCommits,
    query,
    refresh,
    rollbackFile: (path: string) =>
      runAction(
        "Rolling back file",
        gitRollbackFileAction(path, status, setSelectedFilePaths)
      ),
    selected,
    selectedFilePaths,
    setCommitMessage,
    setQuery,
    setSelected,
    selectAllFiles: () => setSelectedFilePaths(statusFilePathSet(status)),
    selectFile: (path: string) =>
      setSelectedFilePaths((current) => addFilePaths(current, [path])),
    selectFiles: (paths: string[]) =>
      setSelectedFilePaths((current) => addFilePaths(current, paths)),
    status,
    setError,
    clearFileSelection: () => setSelectedFilePaths(new Set()),
    unselectFile: (path: string) =>
      setSelectedFilePaths((current) => removeFilePaths(current, [path])),
    unselectFiles: (paths: string[]) =>
      setSelectedFilePaths((current) => removeFilePaths(current, paths)),
    clearError: () => setError(""),
  }
}

function resolveMergeConflictsValidationError(
  auth: ReturnType<typeof useCloudAuth>,
  platform: ReturnType<typeof usePlatform>,
  root: string | undefined,
  model: unknown,
  conflicts: GitStatusFile[]
) {
  if (!root) return "Unable to resolve the active project."
  if (conflicts.length === 0) return "There are no merge conflicts to resolve."
  if (auth.status !== "authenticated")
    return "Reconnect the provider before resolving conflicts."
  if (!model) return "Select a model before resolving conflicts."
  if (!platform.agent?.resolveMergeConflicts)
    return "Desktop agent runtime is not available."
}

function generateCommitMessageValidationError(
  auth: ReturnType<typeof useCloudAuth>,
  platform: ReturnType<typeof usePlatform>,
  root: string | undefined,
  model: unknown,
  selectedPaths: string[],
  conflicts: GitStatusFile[]
) {
  if (!root) return "Unable to resolve the active project."
  if (selectedPaths.length === 0)
    return "Select files before generating a commit message."
  if (conflicts.length > 0)
    return "Resolve conflicts before generating a commit message."
  if (auth.status !== "authenticated")
    return "Reconnect the provider before generating a commit message."
  if (!model) return "Select a model before generating a commit message."
  if (!platform.agent?.generateCommitMessage)
    return "Desktop agent runtime is not available."
}

function selectedGitFilePaths(
  status: GitStatusResult | undefined,
  selectedFilePaths: ReadonlySet<string>
) {
  return (
    status?.files
      .filter((file) => selectedFilePaths.has(file.path))
      .map((file) => file.path) ?? []
  )
}

function moreGitCommitsAvailable(
  loadedCount: number,
  requestedCount: number,
  totalCount: number | undefined
) {
  if (totalCount === undefined) return loadedCount >= requestedCount
  return loadedCount < totalCount
}

async function loadMoreGitCommits(input: LoadMoreGitCommitsInput) {
  const { root, workspace } = input
  if (!root || !workspace || !canLoadMoreGitCommits(input)) return
  input.loadingMoreCommitsRef.current = true
  input.setLoadingMoreCommits(true)
  try {
    const nextCommits = await workspace.gitLog({
      root,
      limit: gitLogPageSize,
      skip: input.commitsRef.current.length,
    })
    input.setCommits((current) => appendGitCommits(current, nextCommits))
    input.loadedCommitCountRef.current += nextCommits.length
    input.hasMoreCommitsRef.current = moreGitCommitsAvailable(
      input.loadedCommitCountRef.current,
      input.loadedCommitCountRef.current,
      input.commitTotalRef.current
    )
    if (nextCommits.length === 0) input.hasMoreCommitsRef.current = false
    input.setHasMoreCommits(input.hasMoreCommitsRef.current)
  } catch (error) {
    input.setError(errorText(error))
  } finally {
    input.loadingMoreCommitsRef.current = false
    input.setLoadingMoreCommits(false)
  }
}

function canLoadMoreGitCommits(input: LoadMoreGitCommitsInput) {
  return input.hasMoreCommitsRef.current && !input.loadingMoreCommitsRef.current
}

function appendGitCommits(
  current: GitLogCommit[],
  nextCommits: GitLogCommit[]
) {
  const hashes = new Set(current.map((commit) => commit.hash))
  const uniqueCommits = nextCommits.filter((commit) => !hashes.has(commit.hash))
  return [...current, ...uniqueCommits]
}

function loadSelectionDiff(
  root: string | undefined,
  workspace: WorkspaceClient | undefined,
  selected: GitSelection | undefined,
  setDiff: (value: string) => void,
  setDiffLoading: (value: boolean) => void,
  setError: (value: string) => void
) {
  if (!root || !workspace || !selected) {
    setDiff("")
    setDiffLoading(false)
    return
  }
  let cancelled = false
  setDiffLoading(true)
  selectedDiff(root, workspace, selected)
    .then((nextDiff) => {
      if (!cancelled) setDiff(nextDiff)
    })
    .catch((error) => {
      if (!cancelled) setError(errorText(error))
    })
    .finally(() => {
      if (!cancelled) setDiffLoading(false)
    })
  return () => {
    cancelled = true
  }
}

async function runGitAction(
  label: string,
  action: GitAction,
  root: string | undefined,
  workspace: WorkspaceClient | undefined,
  refresh: () => Promise<void>,
  setBusy: (value: string | undefined) => void,
  setError: (value: string) => void,
  // Opens the Git identity dialog for Git asking who you are.
  askIdentity?: (error: unknown, onSaved: () => void) => boolean
) {
  if (!root || !workspace) return
  setBusy(label)
  setError("")
  try {
    await action(root, workspace)
    await refresh()
    toast.success(actionSuccess(label))
  } catch (error) {
    const message = errorText(error)
    const retry = () =>
      void runGitAction(
        label,
        action,
        root,
        workspace,
        refresh,
        setBusy,
        setError
      )
    if (askIdentity?.(message, retry)) return
    setError(message)
    toast.error(message)
  } finally {
    setBusy(undefined)
  }
}

function resolveSelection(
  selected: GitSelection | undefined,
  status: GitStatusResult,
  commits: GitLogCommit[]
) {
  if (selectionStillExists(selected, status, commits)) return selected
  const changeFile = status.files.find((file) => !file.untracked)
  if (changeFile) return gitFileSelection(changeFile.path, changeFile.staged)
  const unversionedFile = status.files.find((file) => file.untracked)
  if (unversionedFile) return gitFileSelection(unversionedFile.path, false)
  return commits[0] ? gitCommitSelection(commits[0].hash) : undefined
}

function selectionStillExists(
  selected: GitSelection | undefined,
  status: GitStatusResult,
  commits: GitLogCommit[]
) {
  if (!selected) return false
  if (selected.type === "commit")
    return commits.some((commit) => commit.hash === selected.hash)
  return status.files.some(
    (file) =>
      file.path === selected.path &&
      (selected.staged ? file.staged : file.unstaged)
  )
}

function gitAddFileAction(
  path: string,
  setSelected: (selection: GitSelection) => void,
  setSelectedFilePaths: React.Dispatch<React.SetStateAction<Set<string>>>
): GitAction {
  return async (root, workspace) => {
    await workspace.gitStageFiles({ root, paths: [path] })
    setSelected(gitFileSelection(path, true))
    setSelectedFilePaths((current) => addFilePaths(current, [path]))
  }
}

function gitRollbackFileAction(
  path: string,
  status: GitStatusResult | undefined,
  setSelectedFilePaths: React.Dispatch<React.SetStateAction<Set<string>>>
): GitAction {
  return async (root, workspace) => {
    if (gitAddedFile(status, path)) {
      await workspace.gitUnstageFiles({ root, paths: [path] })
    } else {
      await workspace.gitRollbackFiles({ root, paths: [path] })
    }
    setSelectedFilePaths((current) => removeFilePaths(current, [path]))
  }
}

function gitAddedFile(status: GitStatusResult | undefined, path: string) {
  return (
    status?.files.some(
      (file) => file.path === path && file.staged && file.status === "added"
    ) ?? false
  )
}

function gitDeleteFileAction(
  path: string,
  setSelectedFilePaths: React.Dispatch<React.SetStateAction<Set<string>>>
): GitAction {
  return async (root, workspace) => {
    await workspace.gitDeleteFiles({ root, paths: [path] })
    setSelectedFilePaths((current) => removeFilePaths(current, [path]))
  }
}

function commitAction(
  message: string,
  selectedFilePaths: ReadonlySet<string>,
  status: GitStatusResult | undefined,
  setCommitMessage: (value: string) => void,
  setSelectedFilePaths: (paths: Set<string>) => void
): GitAction {
  return async (root, workspace) => {
    await prepareSelectedFiles(root, workspace, status, selectedFilePaths)
    await workspace.gitCommit({ root, message })
    setCommitMessage("")
    setSelectedFilePaths(new Set())
  }
}

function commitPushAction(
  message: string,
  selectedFilePaths: ReadonlySet<string>,
  status: GitStatusResult | undefined,
  setCommitMessage: (value: string) => void,
  setSelectedFilePaths: (paths: Set<string>) => void
): GitAction {
  return async (root, workspace) => {
    await prepareSelectedFiles(root, workspace, status, selectedFilePaths)
    await workspace.gitCommit({ root, message })
    setCommitMessage("")
    setSelectedFilePaths(new Set())
    await workspace.gitPush({ root })
  }
}

async function prepareSelectedFiles(
  root: string,
  workspace: WorkspaceClient,
  status: GitStatusResult | undefined,
  selectedFilePaths: ReadonlySet<string>
) {
  if (gitConflictFiles(status).length > 0)
    throw new Error("Resolve merge conflicts before committing")
  const pathsToStage = selectedStatusPaths(status, selectedFilePaths)
  const pathsToUnstage = unselectedStagedPaths(status, selectedFilePaths)
  if (pathsToStage.length === 0)
    throw new Error("Select files before committing")
  if (pathsToUnstage.length > 0) {
    await workspace.gitUnstageFiles({ root, paths: pathsToUnstage })
  }
  await workspace.gitStageFiles({ root, paths: pathsToStage })
}

function selectedStatusPaths(
  status: GitStatusResult | undefined,
  selectedFilePaths: ReadonlySet<string>
) {
  return (
    status?.files
      .filter((file) => selectedFilePaths.has(file.path))
      .map((file) => file.path) ?? []
  )
}

function unselectedStagedPaths(
  status: GitStatusResult | undefined,
  selectedFilePaths: ReadonlySet<string>
) {
  return (
    status?.files
      .filter((file) => file.staged && !selectedFilePaths.has(file.path))
      .map((file) => file.path) ?? []
  )
}

function reconcileSelectedFilePaths(
  current: Set<string>,
  status: GitStatusResult,
  includeStaged: boolean
) {
  const statusPaths = statusFilePathSet(status)
  const next = new Set([...current].filter((path) => statusPaths.has(path)))
  if (includeStaged) addStagedFilePaths(next, status)
  return sameFilePathSet(current, next) ? current : next
}

function addStagedFilePaths(paths: Set<string>, status: GitStatusResult) {
  for (const file of status.files) {
    if (file.staged) paths.add(file.path)
  }
}

function statusFilePathSet(status: GitStatusResult | undefined) {
  return new Set(status?.files.map((file) => file.path) ?? [])
}

function addFilePaths(current: Set<string>, paths: string[]) {
  const next = new Set(current)
  for (const path of paths) next.add(path)
  return next
}

function removeFilePaths(current: Set<string>, paths: string[]) {
  const next = new Set(current)
  for (const path of paths) next.delete(path)
  return next
}

function sameFilePathSet(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false
  for (const path of left) {
    if (!right.has(path)) return false
  }
  return true
}

function GitError({
  message,
  onDismiss,
}: {
  message: string
  onDismiss(): void
}) {
  return (
    <div className="flex items-center gap-3 border-t border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <span className="min-w-0 flex-1 truncate">{message}</span>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}

function GitUnavailable() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md rounded-md border p-6 text-center">
        <h2 className="font-heading text-lg font-semibold">
          Git is unavailable
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Open Blame in the desktop workspace to use repository actions.
        </p>
      </div>
    </div>
  )
}

function actionSuccess(label: string) {
  if (label === "Committing") return "Commit created"
  if (label === "Committing and pushing") return "Commit pushed"
  if (label === "Deleting file") return "File deleted"
  if (label === "Git add") return "File added to Git"
  if (label === "Rolling back file") return "File changes rolled back"
  return "Git action completed"
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Git operation failed"
}
