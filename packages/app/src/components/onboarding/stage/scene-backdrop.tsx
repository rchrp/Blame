import * as React from "react"
import type { HeroSceneController } from "@blame/hero-scene"

import { cn } from "@/lib/utils"

// The 3D terrain from the website, behind the onboarding screens.
//
// Three.js is loaded on demand so it never weighs on the main app bundle, and
// the canvas fades in only once its shaders are compiled. Until then, and on
// machines without WebGL, a matching CSS gradient stands in for it.
export function SceneBackdrop({
  className,
  onController,
}: {
  className?: string
  onController?(controller: HeroSceneController | null): void
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [ready, setReady] = React.useState(false)
  const onControllerRef = React.useRef(onController)

  React.useEffect(() => {
    onControllerRef.current = onController
  })

  React.useEffect(() => {
    const container = containerRef.current
    if (!container || !supportsWebGL()) return
    let controller: HeroSceneController | null = null
    let cancelled = false

    void import("@blame/hero-scene")
      .then(({ createHeroScene }) => {
        if (cancelled) return
        controller = createHeroScene(container, {
          terrainPreset: "download",
          intro: true,
          powerPreference: "default",
          onReady: () => {
            if (!cancelled) setReady(true)
          },
        })
        onControllerRef.current?.(controller)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
      onControllerRef.current?.(null)
      controller?.dispose()
    }
  }, [])

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,#ffffff_0%,#e6e8fb_45%,#cdd1f3_100%)] dark:bg-[radial-gradient(circle_at_50%_30%,#3a3f9a_0%,#141a4a_42%,#050712_100%)]" />
      <div
        ref={containerRef}
        className={cn(
          "absolute inset-0 transition-[opacity,transform] duration-[1400ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
          ready ? "scale-100 opacity-100" : "scale-[1.04] opacity-0"
        )}
      />
    </div>
  )
}

function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    // Release the probe context right away: browsers cap live WebGL contexts.
    context?.getExtension("WEBGL_lose_context")?.loseContext()
    return Boolean(context)
  } catch {
    return false
  }
}
