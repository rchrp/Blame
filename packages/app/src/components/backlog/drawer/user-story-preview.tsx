import { isHostWindowConfiguration } from "./surfaces/host-window-kind"
import { useProjectServices } from "./preview-service-logs"
import { ProjectRunLogPanel, ServiceLogPanel } from "./preview-run-logs"
import { previewAmbilightShadow } from "./preview-ambilight"
import {
  PreviewSurface,
  previewSurfaceType,
  usePreviewSurfaceManifest,
} from "./preview-surface"
import type { PreviewLifecycleState } from "@blame/agent-runtime"
import {
  CopyIcon,
  ExternalLinkIcon,
  FocusIcon,
  LoaderCircleIcon,
  LockIcon,
  MonitorIcon,
  NetworkIcon,
  RefreshCwIcon,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import {
  RunnerViewGroup,
  type RunnerView,
} from "@/components/backlog/board/project-runner-controls"
import {
  previewServiceStatuses,
  sortRunLogItems,
  type RunLogItem,
} from "@/components/backlog/board/run-log-items"
import {
  PreviewActionsSpace,
  type RunLogEmpty,
} from "@/components/backlog/board/run-log-panel"
import type { UserStory } from "@/components/backlog/data/backlog-data"
import { managedPresentedPreviewUrl } from "@/components/backlog/drawer/managed-preview-url"
import { ManagedRuntimeSummary } from "@/components/backlog/drawer/managed-runtime-summary"
import { PreviewInitializationState } from "@/components/backlog/drawer/preview-initialization-state"
import {
  activePreviewProxy,
  type PreviewProxyInfo,
} from "@/components/backlog/drawer/preview-proxy"
import type { LiveSyncStatus } from "@blame/preview-runtime"
import {
  CloudSyncBadge,
  PreviewUpdateChip,
  useLiveSyncStatus,
} from "@/components/backlog/drawer/cloud-sync-status"
import { usePreviewUpdateNotice } from "@/components/backlog/drawer/preview-update-notice"
import {
  usePreviewHotReloads,
  useReloadAfterChanges,
} from "@/components/backlog/drawer/preview-auto-reload"
import { PreviewFailurePanel } from "@/components/backlog/drawer/preview-failure-panel"
import { LocalPreviewAutoStart } from "@/components/backlog/drawer/local-preview-auto-start"
import { localPreviewAutoStartStories } from "@/components/backlog/drawer/local-preview-auto-start-stories"
import { usePreviewSetupRepair } from "@/components/backlog/drawer/preview-setup-repair"
import {
  usePreviewWarmupReady,
  useSetupPreviewReady,
  useStartedAppAnswered,
} from "@/components/backlog/drawer/preview-readiness"
import {
  blameCloudPreviewOrigin,
  normalizePreviewPath,
  previewAddressOrigin,
  previewAddressPath,
  previewPathUrl,
} from "@/components/backlog/drawer/preview-url"
import {
  clearCloudPreviewAutoStartDisabled,
  useUserStoryPreviewRunner,
  type UserStoryPreviewRunner,
} from "@/components/backlog/drawer/use-user-story-preview-runner"
import { UserStoryPreviewRunnerControls } from "@/components/backlog/drawer/user-story-preview-runner"
import { PreviewVariablesPanel } from "@/components/backlog/drawer/preview-variables-panel"
import { storyPreviewDevtoolsScope } from "@/components/backlog/shared/preview-devtools-scope"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { usePlatform } from "@/context/platform"
import { pruneRuntimeSessionStates } from "@/lib/runtime-preference"
import { useLatestCallback } from "@/lib/use-latest-callback"
import { cn } from "@/lib/utils"
import {
  destroyReleasedNativePreviewSessions,
  nativePreviewRetainedSessionLimit,
  nativePreviewStatus,
  NativePreviewWarmup,
  PreviewErrorState,
  PreviewLoadingState,
  type NativePreviewState,
  type NativePreviewStateInput,
  type PreviewCaptureHandler,
  type PreviewState,
} from "./native-preview"

const noServices: string[] = []

type PreviewLoad = {
  key: string
  location?: string
  locationBlocked?: boolean
  state: PreviewState
}
type PreviewPanelProps = {
  frameRef: React.RefObject<HTMLIFrameElement | null>
  onError: () => void
  onLoad: () => void
  onReload: () => void
  previewKey: string
  previewState: PreviewState
  source: string
  title: string
}
type PreviewUrlWarmupProps = {
  devtoolsScope?: string
  enabled?: boolean
  previewKey: string
  previewUrl?: string
  trigger?: number | string
}
// A preview whose app runs from the project's own runner (a story working
// directly in the project folder): its controls and logs come from there.
export type ProjectRunPreview = {
  surface?: {
    configuration: import("@blame/agent-runtime").ProjectRunConfiguration
    manifest?: import("@blame/agent-runtime").PreviewManifest
  }
  // Hides the native preview while a menu of the controls is open; the
  // views switch between the preview and its logs. Left out where the
  // controls show elsewhere (the header, over its drawer).
  controls?: (props: {
    onMenuOpenChange: (open: boolean) => void
    views: RunnerView[]
  }) => React.ReactNode
  logs: {
    content: string
    // What the selected tab shows while it has no output.
    empty: RunLogEmpty
    items: RunLogItem[]
    selected?: string
    onSelect: (id: string) => void
  }
  // Shown with the logs: the app's port held by another app, or one to
  // confirm.
  notice?: React.ReactNode
  // Changes with each run of the app, which then waits to answer again.
  runKey?: string
  // Grows each time the app is started from this preview: its logs show.
  startRequest?: number
}

// What the preview tab shows: the app, its run logs, or its variables.
export type PreviewView = "preview" | "setup-log" | "variables"

type PreviewIslandProps = {
  /** Terminal, screen and device previews have no address or page actions. */
  browserSurface: boolean
  captureDisabled?: boolean
  locationBlocked: boolean
  navigationDisabled?: boolean
  onCapture?: () => void
  onNavigatePath: (path: string) => void
  onOpen: () => void
  onReload: () => void
  previewLocation?: string
  previewProxy?: PreviewProxyInfo
  // The address and page actions show with the page only.
  showAddress: boolean
  source?: string
  syncStatus?: LiveSyncStatus
  updateNotice?: string
}
type PreviewRunnerActionsProps = {
  projectRun?: ProjectRunPreview
  onConfigurationChange?: (configurationId: string, previewUrl?: string) => void
  onMenuOpenChange: (open: boolean) => void
  runner?: UserStoryPreviewRunner
  views: RunnerView[]
}

export function PreviewUrlWarmup({
  devtoolsScope,
  enabled = true,
  previewKey,
  previewUrl,
  trigger,
}: PreviewUrlWarmupProps) {
  const platform = usePlatform()
  const previewBrowser = platform.previewBrowser
  const source = previewUrl ? previewSource(previewUrl) : undefined
  const sessionKey = nativePreviewKeyFor(previewKey, source)
  const storageKey = nativePreviewStorageKeyFor(previewKey, source)
  const ready = usePreviewWarmupReady(
    source,
    Boolean(enabled && previewBrowser),
    trigger
  )
  const completionKey = `${enabled}:${sessionKey}:${String(trigger)}`
  const [completion, setCompletion] = React.useState({
    completed: false,
    key: completionKey,
  })
  const completed = completion.key === completionKey && completion.completed
  const handleState = React.useCallback(
    (state: NativePreviewStateInput) => {
      if (!devtoolsScope && (state.error || (!state.loading && state.url)))
        setCompletion({ completed: true, key: completionKey })
    },
    [completionKey, devtoolsScope]
  )

  if (!previewBrowser || !source || !ready || completed) return null
  return (
    <NativePreviewWarmup
      client={previewBrowser}
      devtoolsScope={devtoolsScope}
      onState={handleState}
      sessionKey={sessionKey}
      source={source}
      storageKey={storageKey}
    />
  )
}

export const UserStoryPreviewWarmup = React.memo(
  function UserStoryPreviewWarmup({
    userStories,
  }: {
    userStories: UserStory[]
  }) {
    const platform = usePlatform()
    const previewBrowser = platform.previewBrowser
    const stories = React.useMemo(
      () => nativePreviewWarmupStories(userStories),
      [userStories]
    )
    const cloudStories = React.useMemo(
      () => cloudPreviewWarmupStories(userStories),
      [userStories]
    )
    const localStories = React.useMemo(
      () => localPreviewAutoStartStories(userStories),
      [userStories]
    )
    const previousStatusesRef = React.useRef(
      new Map<string, UserStory["status"]>()
    )

    React.useEffect(() => {
      const previous = previousStatusesRef.current
      const next = new Map(userStories.map((story) => [story.id, story.status]))
      pruneRuntimeSessionStates(
        new Set(
          userStories
            .filter((story) => isActivePreviewStatus(story.status))
            .map((story) => story.id)
        )
      )
      userStories.forEach((story) => {
        if (
          isActivePreviewStatus(story.status) &&
          previous.has(story.id) &&
          !isActivePreviewStatus(previous.get(story.id))
        ) {
          clearCloudPreviewAutoStartDisabled(story.id)
        }
      })
      previousStatusesRef.current = next
    }, [userStories])

    React.useEffect(() => {
      if (stories.length) return
      const timeout = window.setTimeout(destroyReleasedNativePreviewSessions)
      return () => window.clearTimeout(timeout)
    }, [stories.length])

    return [
      ...cloudStories.map((story) => (
        <CloudPreviewAutoStart key={`cloud:${story.id}`} story={story} />
      )),
      ...localStories.map((story) => (
        <LocalPreviewAutoStart key={`local:${story.id}`} story={story} />
      )),
      ...(previewBrowser
        ? stories.map((story) => {
            const source = previewSource(story.previewUrl ?? "")
            const previewScope = storyPreviewDevtoolsScope(story.id)
            const sessionSource = `${source}:local:${story.worktree}`
            return (
              <NativePreviewWarmup
                key={nativePreviewKeyFor(previewScope, sessionSource)}
                client={previewBrowser}
                devtoolsScope={previewScope}
                previewWorktree={story.worktree ?? undefined}
                sessionKey={nativePreviewKeyFor(previewScope, sessionSource)}
                source={source}
                storageKey={nativePreviewStorageKeyFor(previewScope, source)}
              />
            )
          })
        : []),
    ]
  },
  equalUserStoryPreviewWarmupProps
)

function CloudPreviewAutoStart({ story }: { story: UserStory }) {
  useUserStoryPreviewRunner(story.worktree, true, story.id, {
    autoStart: true,
    autoStartConfigurationId: story.runConfigurationId,
    workspaceMode: story.workspaceMode,
  })
  return null
}

export const UserStoryPreview = React.memo(function UserStoryPreview({
  covered = false,
  onCapture,
  onRunConfigurationChange,
  previewSessionKey,
  previewTitle,
  previewUrl: previewUrlInput,
  projectRun,
  setupInitializing,
  userStory,
  view,
  visible = true,
  worktree,
  onViewChange,
}: {
  // Something drawn over the preview from outside, such as a menu of the
  // header's controls: the native page, drawn above the app, steps aside.
  covered?: boolean
  onCapture?: (file: File) => void
  onRunConfigurationChange?: (
    configurationId: string,
    previewUrl?: string
  ) => void
  previewSessionKey?: string
  previewTitle?: string
  previewUrl?: string
  projectRun?: ProjectRunPreview
  setupInitializing?: boolean
  userStory?: UserStory
  // Set by a parent that shows the view elsewhere too (the header).
  view?: PreviewView
  visible?: boolean
  worktree?: string
  onViewChange?: (view: PreviewView) => void
}) {
  const platform = usePlatform()
  const previewBrowser = platform.previewBrowser
  const [recoveredPreviewUrl, setRecoveredPreviewUrl] = React.useState<
    string | undefined
  >()
  const [previewLoad, setPreviewLoad] = React.useState<PreviewLoad>({
    key: "",
    state: "loading",
  })
  const [reloadKey, setReloadKey] = React.useState(0)
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const locationIntervalRef = React.useRef<number | undefined>(undefined)
  const requestRef = React.useRef<AbortController | undefined>(undefined)
  const timeoutRef = React.useRef<number | undefined>(undefined)
  const previewLabel = userStory?.id ?? previewTitle ?? "preview"
  const previewScope = userStory
    ? storyPreviewDevtoolsScope(userStory.id)
    : previewSessionKey
  const previewIdentity = previewScope ?? previewLabel
  const projectRunMode = Boolean(projectRun)
  const setupLogWorktree = projectRunMode
    ? undefined
    : (userStory?.worktree ?? worktree)
  const configuredPreviewUrl = projectRunMode
    ? previewUrlInput
    : (userStory?.previewUrl ?? previewUrlInput)
  const previewRunner = useUserStoryPreviewRunner(
    setupLogWorktree,
    visible && !projectRunMode,
    projectRunMode ? undefined : userStory?.id,
    { workspaceMode: userStory?.workspaceMode }
  )
  const previewWorktree =
    previewRunner.profile === "local-container" ? setupLogWorktree : undefined
  const runtimeLifecycle = previewRunner.lifecycle
  const syncStatus = useLiveSyncStatus(
    previewRunner.profile === "local-container"
      ? undefined
      : previewRunner.previewSessionId
  )
  const updateNotice = usePreviewUpdateNotice({
    syncSequence: syncStatus?.sequence,
    changedFiles: syncStatus?.changedFiles,
    agentRunning: userStory?.agentStatus === "Running",
  })
  useReloadAfterChanges({
    enabled: usePreviewHotReloads(setupLogWorktree) === false,
    syncSequence: syncStatus?.sequence,
    agentRunning: userStory?.agentStatus === "Running",
    setReloadKey,
  })
  useReloadAfterRecovery(runtimeLifecycle?.status, setReloadKey)
  const runtimeStarting = Boolean(
    !projectRunMode &&
    runtimeLifecycle?.status === "pending" &&
    !["stopping", "suspending", "destroying"].includes(runtimeLifecycle.phase)
  )
  const managedPreview =
    !projectRunMode && previewRunner.profile !== "local-container"
  const previewUrl = previewRunner.runtime
    ? previewRunner.runtime.previewUrl
    : managedPreview
      ? undefined
      : (recoveredPreviewUrl ?? configuredPreviewUrl)
  const baseSource = previewUrl ? previewSource(previewUrl) : undefined
  const nativePreviewSessionKey = nativePreviewKeyFor(
    previewIdentity,
    previewRunner.previewSessionId
      ? `${baseSource}:${previewRunner.previewSessionId}`
      : previewWorktree
        ? `${baseSource}:local:${previewWorktree}`
        : baseSource
  )
  const nativePreviewStorageKey = nativePreviewStorageKeyFor(
    previewIdentity,
    baseSource
  )
  const [editedPreview, setEditedPreview] = React.useState<{
    baseSource?: string
    url: string
  }>()
  const source =
    editedPreview && editedPreview.baseSource === baseSource
      ? editedPreview.url
      : baseSource
  const previewKey = source ? `${source}-${reloadKey}` : ""
  const nativePreviewKey = source ?? ""
  const setupPreviewReady = useSetupPreviewReady(
    source,
    reloadKey,
    Boolean(setupInitializing && source)
  )
  const setupPreviewWaiting = Boolean(
    setupInitializing && source && !setupPreviewReady
  )
  const startedAppAnswered = useStartedAppAnswered(
    source,
    projectRun?.runKey,
    projectRunMode
  )
  const projectRunWaiting = Boolean(
    projectRunMode && source && !startedAppAnswered
  )
  const previewWaiting = setupPreviewWaiting || projectRunWaiting
  const previewState =
    previewLoad.key === previewKey ? previewLoad.state : "loading"
  const previewLocation =
    previewLoad.key === previewKey ? previewLoad.location : undefined
  const locationBlocked =
    previewLoad.key === previewKey && previewLoad.locationBlocked
  const hasSetupLog =
    projectRunMode || Boolean(setupLogWorktree && !setupInitializing)
  const [selectedLogServiceChoice, setSelectedLogService] = React.useState("")
  const [runnerMenuOpen, setRunnerMenuOpen] = React.useState(false)
  const [tabChoice, setTabChoice] = React.useState<PreviewView>(
    source ? "preview" : "setup-log"
  )
  const tab = view ?? tabChoice
  const setTab = useLatestCallback((next: PreviewView) => {
    setTabChoice(next)
    onViewChange?.(next)
  })
  const runtimeStartingRef = React.useRef(false)
  // Opened on its logs, the page does not take over until it reloads.
  const autoSelectedPreviewSourceRef = React.useRef<string | undefined>(
    view === "setup-log" ? source : undefined
  )
  const previewFailure =
    !projectRunMode && !runtimeStarting && runtimeLifecycle?.status === "error"
      ? (runtimeLifecycle.failure?.message ??
        "The preview stopped unexpectedly.")
      : undefined
  const repairPreviewSetup = usePreviewSetupRepair(
    setupLogWorktree,
    userStory?.id
  )
  const surfaceConfiguration =
    projectRun?.surface?.configuration ??
    previewRunner.runtime?.configurations.find(
      ({ id }) => id === previewRunner.selectedId
    )
  const surfaceManifest = usePreviewSurfaceManifest(
    projectRun?.surface?.manifest,
    setupLogWorktree ?? undefined,
    runtimeLifecycle?.phase
  )
  const browserSurface =
    previewSurfaceType(surfaceConfiguration, surfaceManifest) === "web"
  const hasPreviewSurface =
    Boolean(
      source ||
      surfaceConfiguration?.previewService ||
      surfaceConfiguration?.previewTarget ||
      isHostWindowConfiguration(surfaceConfiguration)
    ) ||
    runtimeStarting ||
    Boolean(previewFailure)
  const hasVariables = Boolean(setupLogWorktree)
  const activeTab = activePreviewTab(
    tab,
    hasPreviewSurface,
    hasSetupLog,
    hasVariables
  )
  const localServices = useProjectServices(
    visible && activeTab === "setup-log" && !managedPreview
      ? setupLogWorktree
      : undefined
  )
  const managedServices = previewRunner.runtime?.configurations.find(
    ({ id }) => id === previewRunner.selectedId
  )?.services
  const services = managedPreview
    ? (managedServices ?? noServices)
    : localServices
  const [nativePreviewState, setNativePreviewState] =
    React.useState<NativePreviewState>()
  const [previewCapture, setPreviewCapture] =
    React.useState<PreviewCaptureHandler>()
  const activeNativePreviewState =
    nativePreviewState?.key === nativePreviewKey
      ? nativePreviewState
      : undefined

  const serviceItems = React.useMemo(() => {
    const statuses = previewServiceStatuses(
      previewRunner.runtime,
      services,
      surfaceManifest
    )
    return sortRunLogItems(
      services.map((id) => ({ id, label: id, status: statuses?.[id] }))
    )
  }, [previewRunner.runtime, services, surfaceManifest])
  const selectedLogService = services.includes(selectedLogServiceChoice)
    ? selectedLogServiceChoice
    : defaultLogService(serviceItems, surfaceConfiguration?.previewService)
  const hasNativePreview = Boolean(previewBrowser && source && !previewWaiting)
  const displayedPreviewState = hasNativePreview
    ? nativePreviewStatus(activeNativePreviewState)
    : previewWaiting
      ? "loading"
      : previewState
  const displayedPreviewLocation = hasNativePreview
    ? activeNativePreviewState?.url
    : previewLocation
  const logicalPreviewLocation = displayedPreviewLocation ?? source
  const presentedSource = managedPreview
    ? managedPresentedPreviewUrl(previewRunner.publicPreviewUrl, source)
    : source
  const presentedPreviewLocation = managedPreview
    ? managedPresentedPreviewUrl(
        previewRunner.publicPreviewUrl,
        logicalPreviewLocation
      )
    : displayedPreviewLocation
  const previewProxy = activePreviewProxy({
    cloudBridgeRequired: Boolean(
      previewRunner.integratedPreviewRequired && source
    ),
    localBridgeActive: Boolean(hasNativePreview && previewWorktree),
    logicalUrl: logicalPreviewLocation,
    presentedUrl: presentedPreviewLocation,
    publicUrl: previewRunner.publicPreviewUrl,
    reasons: previewRunner.previewProxyReasons,
  })
  const displayedLocationBlocked = hasNativePreview
    ? false
    : Boolean(locationBlocked)
  const clearPreviewRequest = React.useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = undefined
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = undefined
  }, [])

  const clearLocationInterval = React.useCallback(() => {
    if (!locationIntervalRef.current) return
    window.clearInterval(locationIntervalRef.current)
    locationIntervalRef.current = undefined
  }, [])

  const syncFrameLocation = React.useCallback(() => {
    const location = frameRef.current
      ? previewFrameLocation(frameRef.current, source)
      : undefined
    if (!location) {
      setPreviewLoad((current) =>
        current.key === previewKey && current.locationBlocked
          ? current
          : {
              key: previewKey,
              location:
                current.key === previewKey ? current.location : undefined,
              locationBlocked: true,
              state: "loaded",
            }
      )
      return
    }
    setPreviewLoad((current) =>
      current.key === previewKey &&
      current.location === location &&
      !current.locationBlocked
        ? current
        : { key: previewKey, location, state: "loaded" }
    )
  }, [previewKey, source])

  React.useEffect(() => {
    if (!source || previewBrowser) return
    clearPreviewRequest()
    clearLocationInterval()
    const controller = new AbortController()
    requestRef.current = controller
    timeoutRef.current = window.setTimeout(
      () =>
        setPreviewLoad({ key: previewKey, location: source, state: "error" }),
      12000
    )
    void fetch(source, { mode: "no-cors", signal: controller.signal }).catch(
      () => {
        if (requestRef.current !== controller || controller.signal.aborted)
          return
        setPreviewLoad({ key: previewKey, location: source, state: "error" })
      }
    )
    return () => {
      clearLocationInterval()
      clearPreviewRequest()
    }
  }, [
    clearLocationInterval,
    clearPreviewRequest,
    previewBrowser,
    previewKey,
    source,
  ])

  const reloadPreview = () => {
    setReloadKey((current) => current + 1)
    if (!managedPreview) recoverPreview()
  }

  const recoverPreview = () => {
    if (
      managedPreview ||
      !setupLogWorktree ||
      !platform.workspace?.ensureProjectPreviewUrl
    )
      return
    void platform.workspace
      .ensureProjectPreviewUrl({
        executionId: crypto.randomUUID(),
        storyId: userStory?.id,
        workspaceMode: userStory?.workspaceMode ?? "local-container",
        worktree: setupLogWorktree,
      })
      .then((previewUrl) => {
        if (previewUrl) setRecoveredPreviewUrl(previewUrl)
      })
      .catch(() => undefined)
  }

  const showPreview = () => {
    clearPreviewRequest()
    clearLocationInterval()
    setPreviewLoad({
      key: previewKey,
      location: source,
      state: "loaded",
    })
    syncFrameLocation()
    locationIntervalRef.current = window.setInterval(syncFrameLocation, 250)
  }

  const showPreviewError = () => {
    clearPreviewRequest()
    clearLocationInterval()
    setPreviewLoad({ key: previewKey, location: source, state: "error" })
  }

  const openPreview = () => {
    if (previewRunner.previewSessionId && platform.previewRuntime) {
      void platform.previewRuntime.openExternal({
        sessionId: previewRunner.previewSessionId,
      })
      return
    }
    const target = displayedPreviewLocation ?? source
    if (!target) return
    if (platform.openExternalLink) return platform.openExternalLink(target)
    window.open(target, "_blank", "noopener,noreferrer")
  }
  const navigatePreviewPath = React.useCallback(
    (path: string) => {
      if (!source) return
      setEditedPreview({
        baseSource,
        url: previewPathUrl(source, path),
      })
    },
    [baseSource, source]
  )
  const handleNativePreviewState = React.useCallback(
    (state: { error?: string; loading: boolean; url?: string }) =>
      setNativePreviewState({ ...state, key: nativePreviewKey }),
    [nativePreviewKey]
  )
  const capturePreview = React.useCallback(() => {
    if (!previewCapture) return
    void previewCapture().then((file) => {
      if (file) onCapture?.(file)
    })
  }, [onCapture, previewCapture])
  const setPreviewCaptureHandler = React.useCallback(
    (capture?: PreviewCaptureHandler) => setPreviewCapture(() => capture),
    []
  )

  React.useEffect(() => {
    if (!source || previewWaiting) return
    if (autoSelectedPreviewSourceRef.current === source) return
    autoSelectedPreviewSourceRef.current = source
    setTab("preview")
  }, [previewWaiting, setTab, source])

  // Started from this preview: its logs show while the app starts, then
  // the preview once the app answers.
  const startRequest = projectRun?.startRequest ?? 0
  const startRequestRef = React.useRef(startRequest)
  React.useEffect(() => {
    if (startRequestRef.current === startRequest) return
    startRequestRef.current = startRequest
    autoSelectedPreviewSourceRef.current = undefined
    setTab("setup-log")
  }, [setTab, startRequest])

  React.useEffect(() => {
    const justStarted = runtimeStarting && !runtimeStartingRef.current
    runtimeStartingRef.current = runtimeStarting
    if (justStarted) setTab("preview")
  }, [runtimeStarting, setTab])

  const views: RunnerView[] = [
    {
      id: "preview",
      active: activeTab === "preview",
      // The page is there to see: its app answers.
      ready: Boolean(
        source && !previewWaiting && !runtimeStarting && !previewFailure
      ),
      unavailable: hasPreviewSurface
        ? undefined
        : "Start the app to see its preview",
      onSelect: () => setTab("preview"),
    },
    {
      id: "logs",
      active: activeTab === "setup-log",
      unavailable: hasSetupLog ? undefined : "No run logs yet",
      onSelect: () => setTab("setup-log"),
    },
    ...(hasVariables
      ? [
          {
            id: "variables" as const,
            active: activeTab === "variables",
            onSelect: () => setTab("variables"),
          },
        ]
      : []),
  ]
  const actions =
    projectRun && !projectRun.controls ? null : (
      <PreviewRunnerActions
        projectRun={projectRun}
        runner={projectRunMode ? undefined : previewRunner}
        views={views}
        onConfigurationChange={onRunConfigurationChange}
        onMenuOpenChange={setRunnerMenuOpen}
      />
    )
  // A parent showing the view (the header) follows the one shown, which
  // differs when the one asked for is not there.
  const shownView = view ? activeTab : undefined
  React.useEffect(() => {
    if (shownView && shownView !== view) onViewChange?.(shownView)
  }, [onViewChange, shownView, view])
  const [actionsRef, actionsWidth] = useElementWidth<HTMLDivElement>()

  if (hasPreviewSurface || hasSetupLog) {
    return (
      // Not clipped: the page's glow reaches up under the drawer's header.
      <div className="h-full min-h-0">
        <Tabs
          value={activeTab}
          className="preview-toolbar-container relative h-full min-h-0 gap-0"
          style={
            {
              "--preview-actions-space": actions
                ? `${actionsWidth + 8}px`
                : "0px",
            } as React.CSSProperties
          }
        >
          {/* One element whatever the view, so its switch slides between
              them: the toolbar of each view leaves it room. */}
          {actions ? (
            <div
              ref={actionsRef}
              className="pointer-events-auto absolute top-4 right-4 z-30 flex h-10 items-center gap-1.5"
            >
              {actions}
            </div>
          ) : null}
          {activeTab !== "setup-log" && (
            <PreviewIsland
              browserSurface={browserSurface}
              captureDisabled={previewWaiting || !previewCapture}
              locationBlocked={displayedLocationBlocked}
              navigationDisabled={runtimeStarting || !source}
              onCapture={capturePreview}
              onNavigatePath={navigatePreviewPath}
              onOpen={openPreview}
              onReload={reloadPreview}
              previewLocation={presentedPreviewLocation}
              previewProxy={previewProxy}
              showAddress={activeTab === "preview"}
              source={presentedSource}
              syncStatus={syncStatus}
              updateNotice={updateNotice}
            />
          )}
          {hasPreviewSurface && (
            <TabsContent
              forceMount
              value="preview"
              className={cn(
                "relative h-full min-h-0",
                activeTab !== "preview" && "hidden"
              )}
            >
              {(source ||
                surfaceConfiguration?.previewService ||
                surfaceConfiguration?.previewTarget ||
                isHostWindowConfiguration(surfaceConfiguration)) &&
                (projectRunWaiting ? (
                  <StartedAppWaitingPanel source={source ?? ""} />
                ) : setupPreviewWaiting ? (
                  <PreviewWaitingPanel />
                ) : previewBrowser ? (
                  <PreviewSurface
                    configuration={surfaceConfiguration}
                    manifest={surfaceManifest}
                    onRestart={() =>
                      void previewRunner.control(
                        "restart",
                        previewRunner.selectedId
                      )
                    }
                    storyId={userStory?.id}
                    projectId={userStory?.projectId}
                    workspaceMode={userStory?.workspaceMode}
                    runRequested={
                      previewRunner.runtime?.desiredStatus === "running"
                    }
                    surfaceWorktree={setupLogWorktree ?? undefined}
                    client={previewBrowser}
                    devtoolsScope={previewScope}
                    onCaptureReady={setPreviewCaptureHandler}
                    onState={handleNativePreviewState}
                    previewKey={nativePreviewKey}
                    previewState={displayedPreviewState}
                    previewSessionId={previewRunner.previewSessionId}
                    previewWorktree={previewWorktree}
                    reloadKey={reloadKey}
                    sessionKey={nativePreviewSessionKey}
                    source={source ?? ""}
                    storageKey={nativePreviewStorageKey}
                    visible={
                      visible &&
                      activeTab === "preview" &&
                      !runnerMenuOpen &&
                      !covered &&
                      !runtimeStarting &&
                      !previewFailure
                    }
                  />
                ) : (
                  <PreviewPanel
                    frameRef={frameRef}
                    onError={showPreviewError}
                    onLoad={showPreview}
                    onReload={reloadPreview}
                    previewKey={previewKey}
                    previewState={previewState}
                    source={source ?? ""}
                    title={`${previewLabel} preview`}
                  />
                ))}
              {runtimeStarting && (
                <div className="absolute inset-0 z-10">
                  <PreviewWaitingPanel lifecycle={runtimeLifecycle} />
                </div>
              )}
              {previewFailure && (
                <div className="absolute inset-0 z-10">
                  <PreviewFailurePanel
                    message={previewFailure}
                    onOpenLogs={() => setTab("setup-log")}
                    onOpenVariables={
                      hasVariables ? () => setTab("variables") : undefined
                    }
                    onRestart={() =>
                      void previewRunner.control(
                        "restart",
                        previewRunner.selectedId
                      )
                    }
                    repair={
                      previewRunner.profile === "local-container"
                        ? repairPreviewSetup(previewFailure)
                        : undefined
                    }
                    restarting={Boolean(previewRunner.pendingOperation)}
                  />
                </div>
              )}
            </TabsContent>
          )}
          {hasSetupLog && (
            <TabsContent
              value="setup-log"
              className="h-full min-h-0 overflow-hidden"
            >
              {projectRun ? (
                <ProjectRunLogPanel
                  logs={projectRun.logs}
                  notice={projectRun.notice}
                />
              ) : (
                <ServiceLogPanel
                  items={serviceItems}
                  managed={managedPreview}
                  managedError={previewRunner.error}
                  previewSessionId={previewRunner.previewSessionId}
                  service={selectedLogService}
                  worktree={visible ? setupLogWorktree : undefined}
                  onServiceChange={setSelectedLogService}
                />
              )}
            </TabsContent>
          )}
          {hasVariables && (
            <TabsContent
              value="variables"
              className="h-full min-h-0 overflow-hidden"
            >
              <PreviewVariablesPanel
                worktree={setupLogWorktree}
                active={visible && activeTab === "variables"}
                onApply={
                  !managedPreview && previewRunner.selectedId
                    ? () =>
                        previewRunner.control("start", previewRunner.selectedId)
                    : undefined
                }
              />
            </TabsContent>
          )}
        </Tabs>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 p-6">
      <div className="flex h-full min-h-96 flex-col items-center justify-center gap-3 rounded-lg bg-muted/20 p-8 text-center">
        <MonitorIcon className="size-8 text-muted-foreground" />
        <div>
          <h3 className="font-heading text-lg font-semibold">Preview</h3>
          <p className="text-sm text-muted-foreground">
            Agent preview output will appear here.
          </p>
        </div>
      </div>
    </div>
  )
})

