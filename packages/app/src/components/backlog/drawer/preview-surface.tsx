import {
  HostWindowPanel,
  type HostWindowPanelProps,
} from "./surfaces/host-window-panel"
import { isHostWindowConfiguration } from "./surfaces/host-window-kind"
import { DeviceSurfaceView } from "./surfaces/device-surface-view"
import { DisplaySurfaceView } from "./surfaces/display-surface-view"
import { PhoneFrame } from "./surfaces/phone-frame"
import * as React from "react"
import type {
  PreviewManifest,
  ProjectRunConfiguration,
} from "@blame/agent-runtime"
import { usePlatform } from "@/context/platform"
import { NativePreviewPanel } from "./native-preview"
import { TerminalSurfaceView } from "./surfaces/terminal-surface-view"
import { SurfaceUnavailable } from "./surfaces/surface-unavailable"

type IntegratedPreviewProps = React.ComponentProps<
  typeof IntegratedPreviewSurface
>
export function PreviewSurface(
  props:
    | IntegratedPreviewProps
    | { hostWindow: HostWindowPanelProps }
    | { device: React.ComponentProps<typeof DeviceSurfaceView> }
) {
  if ("hostWindow" in props) return <HostWindowPanel {...props.hostWindow} />
  if ("device" in props) return <DeviceSurfaceView {...props.device} />
  return <IntegratedPreviewSurface {...props} />
}

function IntegratedPreviewSurface({
  configuration,
  onRestart,
  storyId,
  projectId,
  workspaceMode,
  runRequested,
  surfaceWorktree,
  manifest: providedManifest,
  ...native
}: React.ComponentProps<typeof NativePreviewPanel> & {
  onRestart?: () => void
  configuration?: ProjectRunConfiguration
  projectId?: string
  workspaceMode?: "direct" | "local-container" | "cloud-mirror" | null
  runRequested?: boolean
  storyId?: string
  manifest?: PreviewManifest
  surfaceWorktree?: string
}) {
  const platform = usePlatform()
  const manifest = usePreviewSurfaceManifest(providedManifest, surfaceWorktree)
  const [enabled, setEnabled] = React.useState<string[]>([])
  React.useEffect(() => {
    let cancelled = false
    void platform.previewSurfaces?.enabled().then((value) => {
      if (!cancelled) setEnabled(value)
    })
    return () => {
      cancelled = true
    }
  }, [platform])
  const view = surfaceView()
  return previewSurfaceType(configuration, manifest) === "web" ? (
    view
  ) : (
    <SurfaceFrame>{view}</SurfaceFrame>
  )

  function surfaceView() {
    if (isHostWindowConfiguration(configuration))
      return <HostWindowPanel mode={workspaceMode ?? "local-container"} />
    if (configuration?.previewTarget && storyId && projectId)
      return (
        <DeviceSurfaceView
          active={native.visible}
          running={Boolean(runRequested)}
          scope={{
            storyId,
            projectId,
            worktree: surfaceWorktree ?? "",
            manifest,
            targetId: configuration.previewTarget,
            workspaceMode: workspaceMode ?? "local-container",
          }}
        />
      )
    const surface = manifest?.services.find(
      (service) => service.id === configuration?.previewService
    )?.surface
    if (
      surface?.type === "terminal" &&
      configuration?.previewService &&
      storyId
    ) {
      if (!enabled.includes("terminal"))
        return (
          <SurfaceUnavailable message="Terminal previews are not enabled on this computer." />
        )
      return (
        <TerminalSurfaceView
          active={native.visible}
          scope={{
            storyId,
            serviceId: configuration.previewService,
            columns: surface.columns,
            rows: surface.rows,
            worktree: native.previewWorktree,
            sessionId: native.previewSessionId,
          }}
        />
      )
    }
    if (
      surface?.type === "display" &&
      configuration?.previewService &&
      storyId
    ) {
      if (!enabled.includes("display"))
        return (
          <SurfaceUnavailable message="Screen previews are not enabled on this computer." />
        )
      return (
        <DisplaySurfaceView
          active={native.visible}
          onRestart={onRestart}
          scope={{
            storyId,
            serviceId: `${configuration.previewService}__display`,
            worktree: native.previewWorktree,
            sessionId: native.previewSessionId,
          }}
        />
      )
    }
    if (
      surface?.type === "web" &&
      surface.device &&
      enabled.includes("phone-web")
    )
      return <PhonePreview native={native} device={surface.device} />
    return <NativePreviewPanel {...native} />
  }
}

function PhonePreview({
  native,
  device,
}: {
  native: React.ComponentProps<typeof NativePreviewPanel>
  device: "phone" | "tablet"
}) {
  const client = React.useMemo(
    () => ({
      ...native.client,
      create: (input: Parameters<typeof native.client.create>[0]) =>
        native.client.create({ ...input, device }),
    }),
    [native.client, device]
  )
  return (
    <PhoneFrame device={device}>
      <NativePreviewPanel
        {...native}
        client={client}
        sessionKey={`${native.sessionKey}:${device}`}
        storageKey={native.storageKey}
      />
    </PhoneFrame>
  )
}

/** The manifest that tells which surface a configuration shows. */
export function usePreviewSurfaceManifest(
  provided: PreviewManifest | undefined,
  worktree: string | undefined,
  /** Read again when it changes: a new story writes its manifest later. */
  refreshKey?: string
) {
  const platform = usePlatform()
  const [manifest, setManifest] = React.useState(provided)
  React.useEffect(() => {
    if (provided) {
      setManifest(provided)
      return
    }
    if (!worktree) return
    let cancelled = false
    void platform.workspace
      ?.readFile({
        root: worktree,
        path: ".blame/initialization/preview-manifest.json",
      })
      .then((text) => {
        if (cancelled || !text) return
        try {
          setManifest(JSON.parse(text))
        } catch {
          setManifest(undefined)
        }
      })
      .catch(() => {
        if (!cancelled) setManifest(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [platform, worktree, provided, refreshKey])
  return manifest
}

export function previewSurfaceType(
  configuration: ProjectRunConfiguration | undefined,
  manifest: PreviewManifest | undefined
) {
  if (isHostWindowConfiguration(configuration)) return "host-window"
  if (configuration?.previewTarget) return "device"
  return (
    manifest?.services.find(({ id }) => id === configuration?.previewService)
      ?.surface?.type ?? "web"
  )
}

// Leaves room for the floating preview toolbar, like the web preview.
function SurfaceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/20 px-4 pt-[72px] pb-4">
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-background">
        {children}
      </div>
    </div>
  )
}
