import * as THREE from 'three'
import type { SceneQuality } from './scene-quality'

export type TerrainTextures = {
  color: THREE.CanvasTexture
  bump?: THREE.CanvasTexture
  roughness?: THREE.CanvasTexture
}

type StoneTextureKind = 'color' | 'bump' | 'roughness'

export type StonePixels = {
  size: number
  color: Uint8ClampedArray
  bump?: Uint8ClampedArray
  roughness?: Uint8ClampedArray
}

// Generating the stone pixels is the most expensive part of scene start-up, and
// the result only depends on the texture size. Keep it across mounts so page
// navigations and remounts reuse it instead of recomputing the noise.
const stonePixelCache = new Map<string, StonePixels>()

export function createStoneTextures(
  renderer: THREE.WebGLRenderer,
  quality: SceneQuality,
): TerrainTextures {
  const pixels = cachedStonePixels(
    quality.terrainTextureSize,
    quality.useDetailedTerrainMaterial,
  )
  const color = createStoneTexture('color', pixels.size, pixels.color, renderer, quality)

  if (!pixels.bump || !pixels.roughness) {
    return { color }
  }

  return {
    color,
    bump: createStoneTexture('bump', pixels.size, pixels.bump, renderer, quality),
    roughness: createStoneTexture(
      'roughness',
      pixels.size,
      pixels.roughness,
      renderer,
      quality,
    ),
  }
}

function cachedStonePixels(size: number, detailed: boolean) {
  const key = `${size}:${detailed ? 'detailed' : 'color'}`
  const cached = stonePixelCache.get(key)

  if (cached) {
    return cached
  }

  const pixels = computeStonePixels(size, detailed)
  stonePixelCache.set(key, pixels)
  return pixels
}

// Computes every requested map in a single pass. The color, bump and roughness
// maps share the same noise fields, so sampling them once instead of once per
// map divides the work by three without changing a single pixel.
export function computeStonePixels(size: number, detailed: boolean): StonePixels {
  const length = size * size * 4
  const color = new Uint8ClampedArray(length)
  const bump = detailed ? new Uint8ClampedArray(length) : undefined
  const roughness = detailed ? new Uint8ClampedArray(length) : undefined

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4
      const u = x / size
      const v = y / size
      const broadStone = fbm2(u * 5.4 + 19.1, v * 5.4 - 7.3, 6)
      const packedGrain = fbm2(u * 18.5 - 3.6, v * 18.5 + 42.2, 5)
      const pebbleRelief = fbm2(u * 42.0 + 8.7, v * 42.0 - 11.9, 4)
      const weathering = fbm2(
        u * 9.0 + broadStone * 1.8,
        v * 9.0 - packedGrain * 1.2,
        4,
      )
      const mineralFleck = Math.max(0, pebbleRelief - 0.72) * 92
      const stoneValue = THREE.MathUtils.clamp(
        92 +
          broadStone * 76 +
          packedGrain * 38 +
          weathering * 24 +
          mineralFleck,
        58,
        218,
      )

      color[index] = stoneValue * 0.64
      color[index + 1] = stoneValue * 0.78
      color[index + 2] = stoneValue * 0.9
      color[index + 3] = 255

      if (!bump || !roughness) {
        continue
      }

      const bumpValue = THREE.MathUtils.clamp(
        62 + broadStone * 118 + packedGrain * 54 + pebbleRelief * 42,
        34,
        242,
      )
      bump[index] = bumpValue
      bump[index + 1] = bumpValue
      bump[index + 2] = bumpValue
      bump[index + 3] = 255

      const roughnessValue = THREE.MathUtils.clamp(
        194 + weathering * 38 - mineralFleck * 0.18,
        166,
        246,
      )
      roughness[index] = roughnessValue
      roughness[index + 1] = roughnessValue
      roughness[index + 2] = roughnessValue
      roughness[index + 3] = 255
    }
  }

  return { size, color, bump, roughness }
}

function createStoneTexture(
  kind: StoneTextureKind,
  size: number,
  pixels: Uint8ClampedArray,
  renderer: THREE.WebGLRenderer,
  quality: SceneQuality,
) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size

  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('Unable to create stone texture canvas context')
  }

  const image = context.createImageData(size, size)
  image.data.set(pixels)
  context.putImageData(image, 0, 0)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace =
    kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(kind === 'color' ? 2.7 : 3.1, kind === 'color' ? 2.7 : 3.1)
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = Math.min(
    renderer.capabilities.getMaxAnisotropy(),
    quality.anisotropyCap,
  )
  return texture
}

export function fbm2(x: number, y: number, octaves: number) {
  let value = 0
  let amplitude = 0.5
  let frequency = 1
  let amplitudeTotal = 0

  for (let octave = 0; octave < octaves; octave += 1) {
    value += valueNoise2(x * frequency, y * frequency) * amplitude
    amplitudeTotal += amplitude
    frequency *= 2.03
    amplitude *= 0.52
  }

  return value / amplitudeTotal
}

function valueNoise2(x: number, y: number) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const xFade = smoothNoiseFraction(x - x0)
  const yFade = smoothNoiseFraction(y - y0)
  const bottomLeft = hashNoise2(x0, y0)
  const bottomRight = hashNoise2(x0 + 1, y0)
  const topLeft = hashNoise2(x0, y0 + 1)
  const topRight = hashNoise2(x0 + 1, y0 + 1)
  const bottom = lerp(bottomLeft, bottomRight, xFade)
  const top = lerp(topLeft, topRight, xFade)

  return lerp(bottom, top, yFade)
}

// Same formula as THREE.MathUtils.lerp, kept local so the hot loop avoids the
// property lookups.
function lerp(from: number, to: number, amount: number) {
  return (1 - amount) * from + amount * to
}

function smoothNoiseFraction(value: number) {
  return value * value * value * (value * (value * 6 - 15) + 10)
}

export function hashNoise2(x: number, y: number) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return value - Math.floor(value)
}