function PreviewPanel({
  frameRef,
  onError,
  onLoad,
  onReload,
  previewKey,
  previewState,
  source,
  title,
}: PreviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-4 pt-16 pb-4">
      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-background transition-shadow duration-700"
        style={{ boxShadow: previewAmbilightShadow() }}
      >
        <iframe
          ref={frameRef}
          key={previewKey}
          className="h-full w-full border-0 bg-background"
          src={source}
          title={title}
          onError={onError}
          onLoad={onLoad}
        />
        {previewState === "loading" && <PreviewLoadingState />}
        {previewState === "error" && <PreviewErrorState onReload={onReload} />}
      </div>
    </div>
  )
}

function StartedAppWaitingPanel({ source }: { source: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-4 pt-16 pb-4">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 rounded-lg border bg-background p-8 text-center">
        <LoaderCircleIcon className="size-8 animate-spin text-muted-foreground" />
        <div className="space-y-1">
          <h3 className="font-heading text-lg font-semibold">
            Starting the app
          </h3>
          <p className="text-sm text-muted-foreground">
            The preview opens as soon as {previewHost(source)} answers.
          </p>
        </div>
      </div>
    </div>
  )
}

function previewHost(source: string) {
  try {
    return new URL(source).host
  } catch {
    return source
  }
}

