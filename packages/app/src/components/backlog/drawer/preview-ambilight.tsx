import * as React from "react"

import {
  glowColor,
  glowOpacity,
  imageAmbilight,
  sameAmbilight,
  type AmbilightColor,
  type AmbilightEdge,
  type PreviewAmbilight,
} from "@/components/backlog/drawer/preview-ambilight-colors"
import type { PreviewBrowserClient } from "@/context/platform"
import { cn } from "@/lib/utils"

export type { PreviewAmbilight }

// Soft, irregular patches around the page's frame, each by the edge whose
// color it takes, drifting slowly like a lit cloud. Above the frame they
// reach past the toolbar, under the header that blurs them.
const ambilightPatches: {
  edge: AmbilightEdge
  className: string
  radius: string
  duration: number
  delay: number
}[] = [
  {
    edge: "topLeft",
    className: "-top-14 -left-10 h-[30%] w-[40%]",
    radius: "58% 42% 63% 37% / 46% 55% 45% 54%",
    duration: 19,
    delay: -3,
  },
  {
    edge: "top",
    className: "-top-16 left-[30%] h-[26%] w-[40%]",
    radius: "50% 50% 43% 57% / 62% 48% 52% 38%",
    duration: 29,
    delay: -19,
  },
  {
    edge: "topRight",
    className: "-top-12 -right-10 h-[30%] w-[40%]",
    radius: "41% 59% 38% 62% / 57% 39% 61% 43%",
    duration: 23,
    delay: -11,
  },
  {
    edge: "right",
    className: "top-[22%] -right-14 h-[56%] w-[24%]",
    radius: "44% 56% 61% 39% / 52% 37% 63% 48%",
    duration: 27,
    delay: -5,
  },
  {
    edge: "bottomRight",
    className: "-right-8 -bottom-14 h-[30%] w-[40%]",
    radius: "37% 63% 46% 54% / 59% 42% 58% 41%",
    duration: 25,
    delay: -15,
  },
  {
    edge: "bottom",
    className: "-bottom-16 left-[30%] h-[26%] w-[40%]",
    radius: "55% 45% 38% 62% / 41% 58% 42% 59%",
    duration: 31,
    delay: -23,
  },
  {
    edge: "bottomLeft",
    className: "-bottom-12 -left-8 h-[30%] w-[40%]",
    radius: "63% 37% 52% 48% / 38% 61% 39% 62%",
    duration: 21,
    delay: -7,
  },
  {
    edge: "left",
    className: "top-[22%] -left-14 h-[56%] w-[24%]",
    radius: "57% 43% 40% 60% / 44% 63% 37% 56%",
    duration: 33,
    delay: -13,
  },
]

// Paused, the glow stays but stops drifting: each frame of the drift
// redraws eight large blurs.
export function PreviewAmbilightCloud({
  ambilight,
  paused,
}: {
  ambilight?: PreviewAmbilight
  paused?: boolean
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 transition-opacity duration-1000",
        ambilight ? "opacity-60 dark:opacity-85" : "opacity-0",
        paused && "preview-ambilight-paused"
      )}
    >
      {ambilight
        ? ambilightPatches.map((patch) => {
            const glow = ambilight[patch.edge]
            return (
              <span
                key={patch.edge}
                className={cn(
                  "preview-ambilight-patch absolute blur-[56px] transition-[background-color,opacity] duration-700",
                  patch.className
                )}
                style={{
                  animationDelay: `${patch.delay}s`,
                  animationDuration: `${patch.duration}s`,
                  backgroundColor: glow
                    ? ambilightRgb(glowColor(glow.color))
                    : "transparent",
                  borderRadius: patch.radius,
                  opacity: glowOpacity(glow),
                }}
              />
            )
          })
        : null}
    </div>
  )
}

// The frame's own depth, under the colored cloud.
export function previewAmbilightShadow() {
  return "0 16px 44px rgb(0 0 0 / 0.28)"
}

// Each sample reads the whole page back from the GPU: often enough to follow
// scrolling and in-page changes, and again soon after each navigation.
const ambilightSampleInterval = 8_000
const ambilightNavigationDelay = 600

export function useNativePreviewAmbilight(
  client: PreviewBrowserClient,
  browserId: string | undefined,
  previewKey: string,
  active: boolean
) {
  const [sample, setSample] = React.useState<{
    ambilight?: PreviewAmbilight
    key: string
  }>()

  // Sampled while the glow shows, so it follows what the page shows. A
  // pause keeps the last glow.
  React.useEffect(() => {
    if (!browserId || !active) return
    let cancelled = false
    let sampling = false
    let soon: number | undefined
    const sampleFrame = async () => {
      if (sampling) return
      sampling = true
      const ambilight = await captureNativePreviewAmbilight(client, browserId)
      sampling = false
      // A capture that failed keeps the glow; a page with no color to
      // spread (null) puts it out.
      if (cancelled || ambilight === undefined) return
      setSample((current) =>
        current?.key === previewKey &&
        sameAmbilight(current.ambilight, ambilight ?? undefined)
          ? current
          : { ambilight: ambilight ?? undefined, key: previewKey }
      )
    }
    const sampleSoon = (delay: number) => {
      window.clearTimeout(soon)
      soon = window.setTimeout(sampleFrame, delay)
    }
    sampleSoon(350)
    const again = window.setInterval(sampleFrame, ambilightSampleInterval)
    let page: { loading: boolean; url?: string } | undefined
    const stopState = client.onState({ id: browserId }, (state) => {
      const navigated =
        page !== undefined &&
        (state.url !== page.url || (page.loading && !state.loading))
      page = { loading: state.loading, url: state.url }
      if (navigated) sampleSoon(ambilightNavigationDelay)
    })
    return () => {
      cancelled = true
      window.clearTimeout(soon)
      window.clearInterval(again)
      stopState()
    }
  }, [active, browserId, client, previewKey])

  return sample?.key === previewKey ? sample.ambilight : undefined
}

// A small capture of the whole page (see the desktop's thumbnail size).
async function captureNativePreviewAmbilight(
  client: PreviewBrowserClient,
  browserId: string
) {
  try {
    const image = await client.capture({ id: browserId, size: "thumbnail" })
    return image ? await readImageAmbilight(image) : undefined
  } catch {
    return undefined
  }
}

function readImageAmbilight(dataUrl: string) {
  return new Promise<PreviewAmbilight | null | undefined>((resolve) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) {
        resolve(undefined)
        return
      }
      context.drawImage(image, 0, 0)
      const { data, width, height } = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
      )
      resolve(imageAmbilight(data, width, height))
    }
    image.onerror = () => resolve(undefined)
    image.src = dataUrl
  })
}

function ambilightRgb(color: AmbilightColor) {
  return `rgb(${color.red} ${color.green} ${color.blue})`
}
