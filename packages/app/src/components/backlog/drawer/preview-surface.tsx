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

export function PreviewSurface({
  configuration,
  onRestart,
  storyId,
  surfaceWorktree,
  manifest: providedManifest,
  ...native
}: React.ComponentProps<typeof NativePreviewPanel> & {
  onRestart?: () => void
  configuration?: ProjectRunConfiguration
  storyId?: string
  manifest?: PreviewManifest
  surfaceWorktree?: string
}) {
  const platform = usePlatform()
  const [manifest, setManifest] = React.useState(providedManifest)
  const [enabled, setEnabled] = React.useState<string[]>([])
  React.useEffect(() => {
    let cancelled = false
    void platform.previewSurfaces?.enabled().then((value) => {
      if (!cancelled) setEnabled(value)
    })
    if (providedManifest) {
      setManifest(providedManifest)
      return () => {
        cancelled = true
      }
    }
    if (surfaceWorktree)
      void platform.workspace
        ?.readFile({
          root: surfaceWorktree,
          path: ".blame/initialization/preview-manifest.json",
        })
        .then((text) => {
          if (!cancelled && text) {
            try {
              setManifest(JSON.parse(text))
            } catch {
              setManifest(undefined)
            }
          }
        })
        .catch(() => {
          if (!cancelled) setManifest(undefined)
        })
    return () => {
      cancelled = true
    }
  }, [platform, surfaceWorktree, providedManifest])
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
          worktree: native.previewWorktree,
          sessionId: native.previewSessionId,
        }}
      />
    )
  }
  if (surface?.type === "display" && configuration?.previewService && storyId) {
    if (!enabled.includes("display")) return <SurfaceUnavailable message="Screen previews are not enabled on this computer." />
    return <DisplaySurfaceView active={native.visible} onRestart={onRestart} scope={{ storyId, serviceId: `${configuration.previewService}__display`, worktree: native.previewWorktree, sessionId: native.previewSessionId }} />
  }
  if (surface?.type === "web" && surface.device && enabled.includes("phone-web"))
    return <PhonePreview native={native} device={surface.device} />
  return <NativePreviewPanel {...native} />
}

function PhonePreview({ native, device }: { native: React.ComponentProps<typeof NativePreviewPanel>; device: "phone" | "tablet" }) {
  const client = React.useMemo(() => ({ ...native.client, create: (input: Parameters<typeof native.client.create>[0]) => native.client.create({ ...input, device }) }), [native.client, device])
  return <PhoneFrame device={device}><NativePreviewPanel {...native} client={client} sessionKey={`${native.sessionKey}:${device}`} storageKey={native.storageKey} /></PhoneFrame>
}
