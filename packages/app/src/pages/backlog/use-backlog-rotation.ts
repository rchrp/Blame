import * as React from "react"
import { toast } from "sonner"
import type { RuntimeProfileId } from "@blame/preview-runtime"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { userStoryDisplayId } from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { storyPreviewDevtoolsScope } from "@/components/backlog/shared/preview-devtools-scope"
import { directStoryPreviewScope } from "@/components/backlog/board/project-run-configuration"
import { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { hostedServiceRequirement } from "@/lib/hosted-service-access"
import type { HostDependencyReport } from "@/context/platform"
import { useRuntimeGate } from "@/pages/backlog/use-runtime-gate"
import { useGitIdentity } from "@/context/git-identity"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"
import { effectiveProjectCodePractices } from "@/lib/project-code-practice-preferences"
import { currentPersonalization } from "@/lib/agent-personalization"
import { storyMaxInputTokens } from "@/components/backlog/data/story-context-limit"
import {
  prepareStartingStoryPreview,
  useStoryPreviewPreparation,
} from "@/pages/backlog/story-preview-preparation"
import {
  notifyDirectFallback,
  storyInitializationGate,
} from "@/pages/backlog/backlog-initialization-gate"
import { type StoryRunMode, useStoryRunMode } from "@/lib/runtime-preference"
import {
  errorMessage,
  type HostDependenciesDialogState,
  reportAgentPersistenceError,
  previewRecoveryStateKey,
  queuedStories,
  rotationBlocker,
  maxConcurrentDevelopmentStories,
  runningStories,
} from "./backlog-rotation-helpers"
import { previewRecoveryStories } from "./preview-recovery-stories"
import {
  storyMessage,
  storySessionSettings,
  withAgentModel,
} from "./story-engine"
import { readStoryAttachment } from "./story-attachment"

const blockerRetryDelay = 30_000
const previewRecoveryIntervalMs = 30_000
const setupToastId = "backlog-rotation-setup"
const initializationRetryDelay = 5_000

// Starts the Agent Queue's stories on the engine. Their agents' state then
// follows their sessions (useStoryAgentOutcomes).
export function useBacklogRotation(backlog: ReturnType<typeof useBacklogStore>) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const gitIdentity = useGitIdentity()
  const projects = useProjects()
  const selection = useModelSelection({ role: "agent" })
  const premium = auth.license?.licensed === true
  const runMode = useStoryRunMode(premium)
  // Each story runs where it was set to run; older stories without a choice
  // follow the account default.
  const storyRunMode = React.useCallback(
    (story: UserStory): StoryRunMode => story.runMode ?? runMode,
    [runMode]
  )
  const ensureProjectPreviewUrl = platform.workspace?.ensureProjectPreviewUrl
  const startingStoryIds = React.useRef(new Set<string>())
  const blockedStories = React.useRef(new Map<string, number>())
  const reportedBlockers = React.useRef(new Set<string>())
  const agentAuthenticationBlockedUntil = React.useRef(0)
  const previewRecoveryStoryIds = React.useRef(new Set<string>())
  const storiesRef = React.useRef(backlog.stories)
  const startStoryRef = React.useRef<(story: UserStory) => Promise<void>>(
    async () => undefined
  )
  const reportBlockerRef = React.useRef<
    (story: UserStory, message: string) => void
  >(() => undefined)
  const [hostDependenciesDialog, setHostDependenciesDialog] =
    React.useState<HostDependenciesDialogState>()
  // Bumped to make the queue look again (after a retry delay, when the
  // runtime becomes ready…), even if no story changed.
  const [queueTick, refreshStartingStories] = React.useState(0)
  const runtimeGate = useRuntimeGate({
    onRuntimeReady: () => {
      blockedStories.current.clear()
      refreshStartingStories((value) => value + 1)
    },
    runModeOf: storyRunMode,
    stories: backlog.stories,
  })
  const previewRecoveryState = previewRecoveryStateKey(backlog.stories)
  useStoryPreviewPreparation(backlog)

  React.useEffect(() => {
    storiesRef.current = backlog.stories
  }, [backlog.stories])

  React.useEffect(() => {
    blockedStories.current.clear()
    reportedBlockers.current.clear()
    agentAuthenticationBlockedUntil.current = 0
    previewRecoveryStoryIds.current.clear()
  }, [projects.activeProject?.id, selection.currentModel?.id])

  async function startStory(story: UserStory) {
    if (!projects.activeProject) return
    const detailedStory = await backlog.loadDetail(story)
    const blocker = rotationBlocker(
      auth.status,
      platform,
      selection.currentModel
    )
    if (blocker) return reportBlocker(detailedStory, blocker)

    const projectInitialization = await createCloudApi(
      auth.apiConnection
    ).projectInitialization(projects.activeProject.id)
    const savedInitialization = projectInitialization.initialization
    const gate = storyInitializationGate(
      savedInitialization,
      projects.activeProject.id,
      storyRunMode(detailedStory)
    )
    if (gate === "wait") return retryStory(detailedStory)
    if (gate === "run-direct") return runDirectWithoutInitialization(detailedStory)
    // The agent starts with the saved preview environment; the story's
    // preview waits for it to be checked against the latest commits.
    const initialization =
      savedInitialization?.status === "done" && savedInitialization.previewManifest
        ? { ...savedInitialization, previewManifest: savedInitialization.previewManifest }
        : undefined

    const workspace = platform.workspace
    const engine = platform.engine
    if (!workspace || !engine) return

    const storyMode = storyRunMode(detailedStory)
    const direct = storyMode === "direct"
    const previewProfile: RuntimeProfileId = direct ? "local-container" : storyMode
    if (storyMode === "vercel-compose" && !premium)
      return reportCloudWithoutPremium(detailedStory)

    // Local Container stories wait for the Blame Runtime (or ask for it)
    // instead of failing; the runtime itself is checked by its provider.
    const runtimeDecision = direct ? "go" : runtimeGate.gate(detailedStory)
    if (runtimeDecision === "wait")
      return retryStory(detailedStory, initializationRetryDelay)
    if (runtimeDecision === "needs-runtime")
      return retryStory(detailedStory, blockerRetryDelay)

    const dependencies = await workspace.checkHostDependencies({
      includeRuntime: direct ? false : runtimeGate.hostCheckIncludesRuntime,
      runtimeProfile: previewProfile,
      workspaceMode: direct
        ? "direct"
        : storyMode === "local-container" ? "local-container" : "cloud-mirror",
    })
    if (!dependencies.ok) {
      reportHostDependencyBlocker(
        detailedStory,
        dependencies,
        previewProfile
      )
      return
    }
    // Git won't commit the story's work without a name and an email.
    const identityReady = await gitIdentity?.ensure({
      root: projects.activeProject.path,
      storyTitle: detailedStory.title,
      onSaved: () => retryStory(detailedStory, 0),
    })
    if (identityReady === false) return retryStory(detailedStory, blockerRetryDelay)

    const storyId = detailedStory.id
    const worktree = await workspace.createWorktree({
      branch: detailedStory.branch,
      // Direct runs in the project folder: no new worktree or branch.
      direct,
      repositoryRoot: projects.activeProject.path,
      runtimeProfile: previewProfile,
      storyId,
      storyReference: userStoryDisplayId(detailedStory),
      targetBranch: detailedStory.targetBranch,
      title: detailedStory.title,
    })
    if (!direct)
      prepareStartingStoryPreview(storyId, { environment: initialization })
    const workingStory = await backlog.update(detailedStory, {
      baseCommit:
        (
          await workspace.gitLog({
            root: worktree.worktree,
            limit: 1,
            currentBranchOnly: true,
          })
        )[0]?.hash ?? null,
      branch: worktree.branch,
      // Kept from the first run on: the story merges back where it started.
      // Direct works on the project folder's branch, whatever was chosen.
      targetBranch: direct
        ? worktree.targetBranch
        : (detailedStory.targetBranch ?? worktree.targetBranch),
      status: "in-progress",
      workspaceMode: worktree.workspaceMode,
      worktree: worktree.worktree,
    })
    const model = selection.currentModel
    const settings = storySessionSettings({
      story: { ...detailedStory, ...workingStory },
      model: {
        providerId: model.provider.id,
        modelId: model.id,
        credentialLabel: model.credentialLabel,
        reasoning: selection.currentVariant,
      },
      maxContextTokens: storyMaxInputTokens(
        detailedStory.id,
        model,
        selection.allProviders
      ),
      personalization: currentPersonalization(detailedStory.ambition),
      codePractices: effectiveProjectCodePractices(
        projectInitialization.practices
      ),
      // In Direct mode, the project's own app (Blame's project runner).
      previewDevtoolsScope: direct
        ? directStoryPreviewScope(
            initialization?.runConfigurations ?? [],
            projects.activeProject.path
          )
        : storyPreviewDevtoolsScope(detailedStory.id),
      initialization,
      platformName: platform.platform,
    })
    // A story keeps one conversation: a requeued story continues it.
    const session = detailedStory.engineSessionId ?? crypto.randomUUID()
    try {
      if (!detailedStory.engineSessionId)
        await engine.call("createSession", { session, ...settings })
      // Stopped, dequeued or discarded while it was starting: let it go.
      if (!storyStillStarting(storyId)) return
      await backlog.update(detailedStory, {
        agentLastError: null,
        agentModels: withAgentModel(detailedStory.agentModels, {
          modelId: model.id,
          providerId: model.provider.id,
          reasoningEffort: selection.currentVariant ?? null,
        }),
        agentStatus: "Running",
        engineSessionId: session,
      })
      await engine.call("send", {
        session,
        message: await storyMessage(
          detailedStory.summary,
          detailedStory.codeSelectionAttachments,
          detailedStory.fileAttachments,
          (file) => readStoryAttachment(auth.apiConnection, file)
        ),
        delivery: "turn",
        settings,
      })
    } catch (error) {
      // The story did not start: back to the queue (its worktree and its
      // conversation are reused on the next attempt).
      if (storyStillStarting(storyId)) {
        await backlog
          .update(detailedStory, {
            agentLastError: errorMessage(error),
            agentStatus: null,
            ...(detailedStory.engineSessionId ? {} : { engineSessionId: null }),
            status: "ready",
          })
          .catch(() => undefined)
      }
      throw error
    }
  }

  // Up to three agents at a time, whatever their mode. Direct stories share
  // the project folder with each other and with chats, as the Direct mode
  // picker warns; the harness checks each file again when it writes it.
  function storiesToStartNow(readyStories: UserStory[]) {
    const slots =
      maxConcurrentDevelopmentStories -
      runningStories(storiesRef.current) -
      startingStoryIds.current.size
    return readyStories.slice(0, Math.max(0, slots))
  }

  // No usable initialization: run the story Direct rather than wait for one.
  function runDirectWithoutInitialization(story: UserStory) {
    retryStory(story, 0)
    notifyDirectFallback(story.projectId, story.title)
    void backlog
      .update(story, { runMode: "direct" })
      .then(() => {
        blockedStories.current.delete(story.id)
        refreshStartingStories((value) => value + 1)
      })
      .catch(reportAgentPersistenceError)
  }

  // A Cloud Preview story whose owner no longer has Premium: ask where to
  // run it instead of switching silently.
  function reportCloudWithoutPremium(story: UserStory) {
    retryStory(story, blockerRetryDelay)
    const key = `${story.id}:cloud-without-premium`
    if (reportedBlockers.current.has(key)) return
    reportedBlockers.current.add(key)
    const switchTo = (mode: StoryRunMode) => {
      reportedBlockers.current.delete(key)
      void backlog
        .update(story, { runMode: mode })
        .then(() => {
          blockedStories.current.delete(story.id)
          refreshStartingStories((value) => value + 1)
        })
        .catch(reportAgentPersistenceError)
    }
    toast.error(hostedServiceRequirement(auth, "cloud-preview"), {
      action: { label: "Run Direct", onClick: () => switchTo("direct") },
      cancel: { label: "Local Container", onClick: () => switchTo("local-container") },
      description: `${story.title} is waiting. Run it on this computer instead?`,
      duration: Infinity,
      id: `${setupToastId}-${story.id}-cloud`,
      position: "bottom-right",
    })
  }

  // Still the story this start moved to in progress, untouched by the user.
  function storyStillStarting(storyId: string) {
    const current = storiesRef.current.find((story) => story.id === storyId)
    return current?.status === "in-progress" && current.agentStatus !== "Paused"
  }

  function reportBlocker(story: UserStory, message: string) {
    const key = `${story.id}:${message}`
    retryStory(story, blockerRetryDelay)
    // Git asking who you are gets its dialog, not a raw error.
    if (gitIdentity?.handleError(message, () => retryStory(story, 0))) return
    if (reportedBlockers.current.has(key)) return
    reportedBlockers.current.add(key)
    toast.error("User story stayed in Agent Queue", {
      description: message,
      id: `${setupToastId}-${story.id}`,
      position: "bottom-right",
    })
  }

  function reportHostDependencyBlocker(
    story: UserStory,
    report: HostDependencyReport,
    runtimeProfile: RuntimeProfileId
  ) {
    retryStory(story, blockerRetryDelay)
    setHostDependenciesDialog({
      checking: false,
      report,
      runtimeProfile,
      workspaceMode: storyRunMode(story) === "direct"
        ? "direct"
        : runtimeProfile === "local-container" ? "local-container" : "cloud-mirror",
      storyId: story.id,
      storyTitle: story.title,
    })
  }

  async function recheckHostDependencies() {
    const current = hostDependenciesDialog
    if (!current || !platform.workspace?.checkHostDependencies) return
    setHostDependenciesDialog({ ...current, checking: true })
    try {
      const report = await platform.workspace.checkHostDependencies({
        includeRuntime: current.workspaceMode === "direct"
          ? false
          : runtimeGate.hostCheckIncludesRuntime,
        runtimeProfile: current.runtimeProfile,
        workspaceMode: current.workspaceMode,
      })
      if (report.ok) {
        blockedStories.current.delete(current.storyId)
        setHostDependenciesDialog(undefined)
        refreshStartingStories((value) => value + 1)
        return
      }
      setHostDependenciesDialog({ ...current, checking: false, report })
    } catch (error) {
      setHostDependenciesDialog({ ...current, checking: false })
      toast.error("Unable to recheck development requirements", {
        description: errorMessage(error),
        position: "bottom-right",
      })
    }
  }

  function retryStory(story: UserStory, delay = initializationRetryDelay) {
    blockedStories.current.set(story.id, Date.now() + delay)
    window.setTimeout(() => {
      blockedStories.current.delete(story.id)
      refreshStartingStories((value) => value + 1)
    }, delay)
  }

  const persistRecoveredPreviewUrl = React.useCallback(
    async (story: UserStory, previewUrl: string | null) => {
      if (!previewUrl || previewUrl === story.previewUrl) return
      await backlog.update(story, { previewUrl })
    },
    [backlog]
  )

  const recoverActivePreviews = React.useCallback(
    (stories: UserStory[]) => {
      if (!ensureProjectPreviewUrl) return
      const hidden = document.visibilityState === "hidden"
      previewRecoveryStories(stories, hidden).forEach((story) => {
        if (!story.worktree || previewRecoveryStoryIds.current.has(story.id))
          return
        previewRecoveryStoryIds.current.add(story.id)
        void ensureProjectPreviewUrl({
          workspaceMode:
            story.workspaceMode ??
            (storyRunMode(story) === "vercel-compose"
              ? "cloud-mirror"
              : "local-container"),
          worktree: story.worktree,
        })
          .then((previewUrl) => persistRecoveredPreviewUrl(story, previewUrl))
          .catch(() => undefined)
          .finally(() => previewRecoveryStoryIds.current.delete(story.id))
      })
    },
    [
      ensureProjectPreviewUrl,
      persistRecoveredPreviewUrl,
      storyRunMode,
    ]
  )

  React.useEffect(() => {
    if (!ensureProjectPreviewUrl || backlog.loading) return
    recoverActivePreviews(storiesRef.current)
    const recover = () => recoverActivePreviews(storiesRef.current)
    const timer = window.setInterval(recover, previewRecoveryIntervalMs)
    const recoverWhenShown = () => {
      if (document.visibilityState === "visible") recover()
    }
    document.addEventListener("visibilitychange", recoverWhenShown)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", recoverWhenShown)
    }
  }, [
    backlog.loading,
    ensureProjectPreviewUrl,
    previewRecoveryState,
    recoverActivePreviews,
  ])

  const storiesToStartRef = React.useRef(storiesToStartNow)
  React.useEffect(() => {
    startStoryRef.current = startStory
    reportBlockerRef.current = reportBlocker
    storiesToStartRef.current = storiesToStartNow
  })

  React.useEffect(() => {
    if (!projects.activeProject || auth.status !== "authenticated") return
    if (backlog.loading || !backlog.projectId) return
    if (agentAuthenticationBlockedUntil.current > Date.now()) return

    const readyStories = queuedStories(
      backlog.stories,
      startingStoryIds.current,
      blockedStories.current
    )
    if (readyStories.length === 0) return

    const storiesToStart = storiesToStartRef.current(readyStories)
    if (!storiesToStart.length) return
    storiesToStart.forEach((story) => {
      startingStoryIds.current.add(story.id)
      void startStoryRef
        .current(story)
        .catch((error) => reportBlockerRef.current(story, errorMessage(error)))
        .finally(() => {
          startingStoryIds.current.delete(story.id)
          refreshStartingStories((value) => value + 1)
        })
    })
    refreshStartingStories((value) => value + 1)
  }, [
    auth.status,
    backlog.loading,
    backlog.projectId,
    backlog.stories,
    projects.activeProject,
    queueTick,
    storyRunMode,
  ])

  return {
    runtimeWaitingLabel: runtimeGate.waitingLabel,
    hostDependenciesDialog: {
      checking: Boolean(hostDependenciesDialog?.checking),
      onOpenChange(open: boolean) {
        if (!open) setHostDependenciesDialog(undefined)
      },
      onRecheck: recheckHostDependencies,
      open: Boolean(hostDependenciesDialog),
      report: hostDependenciesDialog?.report,
      storyTitle: hostDependenciesDialog?.storyTitle,
    },
  }
}