function PreviewWaitingPanel({
  lifecycle,
}: {
  lifecycle?: PreviewLifecycleState
} = {}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-4 pt-16 pb-4">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-background">
        <PreviewInitializationState lifecycle={lifecycle} />
      </div>
    </div>
  )
}

function PreviewIsland({
  browserSurface,
  captureDisabled,
  locationBlocked,
  navigationDisabled,
  onCapture,
  onNavigatePath,
  onOpen,
  onReload,
  previewLocation,
  previewProxy,
  showAddress,
  source,
  syncStatus,
  updateNotice,
}: PreviewIslandProps) {
  return (
    <div className="preview-toolbar pointer-events-none absolute inset-x-4 top-4 z-20 flex h-10 min-w-0 items-center gap-1.5">
      {showAddress && browserSurface ? (
        <>
          <PreviewAddress
            disabled={navigationDisabled}
            locationBlocked={locationBlocked}
            onNavigatePath={onNavigatePath}
            onOpen={onOpen}
            previewLocation={previewLocation}
            previewProxy={previewProxy}
            source={source}
            syncStatus={syncStatus}
            updateNotice={updateNotice}
          />
          <PreviewActions
            captureDisabled={navigationDisabled || captureDisabled}
            onCapture={onCapture}
            onReload={onReload}
            refreshDisabled={navigationDisabled}
          />
        </>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      <PreviewActionsSpace />
    </div>
  )
}

// The runner's controls with the preview's views, at the right end of the
// toolbar whatever the view: where the header keeps them too.
function PreviewRunnerActions({
  projectRun,
  onConfigurationChange,
  onMenuOpenChange,
  runner,
  views,
}: PreviewRunnerActionsProps) {
  return (
    <>
      {runner && <ManagedRuntimeSummary runner={runner} />}
      {projectRun ? (
        projectRun.controls?.({ onMenuOpenChange, views })
      ) : runner?.runtime ? (
        <UserStoryPreviewRunnerControls
          runner={runner}
          views={views}
          onConfigurationChange={onConfigurationChange}
          onMenuOpenChange={onMenuOpenChange}
        />
      ) : (
        <RunnerViewGroup views={views} />
      )}
    </>
  )
}

function PreviewActions({
  captureDisabled,
  onCapture,
  onReload,
  refreshDisabled,
}: {
  captureDisabled?: boolean
  onCapture?: () => void
  onReload: () => void
  refreshDisabled?: boolean
}) {
  return (
    <>
      <Button
        aria-label="Refresh preview"
        className="pointer-events-auto size-9 shrink-0 rounded-full border bg-background/95 shadow-sm backdrop-blur"
        disabled={refreshDisabled}
        size="icon"
        title="Refresh preview"
        type="button"
        variant="outline"
        onClick={onReload}
      >
        <RefreshCwIcon />
      </Button>
      <Button
        aria-label="Capture preview"
        className="pointer-events-auto size-9 shrink-0 rounded-full border bg-background/95 shadow-sm backdrop-blur"
        disabled={captureDisabled}
        size="icon"
        title="Capture preview"
        type="button"
        variant="outline"
        onClick={onCapture}
      >
        <FocusIcon />
      </Button>
    </>
  )
}

function PreviewAddress({
  disabled,
  locationBlocked,
  onNavigatePath,
  onOpen,
  previewLocation,
  previewProxy,
  source,
  syncStatus,
  updateNotice,
}: {
  disabled?: boolean
  locationBlocked: boolean
  onNavigatePath: (path: string) => void
  onOpen: () => void
  previewLocation?: string
  previewProxy?: PreviewProxyInfo
  source?: string
  syncStatus?: LiveSyncStatus
  updateNotice?: string
}) {
  const address = previewLocation ?? source ?? ""
  const path = address ? previewAddressPath(address) : ""
  const [draft, setDraft] = React.useState({ path, value: path })
  const draftPath = draft.path === path ? draft.value : path

  const commitPath = () => {
    if (disabled) return
    const nextPath = normalizePreviewPath(draftPath)
    setDraft({ path, value: nextPath })
    if (nextPath !== path) onNavigatePath(nextPath)
  }

  const copyAddress = () => {
    if (disabled || !address) return
    const clipboard = navigator.clipboard
    if (!clipboard) {
      toast.error("Unable to copy preview URL", { position: "bottom-right" })
      return
    }
    void clipboard
      .writeText(address)
      .then(() =>
        toast.success("Preview URL copied", { position: "bottom-right" })
      )
      .catch(() =>
        toast.error("Unable to copy preview URL", {
          position: "bottom-right",
        })
      )
  }

  return (
    <TooltipProvider>
      <div className="preview-address pointer-events-auto flex h-10 min-w-0 flex-1 items-center overflow-hidden rounded-full border bg-background/95 py-1 pr-1.5 pl-4 shadow-sm backdrop-blur">
        {source ? (
          <PreviewAddressOrigin source={source} />
        ) : (
          <span className="shrink-0 text-sm text-muted-foreground/50">
            Preview URL
          </span>
        )}
        <input
          aria-label="Preview path"
          className="w-8 min-w-0 flex-1 bg-transparent text-sm text-muted-foreground outline-none"
          disabled={disabled}
          spellCheck={false}
          value={draftPath}
          onBlur={commitPath}
          onChange={(event) =>
            setDraft({ path, value: event.currentTarget.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()
            if (event.key === "Escape") {
              setDraft({ path, value: path })
              event.currentTarget.blur()
            }
          }}
        />
        <PreviewUpdateChip message={updateNotice} />
        <CloudSyncBadge status={syncStatus} />
        {previewProxy && <PreviewProxyBadge proxy={previewProxy} />}
        {locationBlocked && <BlockedLocationBadge />}
        <Button
          aria-label="Copy preview URL"
          className="ml-1 size-7 shrink-0 rounded-full"
          disabled={disabled}
          size="icon"
          title={
            previewProxy?.kind === "cloud"
              ? "Copy public preview URL"
              : "Copy preview URL"
          }
          type="button"
          variant="ghost"
          onClick={copyAddress}
        >
          <CopyIcon />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Open preview in browser"
              className="size-7 shrink-0 rounded-full"
              disabled={disabled}
              size="icon"
              type="button"
              variant="ghost"
              onClick={onOpen}
            >
              <ExternalLinkIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 text-pretty" sideOffset={6}>
            {previewProxy?.kind === "cloud"
              ? "Open the public URL. Browser bindings proxied by Blame may not work outside the app."
              : previewProxy?.kind === "local"
                ? "Open the direct local preview URL. The isolated proxy is only used inside Blame."
                : "Open preview in browser"}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}

function PreviewAddressOrigin({ source }: { source: string }) {
  const origin = previewAddressOrigin(source)
  const cloud = blameCloudPreviewOrigin(source)
  if (!cloud) {
    return (
      <span
        className="max-w-2/3 shrink truncate text-sm text-muted-foreground/70"
        title={origin}
      >
        {origin}
      </span>
    )
  }
  return (
    <span
      aria-label={origin}
      className="flex shrink-0 items-center text-sm whitespace-nowrap"
      title={origin}
    >
      <span className="preview-cloud-origin-gradient preview-cloud-origin-gradient-protocol">
        {cloud.protocol}
      </span>
      <span className="text-muted-foreground/70">
        {cloud.compactIdentifier}
      </span>
      <span className="preview-cloud-origin-gradient preview-cloud-origin-gradient-domain">
        {cloud.suffix}
      </span>
    </span>
  )
}

function PreviewProxyBadge({ proxy }: { proxy: PreviewProxyInfo }) {
  const logicalOrigin = previewAddressOrigin(proxy.logicalUrl)
  const local = proxy.kind === "local"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={
            local
              ? "Preview uses Blame Local Container proxy"
              : "Preview uses Blame proxy"
          }
          className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground"
          tabIndex={0}
        >
          <NetworkIcon className="size-3" />
          <span className="preview-proxy-label">Proxy</span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        className="max-w-80 flex-col items-start gap-1.5 text-pretty"
        sideOffset={6}
      >
        {local ? (
          <>
            <span>
              Blame loads {logicalOrigin} through its isolated Local Container
              proxy.
            </span>
            <span className="opacity-80">
              Only endpoints declared by the project Compose configuration are
              reachable from this preview.
            </span>
          </>
        ) : (
          <>
            <span>
              Blame loads {logicalOrigin} through its local browser-binding
              proxy. The address shown is the public cloud URL.
            </span>
            <span className="opacity-80">
              Outside Blame, some cross-service requests may not work.
            </span>
          </>
        )}
        {proxy.reasons.length > 0 && (
          <span className="opacity-70">{proxy.reasons.join(" ")}</span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function BlockedLocationBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground"
      title="Le navigateur bloque l'URL interne de cette preview."
    >
      <LockIcon className="size-3" />
      URL interne masquée
    </span>
  )
}

// The width of an element, kept current as it changes.
function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = React.useState<T | null>(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.ceil(entry?.borderBoxSize[0]?.inlineSize ?? 0))
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width] as const
}

// The service the logs open on: the page's own unless another one runs
// while it does not.
function defaultLogService(items: RunLogItem[], previewService?: string) {
  const preferred = items.find(({ id }) => id === previewService)
  if (preferred && preferred.status === items[0]?.status) return preferred.id
  return items[0]?.id ?? ""
}

function activePreviewTab(
  tab: PreviewView,
  hasPreview: boolean,
  hasSetupLog: boolean,
  hasVariables: boolean
): PreviewView {
  if (tab === "preview" && hasPreview) return tab
  if (tab === "setup-log" && hasSetupLog) return tab
  if (tab === "variables" && hasVariables) return tab
  if (hasPreview) return "preview"
  return "setup-log"
}

function previewSource(previewUrl: string) {
  if (/^https?:\/\//.test(previewUrl)) return previewUrl
  return `http://${previewUrl}`
}

function nativePreviewWarmupStories(userStories: UserStory[]) {
  return userStories
    .filter(nativePreviewWarmupStory)
    .sort(nativePreviewWarmupStorySort)
    .slice(0, nativePreviewRetainedSessionLimit)
}

function cloudPreviewWarmupStories(userStories: UserStory[]) {
  return userStories.filter(
    (story) =>
      isActivePreviewStatus(story.status) &&
      story.workspaceMode === "cloud-mirror" &&
      Boolean(story.worktree) &&
      typeof story.runConfigurationId === "string"
  )
}

function isActivePreviewStatus(status: UserStory["status"] | undefined) {
  return status === "in-progress" || status === "in-review"
}

function equalUserStoryPreviewWarmupProps(
  previous: { userStories: UserStory[] },
  next: { userStories: UserStory[] }
) {
  const previousKeys = nativePreviewWarmupKeys(previous.userStories)
  const nextKeys = nativePreviewWarmupKeys(next.userStories)
  const previousCloudKeys = cloudPreviewWarmupKeys(previous.userStories)
  const nextCloudKeys = cloudPreviewWarmupKeys(next.userStories)
  const previousLocalKeys = localPreviewAutoStartKeys(previous.userStories)
  const nextLocalKeys = localPreviewAutoStartKeys(next.userStories)
  return (
    previousKeys.length === nextKeys.length &&
    previousKeys.every((key, index) => key === nextKeys[index]) &&
    previousCloudKeys.length === nextCloudKeys.length &&
    previousCloudKeys.every((key, index) => key === nextCloudKeys[index]) &&
    previousLocalKeys === nextLocalKeys
  )
}

function localPreviewAutoStartKeys(userStories: UserStory[]) {
  return localPreviewAutoStartStories(userStories)
    .map((story) => `${story.id}:${story.worktree}:${story.runConfigurationId}`)
    .join("|")
}

function cloudPreviewWarmupKeys(userStories: UserStory[]) {
  return cloudPreviewWarmupStories(userStories)
    .map(
      (story) =>
        `${story.id}:${story.worktree}:${story.runConfigurationId}:${story.status}`
    )
    .sort()
}

function nativePreviewWarmupKeys(userStories: UserStory[]) {
  return nativePreviewWarmupStories(userStories)
    .map((story) => {
      const source = previewSource(story.previewUrl ?? "")
      return nativePreviewKeyFor(storyPreviewDevtoolsScope(story.id), source)
    })
    .sort()
}

function nativePreviewWarmupStory(story: UserStory) {
  return Boolean(
    story.previewUrl &&
    story.workspaceMode === "local-container" &&
    (story.status === "in-review" || story.status === "in-progress")
  )
}

function nativePreviewWarmupStorySort(left: UserStory, right: UserStory) {
  return (
    nativePreviewWarmupStatusPriority(right) -
      nativePreviewWarmupStatusPriority(left) ||
    nativePreviewWarmupTime(right) - nativePreviewWarmupTime(left)
  )
}

function nativePreviewWarmupStatusPriority(story: UserStory) {
  if (story.status === "in-review") return 2
  if (story.status === "in-progress") return 1
  return 0
}

function nativePreviewWarmupTime(story: UserStory) {
  const time = new Date(story.updatedAt ?? story.createdAt).getTime()
  return Number.isFinite(time) ? time : 0
}

function nativePreviewKeyFor(key: string | undefined, source?: string) {
  return [key ?? "preview", source ?? ""].join(":")
}

function nativePreviewStorageKeyFor(key: string | undefined, source?: string) {
  return key ?? previewAddressOrigin(source ?? "preview")
}

function previewFrameLocation(frame: HTMLIFrameElement, source?: string) {
  try {
    const location = frame.contentWindow?.location.href
    if (!location || !source) return location
    return new URL(location).origin === new URL(source).origin
      ? location
      : undefined
  } catch {
    return undefined
  }
}

// A preview started or restarted while open, for example after a setup
// repair or when a suspended preview resumes, loads its URL before the
// server answers; reload once the start or recovery is done.
function useReloadAfterRecovery(
  status: string | undefined,
  setReloadKey: React.Dispatch<React.SetStateAction<number>>
) {
  const unsettledSinceReady = React.useRef(
    status === "error" || status === "pending"
  )
  React.useEffect(() => {
    if (status === "error" || status === "pending")
      unsettledSinceReady.current = true
    if (status !== "ready" || !unsettledSinceReady.current) return
    unsettledSinceReady.current = false
    setReloadKey((current) => current + 1)
  }, [setReloadKey, status])
}
