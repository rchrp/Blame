import type { RuntimeProfileId } from "@blame/preview-runtime"
import type {
  PreviewManifest,
  ProjectPreviewRuntimeState,
} from "@blame/agent-runtime"
import type { PreviewSessionView } from "@blame/preview-runtime"
import * as React from "react"
import { toast } from "sonner"

import type { ProjectRunnerPendingOperation } from "@/components/backlog/board/project-runner-types"
import {
  managedPublicPreviewUrl,
  primaryPreviewRoute,
} from "@/components/backlog/drawer/managed-preview-url"
import { managedPreviewStopCommand } from "@/components/backlog/drawer/managed-preview-control"
import {
  idleManagedPreviewRuntime,
  managedPreviewActive,
  managedPreviewReady,
  managedPreviewRuntimeState,
} from "@/components/backlog/drawer/managed-preview-runtime-state"
import {
  acquireCloudPreviewControl,
  activeCloudPreviewControl,
  beginCloudPreviewControl,
  cachedCloudPreviewPendingOperation,
  cachedCloudPreviewSession,
  clearCloudPreviewSession,
  cloudPreviewSessionStorageId,
  publishCloudPreviewPendingOperation,
  publishCloudPreviewSession,
  subscribeCloudPreviewPendingOperation,
  subscribeCloudPreviewSession,
} from "@/components/backlog/drawer/cloud-preview-session-store"
import {
  usePreviewSetupRepair,
  type PreviewSetupRepairAction,
} from "@/components/backlog/drawer/preview-setup-repair"
import { usePlatform } from "@/context/platform"
import { useCloudAuth } from "@/context/cloud-auth"
import { navigate } from "@/components/navigation/navigation"
import {
  recordRuntimeSessionState,
  useRuntimePreference,
} from "@/lib/runtime-preference"

export type PreviewRunnerAction = "start" | "stop" | "restart"
type PreviewRunnerOptions = {
  autoStart?: boolean
  autoStartConfigurationId?: string | null
  // The story's own mode once it runs: its preview follows it, whatever
  // the default for new stories is.
  workspaceMode?: "local-container" | "cloud-mirror" | "direct" | null
}
type PreviewRuntimeSetter = React.Dispatch<
  React.SetStateAction<ProjectPreviewRuntimeState | undefined>
>
const deletedPreviewStories = new Set<string>()

