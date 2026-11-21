import * as React from "react"
import { toast } from "sonner"
import type {
  StoryQueueState,
  StoryWaiting,
} from "@blame/agent-runtime/engine-protocol"

import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { navigate } from "@/components/navigation/navigation"
import { useBlameRuntime } from "@/context/blame-runtime"
import { useCloudAuth } from "@/context/cloud-auth"
import { useGitIdentity } from "@/context/git-identity"
import type { HostDependencyReport } from "@/context/platform"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { hostedServiceRequirement } from "@/lib/hosted-service-access"
import type { StoryRunMode } from "@/lib/runtime-preference"
import { refreshStoryService } from "@/lib/story-service"
import { prepareStartingStoryPreview } from "./story-preview-preparation"

type HostDependenciesWait = StoryWaiting & {
  reason: Extract<StoryWaiting["reason"], { kind: "host-dependencies" }>
}

const emptyQueue: StoryQueueState = {
  waiting: [],
  starting: [],
  localRunning: 0,
}

/**
 * The Agent Queue as the story service in the engine host runs it: why its
 * stories wait, said in this window for the project it shows (a dialog, a
 * toast, the column's notice), and what the window does for them (start the
 * Blame Runtime, ask for Git's name, get a preview ready).
 */
export function useStoryQueue(backlog: ReturnType<typeof useBacklogStore>) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const engine = platform.engine
  const projects = useProjects()
  const gitIdentity = useGitIdentity()
  const runtime = useBlameRuntime()
  const { promptInstall, setLocalRunsActive, start: startRuntime } = runtime
  const [queue, setQueue] = React.useState(emptyQueue)
  // The host-dependencies dialogs the person closed, and the last recheck.
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [recheck, setRecheck] = React.useState<{
    key: string
    checking: boolean
    report?: HostDependencyReport
  }>()
  const told = React.useRef(new Set<string>())
  const projectId = projects.activeProject?.id
  const projectPath = projects.activeProject?.path

  React.useEffect(() => {
    if (!engine) return
    let live = true
    void engine.call("storyQueueState", undefined).then(
      (state) => {
        if (live) setQueue(state)
      },
      () => undefined
    )
    const unsubscribe = engine.onStory((event) => {
      if (event.type === "story-queue") return setQueue(event.queue)
      if (event.type !== "story") return
      // Its preview gets ready in the window that shows its project.
      if (event.started)
        prepareStartingStoryPreview(event.storyId, {
          environment: event.started.environment as never,
        })
      if (event.directFallback && event.projectId === projectId)
        notifyDirectFallback(event.projectId, storyTitle(event.story))
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [engine, projectId])

  // The runtime waits to update while local stories work, whatever the project.
  React.useEffect(() => {
    setLocalRunsActive(queue.localRunning)
  }, [queue.localRunning, setLocalRunsActive])

  const retry = React.useCallback(
    (storyId?: string) =>
      void engine?.call("storyRetry", { storyId }).catch(() => undefined),
    [engine]
  )

  const shown = React.useMemo(
    () => queue.waiting.filter((wait) => wait.projectId === projectId),
    [projectId, queue.waiting]
  )

  React.useEffect(() => {
    // A stopped runtime starts for the stories that wait for it.
    if (
      queue.waiting.some(
        ({ reason }) => reason.kind === "runtime" && reason.phase === "stopped"
      )
    )
      void startRuntime()
    for (const wait of shown) {
      const key = waitKey(wait)
      if (told.current.has(key)) continue
      told.current.add(key)
      const { reason } = wait
      if (reason.kind === "needs-runtime")
        promptInstall({ storyTitle: wait.title })
      else if (reason.kind === "git-identity")
        void gitIdentity?.ensure({
          root: projectPath,
          storyTitle: wait.title,
          onSaved: () => retry(wait.storyId),
        })
      else if (reason.kind === "cloud-without-premium")
        askWhereToRun(
          wait,
          (mode) => {
            told.current.delete(key)
            void backlog
              .update(storyById(backlog, wait.storyId), { runMode: mode })
              .then(() => refreshStoryService(engine, wait.projectId))
              .catch(() => undefined)
          },
          hostedServiceRequirement(auth, "cloud-preview")
        )
      else if (reason.kind === "error")
        // Git asking who you are gets its dialog, not a raw error.
        if (
          !gitIdentity?.handleError(reason.message, () => retry(wait.storyId))
        )
          toast.error("User story stayed in Agent Queue", {
            description: reason.message,
            id: `story-queue-${wait.storyId}`,
            position: "bottom-right",
          })
    }
  }, [
    auth,
    backlog,
    engine,
    gitIdentity,
    projectPath,
    promptInstall,
    queue.waiting,
    retry,
    shown,
    startRuntime,
  ])

  // The first story of the board stopped by a missing tool says what to install.
  const hostWait = shown.find(
    (wait): wait is HostDependenciesWait =>
      wait.reason.kind === "host-dependencies" && !dismissed.has(waitKey(wait))
  )
  const hostKey = hostWait && waitKey(hostWait)
  const hostRecheck = recheck?.key === hostKey ? recheck : undefined
  const dismiss = (key: string) =>
    setDismissed((current) => new Set([...current, key]))

  async function recheckHostDependencies() {
    const check = platform.workspace?.checkHostDependencies
    if (!hostWait || !hostKey || !check) return
    setRecheck({ key: hostKey, checking: true })
    const { reason } = hostWait
    try {
      const report = await check({
        // A runtime the window cannot report on is checked here instead.
        includeRuntime:
          reason.workspaceMode === "direct" || runtime.phase !== "unavailable"
            ? false
            : undefined,
        runtimeProfile: reason.runtimeProfile,
        workspaceMode: reason.workspaceMode,
      })
      if (report.ok) {
        dismiss(hostKey)
        retry(hostWait.storyId)
        return
      }
      setRecheck({ key: hostKey, checking: false, report })
    } catch (error) {
      setRecheck({ key: hostKey, checking: false })
      toast.error("Unable to recheck development requirements", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
    }
  }

  const runtimeWait = shown.find(({ reason }) => reason.kind === "runtime")
  return {
    queueNotice:
      runtimeWait?.reason.kind === "runtime"
        ? runtimeWaitingLabel(runtimeWait.reason.phase)
        : undefined,
    hostDependenciesDialog: {
      checking: Boolean(hostRecheck?.checking),
      onOpenChange(open: boolean) {
        if (!open && hostKey) dismiss(hostKey)
      },
      onRecheck: recheckHostDependencies,
      open: Boolean(hostWait),
      report:
        hostRecheck?.report ??
        (hostWait?.reason.report as HostDependencyReport | undefined),
      storyTitle: hostWait?.title,
    },
  }
}

// A Cloud Preview story whose owner no longer has Premium: ask where to
// run it instead of switching silently.
function askWhereToRun(
  wait: StoryWaiting,
  switchTo: (mode: StoryRunMode) => void,
  requirement: string
) {
  toast.error(requirement, {
    action: { label: "Run Direct", onClick: () => switchTo("direct") },
    cancel: {
      label: "Local Container",
      onClick: () => switchTo("local-container"),
    },
    description: `${wait.title} is waiting. Run it on this computer instead?`,
    duration: Infinity,
    id: `story-queue-${wait.storyId}-cloud`,
    position: "bottom-right",
  })
}

const notifiedProjects = new Set<string>()

/** Tells once per project why its stories now run Direct. */
function notifyDirectFallback(projectId: string, title: string) {
  if (notifiedProjects.has(projectId)) return
  notifiedProjects.add(projectId)
  toast.warning("Running in Direct mode", {
    description: `This project has no working preview environment, so “${title}” runs in your project folder with your own setup. Previews come back once the environment works.`,
    action: {
      label: "Open environment",
      onClick: () => navigate("/initialization"),
    },
    duration: 15_000,
    id: `project-initialization-direct-${projectId}`,
    position: "bottom-right",
  })
}

function runtimeWaitingLabel(phase: string) {
  if (phase === "stopped" || phase === "starting")
    return "Waiting for Blame Runtime to start"
  if (phase === "checking") return "Checking Blame Runtime"
  if (phase === "installing") return "Waiting for Blame Runtime to install"
  if (phase === "repairing") return "Waiting for Blame Runtime repair"
  return "Waiting for Blame Runtime update"
}

function waitKey(wait: StoryWaiting) {
  return `${wait.storyId}:${JSON.stringify(wait.reason)}`
}

function storyTitle(story: unknown) {
  const title = (story as { title?: unknown } | undefined)?.title
  return typeof title === "string" ? title : "This story"
}

function storyById(backlog: ReturnType<typeof useBacklogStore>, id: string) {
  const story = backlog.stories.find((item) => item.id === id)
  if (!story) throw new Error("The story is not on this board.")
  return story
}
