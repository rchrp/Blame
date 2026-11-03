// What the preview's glow shows, read from a small capture of the whole
// page: like a screen's ambilight, each part of the glow takes the color
// along the edge of the page it sits by.

export type AmbilightColor = { blue: number; green: number; red: number }

// A color and how much of its edge it covers, from 0 to 1.
export type AmbilightGlow = { color: AmbilightColor; strength: number }

export const ambilightEdges = [
  "topLeft",
  "top",
  "topRight",
  "right",
  "bottomRight",
  "bottom",
  "bottomLeft",
  "left",
] as const

export type AmbilightEdge = (typeof ambilightEdges)[number]

export type PreviewAmbilight = Record<AmbilightEdge, AmbilightGlow | undefined>

// How deep into the page an edge reads.
const edgeBand = 0.2
const hueBins = 24
// Too dark or too gray to light anything.
const minimumValue = 0.15
const minimumSaturation = 0.18
// Less than this share of an edge in one color leaves it dark.
const minimumStrength = 0.01
// An edge with no color of its own takes a faint share of the page's.
const pageShare = 0.35

type HueHistogram = {
  blue: number[]
  green: number[]
  pixels: number
  red: number[]
  weight: number[]
}

export function imageAmbilight(
  data: ArrayLike<number>,
  width: number,
  height: number
): PreviewAmbilight | null {
  const edges = Object.fromEntries(
    ambilightEdges.map((edge) => [edge, hueHistogram()])
  ) as Record<AmbilightEdge, HueHistogram>
  const page = hueHistogram()
  for (let index = 0; index + 3 < data.length; index += 4) {
    if ((data[index + 3] ?? 0) < 60) continue
    const pixel = index / 4
    const x = ((pixel % width) + 0.5) / width
    const y = (Math.floor(pixel / width) + 0.5) / height
    const color = {
      blue: data[index + 2] ?? 0,
      green: data[index + 1] ?? 0,
      red: data[index] ?? 0,
    }
    addPixel(page, color)
    const edge = pixelEdge(x, y)
    if (edge) addPixel(edges[edge], color)
  }
  const pageGlow = dominantGlow(page)
  const glows = Object.fromEntries(
    ambilightEdges.map((edge) => {
      const own = dominantGlow(edges[edge])
      if (own) return [edge, own]
      if (!pageGlow) return [edge, undefined]
      return [
        edge,
        { color: pageGlow.color, strength: pageGlow.strength * pageShare },
      ]
    })
  ) as PreviewAmbilight
  return ambilightEdges.some((edge) => glows[edge]) ? glows : null
}

function pixelEdge(x: number, y: number): AmbilightEdge | undefined {
  const column = x < 1 / 3 ? 0 : x < 2 / 3 ? 1 : 2
  if (y < edgeBand) return (["topLeft", "top", "topRight"] as const)[column]
  if (y >= 1 - edgeBand)
    return (["bottomLeft", "bottom", "bottomRight"] as const)[column]
  if (x < edgeBand) return "left"
  if (x >= 1 - edgeBand) return "right"
  return undefined
}

function hueHistogram(): HueHistogram {
  const bins = () => Array.from({ length: hueBins }, () => 0)
  return { blue: bins(), green: bins(), pixels: 0, red: bins(), weight: bins() }
}

function addPixel(histogram: HueHistogram, color: AmbilightColor) {
  histogram.pixels += 1
  const max = Math.max(color.red, color.green, color.blue)
  const min = Math.min(color.red, color.green, color.blue)
  const value = max / 255
  const saturation = max ? (max - min) / max : 0
  if (value < minimumValue || saturation < minimumSaturation) return
  // Vivid and bright colors count most: they are what a glow shows.
  const weight = saturation * saturation * value
  const bin = Math.floor((hue(color, max, min) / 360) * hueBins) % hueBins
  histogram.weight[bin] = (histogram.weight[bin] ?? 0) + weight
  histogram.red[bin] = (histogram.red[bin] ?? 0) + color.red * weight
  histogram.green[bin] = (histogram.green[bin] ?? 0) + color.green * weight
  histogram.blue[bin] = (histogram.blue[bin] ?? 0) + color.blue * weight
}

// The color that holds most of the part, with its neighboring hues: the
// one a person sees there, never a gray mix of all of them.
function dominantGlow(histogram: HueHistogram): AmbilightGlow | undefined {
  if (!histogram.pixels) return undefined
  const around = (bin: number) =>
    [bin - 1, bin, bin + 1].map((value) => (value + hueBins) % hueBins)
  let best = -1
  let bestWeight = 0
  for (let bin = 0; bin < hueBins; bin += 1) {
    const weight = around(bin).reduce(
      (total, value) => total + (histogram.weight[value] ?? 0),
      0
    )
    if (weight > bestWeight) {
      best = bin
      bestWeight = weight
    }
  }
  const strength = bestWeight / histogram.pixels
  if (best < 0 || strength < minimumStrength) return undefined
  const sum = (channel: number[]) =>
    around(best).reduce((total, value) => total + (channel[value] ?? 0), 0)
  return {
    color: {
      blue: Math.round(sum(histogram.blue) / bestWeight),
      green: Math.round(sum(histogram.green) / bestWeight),
      red: Math.round(sum(histogram.red) / bestWeight),
    },
    strength: Math.min(1, strength),
  }
}

function hue(color: AmbilightColor, max: number, min: number) {
  const delta = max - min
  if (!delta) return 0
  const degrees =
    max === color.red
      ? ((color.green - color.blue) / delta) % 6
      : max === color.green
        ? (color.blue - color.red) / delta + 2
        : (color.red - color.green) / delta + 4
  return (degrees * 60 + 360) % 360
}

// As bright and a little more vivid than the page: the glow is its light.
export function glowColor(color: AmbilightColor): AmbilightColor {
  const max = Math.max(color.red, color.green, color.blue, 1)
  const lift = Math.max(1, 200 / max)
  const gray = (color.red + color.green + color.blue) / 3
  const vivid = (value: number) =>
    Math.max(0, Math.min(255, Math.round((gray + (value - gray) * 1.2) * lift)))
  return {
    blue: vivid(color.blue),
    green: vivid(color.green),
    red: vivid(color.red),
  }
}

// How strongly a part glows: a thin band of color still shows a little.
export function glowOpacity(glow: AmbilightGlow | undefined) {
  if (!glow) return 0
  return Math.min(1, 0.15 + Math.sqrt(glow.strength) * 1.3)
}

export function sameAmbilight(
  current: PreviewAmbilight | undefined,
  next: PreviewAmbilight | undefined
) {
  if (!current || !next) return current === next
  return ambilightEdges.every((edge) => {
    const left = current[edge]
    const right = next[edge]
    if (!left || !right) return left === right
    return (
      left.color.red === right.color.red &&
      left.color.green === right.color.green &&
      left.color.blue === right.color.blue &&
      Math.abs(left.strength - right.strength) < 0.01
    )
  })
}