export function useUserStoryPreviewRunner(
  worktree: string | null | undefined,
  enabled: boolean,
  userStoryId?: string,
  options: PreviewRunnerOptions = {}
) {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const workspace = platform.workspace
  const premium = auth.license?.licensed === true
  const accountPreference = useRuntimePreference(premium)
  const storyProfile: RuntimeProfileId | undefined = options.workspaceMode
    ? options.workspaceMode === "cloud-mirror"
      ? "vercel-compose"
      : "local-container"
    : undefined
  const preference = React.useMemo(
    () =>
      storyProfile
        ? { ...accountPreference, profile: storyProfile }
        : accountPreference,
    [accountPreference, storyProfile]
  )
  const autoStart =
    Boolean(options.autoStart) &&
    (premium || preference.profile === "local-container")
  const [runtime, setRuntime] = React.useState<ProjectPreviewRuntimeState>()
  const [selection, setSelection] = React.useState<{
    configurationId: string
    worktree?: string | null
  }>()
  const select = React.useCallback(
    (configurationId: string) => setSelection({ configurationId, worktree }),
    [worktree]
  )
  usePreviewRuntimePolling(
    workspace,
    worktree,
    enabled,
    preference.profile === "local-container"
      ? "local-container"
      : "cloud-mirror",
    autoStart,
    runtime?.configurations.length,
    setRuntime
  )
  const cloud = useCloudPreviewRuntime({
    enabled,
    localRuntime: runtime,
    platform,
    preference,
    userStoryId,
    worktree,
    autoStart,
    premium,
  })
  const cloudControl = cloud.control
  const cloudPendingOperation = cloud.pendingOperation
  const cloudRuntime = cloud.runtime
  const cloudSession = cloud.session
  const cloudPreviewIsReady = managedPreviewReady(cloudSession)
  const autoStartAttemptRef = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (
      !autoStart ||
      !enabled ||
      !userStoryId ||
      !worktree ||
      !workspace ||
      !platform.previewRuntime ||
      !preference.confirmedCloudUploadAt ||
      options.autoStartConfigurationId === null ||
      cloudPendingOperation ||
      cloudPreviewIsReady ||
      isCloudPreviewAutoStartDisabled(userStoryId)
    )
      return
    const configuration = options.autoStartConfigurationId
      ? cloudRuntime?.configurations.find(
          ({ id }) => id === options.autoStartConfigurationId
        )
      : (cloudRuntime?.configurations.find(
          ({ default: isDefault }) => isDefault
        ) ?? cloudRuntime?.configurations[0])
    if (!configuration?.services.length || !configuration.previewService) return
    const attemptKey = `${userStoryId}:${worktree}:${configuration.id}`
    if (autoStartAttemptRef.current === attemptKey) return
    autoStartAttemptRef.current = attemptKey
    void cloudControl("start", configuration.id)
  }, [
    cloudControl,
    cloudPendingOperation,
    cloudRuntime?.configurations,
    cloudPreviewIsReady,
    enabled,
    autoStart,
    options.autoStartConfigurationId,
    platform.previewRuntime,
    preference.confirmedCloudUploadAt,
    userStoryId,
    workspace,
    worktree,
  ])
  const repairAction = usePreviewSetupRepair(worktree, userStoryId)
  const local = usePreviewRuntimeControl(
    preference.profile === "local-container" ? workspace : undefined,
    worktree,
    setRuntime,
    select,
    repairAction,
    userStoryId
  )
  useResumeSuspendedLocalPreview(
    enabled && preference.profile === "local-container",
    worktree,
    runtime,
    local.control
  )
  const { control, pendingOperation } =
    preference.profile === "local-container" ? local : cloud
  const effectiveRuntime =
    preference.profile === "local-container" ? runtime : cloud.runtime
  React.useEffect(() => {
    if (!userStoryId) return
    const effectiveProfile = cloud.session?.profile ?? preference.profile
    const stopped =
      effectiveProfile === "local-container"
        ? effectiveRuntime?.desiredStatus !== "running"
        : !managedPreviewActive(cloud.session)
    recordRuntimeSessionState(userStoryId, effectiveProfile, stopped)
  }, [
    cloud.session,
    effectiveRuntime?.desiredStatus,
    preference.profile,
    userStoryId,
  ])
  const selectedOverride =
    selection && selection.worktree === worktree
      ? selection.configurationId
      : undefined
  const selectedId =
    pendingOperation?.configurationId ??
    selectedConfigurationId(effectiveRuntime, selectedOverride)
  return {
    control,
    error: cloud.error,
    pendingOperation,
    runtime: effectiveRuntime,
    lifecycle: effectiveRuntime?.lifecycle,
    previewSessionId: cloud.session?.id,
    integratedPreviewRequired:
      cloud.session?.endpointMap?.integratedPreviewRequired ?? false,
    previewProxyReasons:
      cloud.session?.endpointMap?.incompatibilityReasons ?? [],
    publicPreviewUrl: managedPublicPreviewUrl(cloud.session?.endpointMap),
    profile: cloud.session?.profile ?? preference.profile,
    usage: cloud.session?.usage,
    usageActive: cloud.session?.state.host === "running",
    selectedId,
    select,
  }
}

