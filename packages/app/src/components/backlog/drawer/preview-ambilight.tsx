import * as React from "react"

import type { PreviewBrowserClient } from "@/context/platform"
import { cn } from "@/lib/utils"

type PreviewAmbilightColor = {
  blue: number
  green: number
  red: number
}

// The page's colors near each corner, with their mix where a corner has
// none worth showing.
export type PreviewAmbilight = {
  average: PreviewAmbilightColor
  corners: [
    topLeft: PreviewAmbilightColor,
    topRight: PreviewAmbilightColor,
    bottomLeft: PreviewAmbilightColor,
    bottomRight: PreviewAmbilightColor,
  ]
}

// Soft, irregular patches of the page's colors around its frame, drifting
// slowly like a lit cloud. Above the frame they reach past the toolbar,
// under the header that blurs them.
const ambilightPatches = [
  {
    corner: 0,
    className: "-top-16 -left-10 h-[46%] w-[48%]",
    radius: "58% 42% 63% 37% / 46% 55% 45% 54%",
    duration: 19,
    delay: -3,
  },
  {
    corner: 1,
    className: "-top-12 -right-10 h-[44%] w-[46%]",
    radius: "41% 59% 38% 62% / 57% 39% 61% 43%",
    duration: 23,
    delay: -11,
  },
  {
    corner: 2,
    className: "-bottom-12 -left-8 h-[44%] w-[44%]",
    radius: "63% 37% 52% 48% / 38% 61% 39% 62%",
    duration: 21,
    delay: -7,
  },
  {
    corner: 3,
    className: "-right-8 -bottom-14 h-[46%] w-[48%]",
    radius: "37% 63% 46% 54% / 59% 42% 58% 41%",
    duration: 25,
    delay: -15,
  },
  {
    corner: undefined,
    className: "-top-20 left-[24%] h-[28%] w-[52%]",
    radius: "50% 50% 43% 57% / 62% 48% 52% 38%",
    duration: 29,
    delay: -19,
  },
] as const

export function PreviewAmbilightCloud({
  ambilight,
}: {
  ambilight?: PreviewAmbilight
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 transition-opacity duration-1000",
        ambilight ? "opacity-40 dark:opacity-60" : "opacity-0"
      )}
    >
      {ambilight
        ? ambilightPatches.map((patch, index) => (
            <span
              key={index}
              className={cn(
                "preview-ambilight-patch absolute blur-[56px] transition-[background-color] duration-1000",
                patch.className
              )}
              style={{
                animationDelay: `${patch.delay}s`,
                animationDuration: `${patch.duration}s`,
                backgroundColor: ambilightRgb(
                  patch.corner === undefined
                    ? ambilight.average
                    : ambilight.corners[patch.corner]
                ),
                borderRadius: patch.radius,
              }}
            />
          ))
        : null}
    </div>
  )
}

// The frame's own depth, under the colored cloud.
export function previewAmbilightShadow() {
  return "0 16px 44px rgb(0 0 0 / 0.28)"
}

export function useNativePreviewAmbilight(
  client: PreviewBrowserClient,
  browserId: string | undefined,
  previewKey: string,
  visible: boolean
) {
  const [sample, setSample] = React.useState<{
    ambilight?: PreviewAmbilight
    key: string
  }>()

  React.useEffect(() => {
    if (!browserId || !visible) return
    let cancelled = false
    const sampleFrame = async () => {
      const ambilight = await captureNativePreviewAmbilight(client, browserId)
      if (cancelled) return
      setSample((current) =>
        current?.key === previewKey &&
        sameAmbilight(current.ambilight, ambilight)
          ? current
          : { ambilight, key: previewKey }
      )
    }
    const timeout = window.setTimeout(sampleFrame, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [browserId, client, previewKey, visible])

  return sample?.key === previewKey ? sample.ambilight : undefined
}

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
  return new Promise<PreviewAmbilight | undefined>((resolve) => {
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

function imageAmbilight(
  data: Uint8ClampedArray,
  width: number,
  height: number
): PreviewAmbilight | undefined {
  const all: PreviewAmbilightColor[] = []
  const corners: PreviewAmbilightColor[][] = [[], [], [], []]
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 60) continue
    const color = {
      blue: clampColorValue(data[index + 2]),
      green: clampColorValue(data[index + 1]),
      red: clampColorValue(data[index]),
    }
    if (!isUsefulAmbilightColor(color)) continue
    const pixel = index / 4
    const right = pixel % width >= width / 2
    const bottom = Math.floor(pixel / width) >= height / 2
    all.push(color)
    corners[(bottom ? 2 : 0) + (right ? 1 : 0)]?.push(color)
  }
  const average = averageAmbilightColor(all)
  if (!average) return undefined
  const corner = (index: number) =>
    averageAmbilightColor(corners[index] ?? []) ?? average
  return { average, corners: [corner(0), corner(1), corner(2), corner(3)] }
}

function averageAmbilightColor(colors: PreviewAmbilightColor[]) {
  if (!colors.length) return undefined
  const total = colors.reduce<PreviewAmbilightColor & { weight: number }>(
    (result, color) => {
      const weight = ambilightColorWeight(color)
      return {
        blue: result.blue + color.blue * weight,
        green: result.green + color.green * weight,
        red: result.red + color.red * weight,
        weight: result.weight + weight,
      }
    },
    { blue: 0, green: 0, red: 0, weight: 0 }
  )
  if (!total.weight) return undefined
  return {
    blue: Math.round(total.blue / total.weight),
    green: Math.round(total.green / total.weight),
    red: Math.round(total.red / total.weight),
  }
}

function isUsefulAmbilightColor(color: PreviewAmbilightColor) {
  const luminance =
    (0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue) / 255
  return (
    luminance > 0.05 && luminance < 0.96 && ambilightSaturation(color) > 0.04
  )
}

function ambilightColorWeight(color: PreviewAmbilightColor) {
  return 0.4 + ambilightSaturation(color) * 2
}

function ambilightSaturation(color: PreviewAmbilightColor) {
  const red = color.red / 255
  const green = color.green / 255
  const blue = color.blue / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  if (!max) return 0
  return (max - min) / max
}

function clampColorValue(value: number) {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}

function ambilightRgb(color: PreviewAmbilightColor) {
  return `rgb(${color.red} ${color.green} ${color.blue})`
}

function sameAmbilight(
  current: PreviewAmbilight | undefined,
  next: PreviewAmbilight | undefined
) {
  if (!current || !next) return current === next
  return [current.average, ...current.corners].every((color, index) => {
    const other = [next.average, ...next.corners][index]
    return (
      color.red === other?.red &&
      color.green === other.green &&
      color.blue === other.blue
    )
  })
}
