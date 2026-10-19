import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import { computeStonePixels, fbm2 } from './stone-textures.ts'

// The original generator, which computed the noise once per map. The single
// pass generator must produce exactly the same bytes.
function referencePixels(kind: 'color' | 'bump' | 'roughness', size: number) {
  const data = new Uint8ClampedArray(size * size * 4)
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
        92 + broadStone * 76 + packedGrain * 38 + weathering * 24 + mineralFleck,
        58,
        218,
      )
      if (kind === 'bump') {
        const bump = THREE.MathUtils.clamp(
          62 + broadStone * 118 + packedGrain * 54 + pebbleRelief * 42,
          34,
          242,
        )
        data.set([bump, bump, bump, 255], index)
        continue
      }
      if (kind === 'roughness') {
        const roughness = THREE.MathUtils.clamp(
          194 + weathering * 38 - mineralFleck * 0.18,
          166,
          246,
        )
        data.set([roughness, roughness, roughness, 255], index)
        continue
      }
      data.set([stoneValue * 0.64, stoneValue * 0.78, stoneValue * 0.9, 255], index)
    }
  }
  return data
}

test('single pass stone maps match the per-map generator byte for byte', () => {
  const size = 48
  const pixels = computeStonePixels(size, true)
  assert.deepEqual(pixels.color, referencePixels('color', size))
  assert.deepEqual(pixels.bump, referencePixels('bump', size))
  assert.deepEqual(pixels.roughness, referencePixels('roughness', size))
})

test('color only quality skips the detail maps', () => {
  const pixels = computeStonePixels(16, false)
  assert.equal(pixels.bump, undefined)
  assert.equal(pixels.roughness, undefined)
  assert.equal(pixels.color.length, 16 * 16 * 4)
})