function useCloudPreviewRuntime(input: {
  enabled: boolean
  localRuntime?: ProjectPreviewRuntimeState
  platform: ReturnType<typeof usePlatform>
  preference: ReturnType<typeof useRuntimePreference>
  userStoryId?: string
  worktree?: string | null
  autoStart?: boolean
  premium: boolean
}) {
  const [session, setSession] = React.useState<PreviewSessionView>()
  const [error, setError] = React.useState<string>()
  const [pendingOperation, setPendingOperation] =
    React.useState<ProjectRunnerPendingOperation>()
  const stoppingSessionIdRef = React.useRef<string | undefined>(undefined)
  const client = input.platform.previewRuntime
  const profile = input.preference.profile
  const storageId = input.userStoryId
    ? cloudPreviewSessionStorageId(input.userStoryId, profile)
    : undefined
  const sessionId = session?.id
  const updateSession = React.useCallback(
    (value: PreviewSessionView) => {
      const current = storageId
        ? publishCloudPreviewSession(localStorage, storageId, value)
        : value
      setSession(current)
      return current
    },
    [storageId]
  )
  const updatePendingOperation = React.useCallback(
    (operation: ProjectRunnerPendingOperation | undefined) => {
      setPendingOperation(operation)
      if (storageId) {
        publishCloudPreviewPendingOperation(storageId, operation)
      }
    },
    [storageId]
  )

  React.useEffect(() => {
    let cancelled = false
    if (
      !input.enabled ||
      profile === "local-container" ||
      !client ||
      !storageId
    ) {
      queueMicrotask(() => {
        if (!cancelled) setSession(undefined)
      })
      return () => {
        cancelled = true
      }
    }
    queueMicrotask(() => {
      if (cancelled) return
      const latest = cachedCloudPreviewSession(storageId)
      setSession(latest)
    })
    const accept = (value: PreviewSessionView | undefined) => {
      if (cancelled) return
      setSession(value)
    }
    const unsubscribe = subscribeCloudPreviewSession(storageId, accept)
    void client
      .findForUserStory({
        userStoryId: input.userStoryId!,
        profile: "vercel-compose",
      })
      .then(({ session }) => {
        if (cancelled) return
        if (session) updateSession(session)
        else if (!activeCloudPreviewControl(input.userStoryId!))
          clearCloudPreviewSession(localStorage, storageId)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [
    client,
    input.enabled,
    input.userStoryId,
    profile,
    storageId,
    updateSession,
  ])

  React.useEffect(() => {
    let cancelled = false
    if (
      !input.enabled ||
      profile === "local-container" ||
      !client ||
      !storageId
    ) {
      queueMicrotask(() => {
        if (!cancelled) setPendingOperation(undefined)
      })
      return () => {
        cancelled = true
      }
    }
    const accept = (operation: ProjectRunnerPendingOperation | undefined) => {
      if (!cancelled) setPendingOperation(operation)
    }
    const unsubscribe = subscribeCloudPreviewPendingOperation(storageId, accept)
    queueMicrotask(() => {
      if (!cancelled) {
        setPendingOperation(cachedCloudPreviewPendingOperation(storageId))
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [client, input.enabled, profile, storageId])

  React.useEffect(() => {
    if (!sessionId || !client || !input.enabled) return
    return client.onEvent({ sessionId }, () => {
      void client
        .get({ sessionId })
        .then((value) => {
          if (stoppingSessionIdRef.current !== sessionId) {
            updateSession(value)
          }
        })
        .catch(() => undefined)
    })
  }, [client, input.enabled, sessionId, updateSession])

  React.useEffect(() => {
    if (!sessionId || !client || !input.enabled || !input.userStoryId) return
    const interval = window.setInterval(() => {
      void client
        .findForUserStory({
          userStoryId: input.userStoryId!,
          profile: "vercel-compose",
        })
        .then(({ session: value }) => {
          if (stoppingSessionIdRef.current !== sessionId) {
            if (value) updateSession(value)
            else if (
              storageId &&
              !activeCloudPreviewControl(input.userStoryId!)
            )
              clearCloudPreviewSession(localStorage, storageId)
          }
        })
        .catch(() => undefined)
    }, 2_000)
    return () => window.clearInterval(interval)
  }, [
    client,
    input.enabled,
    input.userStoryId,
    sessionId,
    storageId,
    updateSession,
  ])

  const control = React.useCallback(
    async (action: PreviewRunnerAction, configurationId?: string) => {
      if (action !== "stop" && !input.premium) {
        toast.info("Cloud previews require Blame Premium.", {
          action: {
            label: "View Premium",
            onClick: () => navigate("/premium"),
          },
        })
        return undefined
      }
      if (
        !client ||
        !input.worktree ||
        !input.userStoryId ||
        !configurationId ||
        profile === "local-container" ||
        !input.preference.confirmedCloudUploadAt ||
        pendingOperation
      )
        return undefined
      if (deletedPreviewStories.has(input.userStoryId)) return undefined
      const configuration = input.localRuntime?.configurations.find(
        ({ id }) => id === configurationId
      )
      if (!configuration) return undefined
      const controlLease = beginCloudPreviewControl(input.userStoryId)
      if (!controlLease.acquired) {
        await controlLease.completed
        return undefined
      }
      updatePendingOperation({ action, configurationId })
      setError(undefined)
      try {
        let active = session
        let importedCurrentWorkspace = false
        const cancelAutoStartIfRequested = async () => {
          if (
            !input.autoStart ||
            !isCloudPreviewAutoStartDisabled(input.userStoryId!)
          ) {
            return false
          }
          active = await client.command({
            sessionId: active!.id,
            command: managedPreviewStopCommand("stop"),
            operationId: crypto.randomUUID(),
          })
          active = updateSession(active)
          return true
        }
        if (!active && action === "stop") return undefined
        const manifestText =
          action === "start" || action === "restart"
            ? await input.platform.workspace?.readFile({
                root: input.worktree,
                path: ".blame/initialization/preview-manifest.json",
              })
            : undefined
        if ((action === "start" || action === "restart") && !manifestText) {
          throw new Error("Preview manifest is unavailable")
        }
        if (!active) {
          const operationId = await pendingCloudCreateOperation(
            input.userStoryId,
            profile,
            manifestText!
          )
          active = await client.create({
            userStoryId: input.userStoryId,
            profile,
            previewManifest: JSON.parse(manifestText!),
            cloudUploadConsentAt: input.preference.confirmedCloudUploadAt,
            operationId,
            localPath: input.worktree,
          })
          active = updateSession(active)
          localStorage.removeItem(
            cloudCreateOperationStorageId(input.userStoryId)
          )
        }
        if ((action === "start" || action === "restart") && !input.autoStart) {
          clearCloudPreviewAutoStartDisabled(input.userStoryId)
        }
        if (
          (action === "start" || action === "restart") &&
          (await cancelAutoStartIfRequested())
        ) {
          return managedPreviewRuntimeState(active!, input.localRuntime)
        }
        if (action === "start" || action === "restart") {
          if (
            active.pendingDeltaArtifactId &&
            ["pending_local_sync", "conflict"].includes(active.state.sync)
          ) {
            active = (
              await client.syncOut({
                sessionId: active.id,
                localPath: input.worktree,
              })
            ).session
            active = updateSession(active)
          }
          if (
            active.state.host !== "running" ||
            active.desired.host !== "active"
          ) {
            active = await client.command({
              sessionId: active.id,
              command: { type: "resume-host" },
              operationId: crypto.randomUUID(),
            })
          }
        }
        if (action === "stop") {
          const optimistic = stoppedCloudPreviewSession(active)
          stoppingSessionIdRef.current = active.id
          updateSession(optimistic)
          try {
            active = await settleCloudPreviewStop(
              client,
              active.id,
              input.userStoryId,
              optimistic,
              updateSession
            )
          } finally {
            if (stoppingSessionIdRef.current === active?.id) {
              stoppingSessionIdRef.current = undefined
            }
          }
          return managedPreviewRuntimeState(active, input.localRuntime)
        }
        if (!active.sourceRevision) {
          active = (
            await client.syncIn({
              sessionId: active.id,
              localPath: input.worktree,
            })
          ).session
          importedCurrentWorkspace = true
        }
        if (action === "restart") {
          active = await client.command({
            sessionId: active.id,
            command: managedPreviewStopCommand(action),
            operationId: crypto.randomUUID(),
          })
        }
        if (action === "start" || action === "restart") {
          if (await cancelAutoStartIfRequested()) {
            return managedPreviewRuntimeState(active!, input.localRuntime)
          }
          if (
            !importedCurrentWorkspace &&
            ["idle", "stopped", "failed"].includes(active.state.engine)
          ) {
            active = (
              await client.syncIn({
                sessionId: active.id,
                localPath: input.worktree,
              })
            ).session
          }
          active = await client.command({
            sessionId: active.id,
            command: {
              type: "start-services",
              configurationId,
              serviceIds: configuration.services,
              primaryRoute: primaryPreviewRoute(
                JSON.parse(manifestText!) as PreviewManifest,
                configuration
              ),
            },
            operationId: crypto.randomUUID(),
          })
        }
        active = updateSession(active)
        return managedPreviewRuntimeState(active, input.localRuntime)
      } catch (error) {
        const message = errorText(error)
        setError(message)
        toast.error("Unable to control managed preview", {
          description: message,
          position: "bottom-right",
        })
        return undefined
      } finally {
        controlLease.release()
        updatePendingOperation(undefined)
      }
    },
    [
      client,
      input.localRuntime,
      input.platform.workspace,
      input.autoStart,
      input.premium,
      input.preference.confirmedCloudUploadAt,
      input.userStoryId,
      input.worktree,
      pendingOperation,
      profile,
      session,
      updatePendingOperation,
      updateSession,
    ]
  )

  return {
    control,
    error,
    pendingOperation,
    runtime: session
      ? managedPreviewRuntimeState(session, input.localRuntime)
      : idleManagedPreviewRuntime(input.localRuntime),
    session,
  }
}

function stoppedCloudPreviewSession(session: PreviewSessionView) {
  const stateChangedAt = new Date().toISOString()
  return {
    ...session,
    desired: {
      ...session.desired,
      host: "suspended" as const,
      services: "stopped" as const,
      preview: "closed" as const,
      agent: "idle" as const,
    },
    state: {
      ...session.state,
      engine: "stopping" as const,
      preview: "closing" as const,
      agent: "idle" as const,
    },
    endpointMap: undefined,
    stateChangedAt,
  } satisfies PreviewSessionView
}

async function settleCloudPreviewStop(
  client: NonNullable<ReturnType<typeof usePlatform>["previewRuntime"]>,
  sessionId: string,
  userStoryId: string,
  optimistic: PreviewSessionView,
  updateSession: (session: PreviewSessionView) => PreviewSessionView
) {
  markCloudPreviewAutoStartDisabled(userStoryId)
  try {
    const next = await client.command({
      sessionId,
      command: managedPreviewStopCommand("stop"),
      operationId: crypto.randomUUID(),
    })
    return updateSession(next)
  } catch (error) {
    toast.error("Unable to stop managed preview", {
      description: errorText(error),
      position: "bottom-right",
    })
    try {
      return updateSession(await client.get({ sessionId }))
    } catch {
      // Keep the optimistic stopped state when the follow-up read is unavailable.
      return optimistic
    }
  }
}

export async function stopManagedCloudPreview(
  platform: ReturnType<typeof usePlatform>,
  userStoryId: string
) {
  markCloudPreviewAutoStartDisabled(userStoryId)
  const controlLease = await acquireCloudPreviewControl(userStoryId)
  try {
    const client = platform.previewRuntime
    if (!client) return false
    const storageId = cloudPreviewSessionStorageId(
      userStoryId,
      "vercel-compose"
    )
    const cachedSessionId = localStorage.getItem(storageId)
    const sessionId = await client
      .findForUserStory({ userStoryId, profile: "vercel-compose" })
      .then(({ session }) => session?.id)
      .catch(() => cachedSessionId)
    if (!sessionId) return false
    const session = await client.command({
      sessionId,
      command: managedPreviewStopCommand("stop"),
      operationId: crypto.randomUUID(),
    })
    publishCloudPreviewSession(localStorage, storageId, session)
    recordRuntimeSessionState(userStoryId, "vercel-compose", true)
    return true
  } finally {
    controlLease.release()
  }
}

export async function beginUserStoryPreviewDeletion(userStoryId: string) {
  deletedPreviewStories.add(userStoryId)
  markCloudPreviewAutoStartDisabled(userStoryId)
  await activeCloudPreviewControl(userStoryId)
}

export function clearUserStoryPreviewState(userStoryId: string) {
  const storageId = cloudPreviewSessionStorageId(userStoryId, "vercel-compose")
  clearCloudPreviewSession(localStorage, storageId)
  localStorage.removeItem(cloudPreviewAutoStartDisabledStorageId(userStoryId))
  localStorage.removeItem(cloudCreateOperationStorageId(userStoryId))
  recordRuntimeSessionState(userStoryId, "local-container", true)
  recordRuntimeSessionState(userStoryId, "vercel-compose", true)
  deletedPreviewStories.delete(userStoryId)
}

export function cancelUserStoryPreviewDeletion(userStoryId: string) {
  deletedPreviewStories.delete(userStoryId)
  localStorage.removeItem(cloudPreviewAutoStartDisabledStorageId(userStoryId))
}

export function clearCloudPreviewAutoStartDisabled(userStoryId: string) {
  localStorage.removeItem(cloudPreviewAutoStartDisabledStorageId(userStoryId))
}

function markCloudPreviewAutoStartDisabled(userStoryId: string) {
  localStorage.setItem(cloudPreviewAutoStartDisabledStorageId(userStoryId), "1")
}

/** Whether the user stopped this story's preview, cloud or local. */
export function isPreviewAutoStartDisabled(userStoryId: string) {
  return isCloudPreviewAutoStartDisabled(userStoryId)
}

function isCloudPreviewAutoStartDisabled(userStoryId: string) {
  return (
    deletedPreviewStories.has(userStoryId) ||
    localStorage.getItem(
      cloudPreviewAutoStartDisabledStorageId(userStoryId)
    ) === "1"
  )
}

function cloudPreviewAutoStartDisabledStorageId(userStoryId: string) {
  return `blame.preview-auto-start-disabled.${userStoryId}`
}

function cloudCreateOperationStorageId(userStoryId: string) {
  return `blame.preview-create-operation.${userStoryId}`
}

async function pendingCloudCreateOperation(
  userStoryId: string,
  profile: string,
  manifestText: string
) {
  const storageId = cloudCreateOperationStorageId(userStoryId)
  const fingerprint = await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(`${profile}\0${manifestText}`))
    .then((value) =>
      Array.from(new Uint8Array(value), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("")
    )
  try {
    const pending = JSON.parse(localStorage.getItem(storageId) ?? "null") as {
      fingerprint?: unknown
      operationId?: unknown
    } | null
    if (
      pending?.fingerprint === fingerprint &&
      typeof pending.operationId === "string"
    ) {
      return pending.operationId
    }
  } catch {
    localStorage.removeItem(storageId)
  }
  const operationId = crypto.randomUUID()
  localStorage.setItem(storageId, JSON.stringify({ fingerprint, operationId }))
  return operationId
}

function usePreviewRuntimePolling(
  workspace: ReturnType<typeof usePlatform>["workspace"],
  worktree: string | null | undefined,
  enabled: boolean,
  workspaceMode: "local-container" | "cloud-mirror",
  stopAfterConfigured: boolean,
  configuredCount: number | undefined,
  setRuntime: PreviewRuntimeSetter
) {
  React.useEffect(() => {
    setRuntime(undefined)
  }, [enabled, setRuntime, workspace, workspaceMode, worktree])

  React.useEffect(() => {
    if (!worktree || !workspace?.projectPreviewRuntimeState) return
    let cancelled = false
    const refresh = () => {
      void refreshPreviewRuntime(
        workspace,
        worktree,
        workspaceMode,
        () => cancelled,
        setRuntime
      )
    }
    if (enabled) refresh()
    const interval =
      enabled && !(stopAfterConfigured && configuredCount)
        ? window.setInterval(refresh, 2_000)
        : undefined
    return () => {
      cancelled = true
      if (interval) window.clearInterval(interval)
    }
  }, [
    configuredCount,
    enabled,
    setRuntime,
    stopAfterConfigured,
    workspace,
    workspaceMode,
    worktree,
  ])
}

async function refreshPreviewRuntime(
  workspace: ReturnType<typeof usePlatform>["workspace"],
  worktree: string,
  workspaceMode: "local-container" | "cloud-mirror",
  cancelled: () => boolean,
  setRuntime: PreviewRuntimeSetter
) {
  try {
    const next = await workspace?.projectPreviewRuntimeState?.({
      workspaceMode,
      worktree,
    })
    if (!cancelled() && next?.configurations.length) setRuntime(next)
  } catch {
    return
  }
}

// Blame stops a local preview nobody used for a while and marks it
// suspended: opening it starts it again.
function useResumeSuspendedLocalPreview(
  viewing: boolean,
  worktree: string | null | undefined,
  runtime: ProjectPreviewRuntimeState | undefined,
  control: (
    action: PreviewRunnerAction,
    configurationId?: string
  ) => Promise<unknown>
) {
  const resumedRef = React.useRef<string | undefined>(undefined)
  const lifecycle = runtime?.lifecycle
  const configurationId = runtime?.selectedConfigurationId
  React.useEffect(() => {
    if (!viewing || !worktree || !configurationId) return
    if (lifecycle?.phase !== "suspended") return
    const key = `${worktree}:${lifecycle.since}`
    if (resumedRef.current === key) return
    resumedRef.current = key
    void control("start", configurationId)
  }, [configurationId, control, lifecycle, viewing, worktree])
}

function usePreviewRuntimeControl(
  workspace: ReturnType<typeof usePlatform>["workspace"],
  worktree: string | null | undefined,
  setRuntime: PreviewRuntimeSetter,
  setSelectedId: (configurationId: string) => void,
  repairAction: (error: string) => PreviewSetupRepairAction | undefined,
  userStoryId: string | undefined
) {
  const [pendingOperation, setPendingOperation] =
    React.useState<ProjectRunnerPendingOperation>()
  const control = React.useCallback(
    async (action: PreviewRunnerAction, configurationId?: string) => {
      if (!worktree || !workspace?.controlProjectPreview || pendingOperation)
        return undefined
      const selectedId = configurationId
      if (!selectedId) return undefined
      setSelectedId(selectedId)
      setPendingOperation({ action, configurationId: selectedId })
      // A preview the user stopped stays stopped until they start it again.
      if (userStoryId && action === "stop")
        markCloudPreviewAutoStartDisabled(userStoryId)
      else if (userStoryId) clearCloudPreviewAutoStartDisabled(userStoryId)
      const next = await requestPreviewRuntime(
        workspace,
        worktree,
        action,
        selectedId,
        repairAction
      )
      if (next) setRuntime(next)
      setPendingOperation(undefined)
      return next
    },
    [
      pendingOperation,
      repairAction,
      setRuntime,
      setSelectedId,
      userStoryId,
      workspace,
      worktree,
    ]
  )
  return { control, pendingOperation }
}

async function requestPreviewRuntime(
  workspace: NonNullable<ReturnType<typeof usePlatform>["workspace"]>,
  worktree: string,
  action: PreviewRunnerAction,
  configurationId: string | undefined,
  repairAction: (error: string) => PreviewSetupRepairAction | undefined
) {
  try {
    return await workspace.controlProjectPreview!({
      action,
      configurationId,
      worktree,
    })
  } catch (error) {
    const description = errorText(error)
    toast.error("Unable to control preview", {
      action: action === "stop" ? undefined : repairAction(description),
      description,
      duration: 15_000,
      position: "bottom-right",
    })
    return undefined
  }
}

export type UserStoryPreviewRunner = ReturnType<
  typeof useUserStoryPreviewRunner
>

function selectedConfigurationId(
  runtime: ProjectPreviewRuntimeState | undefined,
  selectedOverride: string | undefined
) {
  const overrideExists = runtime?.configurations.some(
    ({ id }) => id === selectedOverride
  )
  return overrideExists ? selectedOverride : runtime?.selectedConfigurationId
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
