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
  storyId,
  surfaceWorktree,
  manifest: providedManifest,
  ...native
}: React.ComponentProps<typeof NativePreviewPanel> & {
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
  return <NativePreviewPanel {...native} />
}
