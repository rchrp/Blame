import * as THREE from 'three'
import {
  PRIMARY_TERRAIN_OFFSET,
  PRIMARY_TERRAIN_SCALE,
  PRIMARY_TERRAIN_Y,
  PRIMARY_TERRAIN_Z,
  TERRAIN_DEPTH,
  TERRAIN_HORIZON_FADE_END_Z,
  TERRAIN_HORIZON_FADE_START_Z,
  TERRAIN_MIN_WIDTH,
  TERRAIN_REFERENCE_ASPECT,
  TERRAIN_REFERENCE_WIDTH,
  TERRAIN_ULTRAWIDE_MARGIN,
  TERRAIN_WIDTH_SNAP,
} from './scene-constants'
import type { SceneQuality } from './scene-quality'
import { fbm2, type TerrainTextures } from './stone-textures'

export type TerrainRelief = {
  heightScale: number
  horizonRise: number
  ridgeIntensity: number
  mesaIntensity: number
  escarpmentIntensity: number
  foregroundShelfIntensity: number
  stoneMassIntensity: number
  // Fine crests and gullies over the large folds.
  detailIntensity: number
  baseDepth: number
}

export const terrainReliefPresets = {
  default: {
    heightScale: 1,
    horizonRise: 9.2,
    ridgeIntensity: 1,
    mesaIntensity: 1,
    escarpmentIntensity: 1,
    foregroundShelfIntensity: 1,
    stoneMassIntensity: 1,
    detailIntensity: 1,
    baseDepth: 4.65,
  },
  pricing: {
    heightScale: 0.74,
    horizonRise: 6.6,
    ridgeIntensity: 0.72,
    mesaIntensity: 1.28,
    escarpmentIntensity: 0.48,
    foregroundShelfIntensity: 0.36,
    stoneMassIntensity: 0.62,
    detailIntensity: 0.7,
    baseDepth: 3.9,
  },
  download: {
    heightScale: 0.86,
    horizonRise: 7.45,
    ridgeIntensity: 0.9,
    mesaIntensity: 0.82,
    escarpmentIntensity: 0.68,
    foregroundShelfIntensity: 0.52,
    stoneMassIntensity: 0.78,
    detailIntensity: 0.85,
    baseDepth: 4.18,
  },
} satisfies Record<string, TerrainRelief>

export type HeroSceneTerrainPreset = keyof typeof terrainReliefPresets

export type TerrainLayout = {
  width: number
  depth: number
  widthSegments: number
  depthSegments: number
}

export type ResponsiveTerrain = {
  group: THREE.Group
  mesh: THREE.Mesh<
    THREE.PlaneGeometry,
    THREE.MeshLambertMaterial | THREE.MeshStandardMaterial
  >
  layout: TerrainLayout
}

export function createTerrain(
  textures: TerrainTextures,
  quality: SceneQuality,
  layout: TerrainLayout,
  terrainRelief: TerrainRelief,
): ResponsiveTerrain {
  const terrain = new THREE.Group()
  const mesh = createTerrainMesh(
    textures,
    quality,
    layout,
    PRIMARY_TERRAIN_OFFSET,
    PRIMARY_TERRAIN_Y,
    PRIMARY_TERRAIN_Z,
    PRIMARY_TERRAIN_SCALE,
    terrainRelief,
  )
  terrain.add(mesh)

  return {
    group: terrain,
    mesh,
    layout,
  }
}

export function createTerrainLayout(
  quality: SceneQuality,
  viewportWidth: number,
  viewportHeight: number,
): TerrainLayout {
  const aspect = viewportWidth / Math.max(viewportHeight, 1)
  const aspectWidthScale = aspect / TERRAIN_REFERENCE_ASPECT
  const visibleWidthScale =
    aspectWidthScale > 1
      ? 1 + (aspectWidthScale - 1) * TERRAIN_ULTRAWIDE_MARGIN
      : aspectWidthScale
  const width = Math.ceil(
    Math.max(
      TERRAIN_MIN_WIDTH,
      TERRAIN_REFERENCE_WIDTH * visibleWidthScale,
    ) / TERRAIN_WIDTH_SNAP,
  ) * TERRAIN_WIDTH_SNAP
  const widthSegments = Math.max(
    32,
    Math.round(quality.terrainSegments * (width / TERRAIN_REFERENCE_WIDTH)),
  )

  return {
    width,
    depth: TERRAIN_DEPTH,
    widthSegments,
    depthSegments: quality.terrainSegments,
  }
}

export function updateTerrainLayout(
  terrain: ResponsiveTerrain,
  quality: SceneQuality,
  terrainRelief: TerrainRelief,
  viewportWidth: number,
  viewportHeight: number,
) {
  const nextLayout = createTerrainLayout(quality, viewportWidth, viewportHeight)

  if (isSameTerrainLayout(terrain.layout, nextLayout)) {
    return
  }

  terrain.mesh.geometry.dispose()
  terrain.mesh.geometry = createTerrainGeometry(
    nextLayout,
    PRIMARY_TERRAIN_OFFSET,
    PRIMARY_TERRAIN_SCALE,
    terrainRelief,
  )
  terrain.layout = nextLayout
}

function isSameTerrainLayout(current: TerrainLayout, next: TerrainLayout) {
  return (
    current.width === next.width &&
    current.depth === next.depth &&
    current.widthSegments === next.widthSegments &&
    current.depthSegments === next.depthSegments
  )
}

function createTerrainMesh(
  textures: TerrainTextures,
  quality: SceneQuality,
  layout: TerrainLayout,
  offset: number,
  y: number,
  z: number,
  scale: number,
  terrainRelief: TerrainRelief,
) {
  const geometry = createTerrainGeometry(layout, offset, scale, terrainRelief)
  const material = createTerrainMaterial(textures, quality)

  const mesh = new THREE.Mesh(geometry, material)
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.position.set(0, y, z)
  return mesh
}

function createTerrainGeometry(
  layout: TerrainLayout,
  offset: number,
  scale: number,
  terrainRelief: TerrainRelief,
) {
  const geometry = new THREE.PlaneGeometry(
    layout.width,
    layout.depth,
    layout.widthSegments,
    layout.depthSegments,
  )
  geometry.rotateX(-Math.PI / 2)

  const positions = geometry.attributes.position

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index)
    const z = positions.getZ(index)
    positions.setY(index, sampleTerrainHeight(x, z, offset, scale, terrainRelief))
  }

  geometry.computeVertexNormals()
  return geometry
}

function createTerrainMaterial(
  textures: TerrainTextures,
  quality: SceneQuality,
) {
  if (!quality.useDetailedTerrainMaterial) {
    return applyTerrainHorizonFade(new THREE.MeshLambertMaterial({
      color: 0x1d2a42,
      map: textures.color,
      bumpMap: textures.bump ?? null,
      bumpScale: TERRAIN_BUMP_SCALE,
      emissive: 0x071225,
      emissiveIntensity: 0.18,
    }))
  }

  return applyTerrainHorizonFade(new THREE.MeshStandardMaterial({
    color: TERRAIN_STONE_COLOR,
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: TERRAIN_BUMP_SCALE,
    roughnessMap: textures.roughness,
    roughness: 0.85,
    metalness: 0,
    // Lit by the sky it reflects (see createSkyEnvironment), not by a glow of
    // its own.
    emissive: 0x000000,
  }))
}

// How strongly the stone grain shades the surface.
const TERRAIN_BUMP_SCALE = 0.06
// The reflective stone's own colour: a grey slate, so its blue comes from the
// sky that lights it.
const TERRAIN_STONE_COLOR = 0x5a6680

// Fades the terrain out towards the horizon, and darkens its steep faces a
// little, so the slopes read as rock against the gentler ground.
function applyTerrainHorizonFade<
  Material extends THREE.MeshLambertMaterial | THREE.MeshStandardMaterial,
>(material: Material): Material {
  material.transparent = true
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `
          #include <common>
          varying float vTerrainLocalZ;
          varying float vTerrainSlope;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        `
          #include <begin_vertex>
          vTerrainLocalZ = position.z;
          vTerrainSlope = 1.0 - normal.y;
        `,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `
          #include <common>
          varying float vTerrainLocalZ;
          varying float vTerrainSlope;
        `,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `
          float terrainHorizonAlpha = smoothstep(${TERRAIN_HORIZON_FADE_END_Z.toFixed(1)}, ${TERRAIN_HORIZON_FADE_START_Z.toFixed(1)}, vTerrainLocalZ);
          float terrainSteepness = smoothstep(0.16, 0.6, vTerrainSlope);
          vec4 diffuseColor = vec4( diffuse * mix(1.0, 0.74, terrainSteepness), opacity * terrainHorizonAlpha );
        `,
      )
  }
  material.customProgramCacheKey = () => 'terrain-horizon-fade-v2'

  return material
}

export function sampleTerrainHeight(
  x: number,
  z: number,
  offset: number,
  scale: number,
  terrainRelief: TerrainRelief,
) {
  const distanceFromBasin = Math.sqrt((x - 4) ** 2 + (z + 24) ** 2)
  const packedNoise = fbm2((x + offset * 0.52) * 0.058, z * 0.058, 5)
  const coarseNoise = fbm2((x - offset) * 0.025 + 31.7, z * 0.025 - 12.4, 4)
  const horizonRise = THREE.MathUtils.smoothstep(-z, 4, 72) * terrainRelief.horizonRise
  const longitudinalFold =
    Math.sin((z + offset * 0.28) * 0.19 + x * 0.052 + coarseNoise * 1.35) *
      0.5 +
    0.5
  const diagonalFold =
    Math.sin(x * 0.145 - z * 0.082 + offset * 0.16 + packedNoise * 1.1) *
      0.5 +
    0.5
  const striatedRidges = THREE.MathUtils.smoothstep(
    0.48,
    0.94,
    longitudinalFold,
  )
  const erodedChannels = THREE.MathUtils.smoothstep(0.36, 0.88, diagonalFold)
  const distantMesa =
    Math.exp(-((z + 48) ** 2) / 560) *
    (4.8 + Math.sin((x + offset) * 0.11) * 1.2)
  const diagonalEscarpment =
    Math.exp(-((x * 0.42 + z + 24 + offset * 0.22) ** 2) / 135) * 5.6
  const foregroundShelf =
    Math.exp(-((z - 18) ** 2) / 42) *
    (2.2 + Math.sin((x - offset) * 0.24) * 0.55)
  const stoneMass = (packedNoise - 0.5) * 1.55 + (coarseNoise - 0.5) * 1.25
  const windErosion = Math.sin(distanceFromBasin * 0.32 + coarseNoise * 4.2) * 0.16
  // Low crests along the lines where a noise field crosses its middle, and
  // shallow gullies between them: texture on the slopes, so they catch the
  // light instead of reading as smooth hills, without new peaks.
  const crestNoise = fbm2(x * 0.17 + 7.3, z * 0.17 - 3.1, 3)
  const crest = Math.max(0, 1 - Math.abs(crestNoise * 2 - 1) * 2.2) ** 2
  const gully = fbm2(x * 0.34 - 4.4, z * 0.34 + 9.8, 2) - 0.5
  const detail = crest * 0.26 + gully * 0.18

  return (
    (horizonRise * 0.8 +
      distantMesa * 0.78 * terrainRelief.mesaIntensity +
      diagonalEscarpment * 0.68 * terrainRelief.escarpmentIntensity +
      foregroundShelf * 0.62 * terrainRelief.foregroundShelfIntensity +
      striatedRidges * (1.4 + coarseNoise * 1.1) * terrainRelief.ridgeIntensity +
      erodedChannels * 0.76 +
      stoneMass * 0.86 * terrainRelief.stoneMassIntensity +
      detail * terrainRelief.detailIntensity +
      windErosion -
      terrainRelief.baseDepth) *
    scale *
    terrainRelief.heightScale
  )
}

// The terrain's height at (x, z) in the mesh's own space, and its normal,
// exactly as drawn: interpolated over the triangle of the grid that holds the
// point, so whatever rests on it sits on the visible surface.
export function sampleTerrainSurface(
  terrain: ResponsiveTerrain,
  x: number,
  z: number,
  normal: THREE.Vector3,
) {
  const { width, depth, widthSegments, depthSegments } = terrain.layout
  const geometry = terrain.mesh.geometry
  const positions = geometry.attributes.position.array
  const normals = geometry.attributes.normal.array
  const column = THREE.MathUtils.clamp(
    ((x + width / 2) / width) * widthSegments,
    0,
    widthSegments - 1e-6,
  )
  const row = THREE.MathUtils.clamp(
    ((z + depth / 2) / depth) * depthSegments,
    0,
    depthSegments - 1e-6,
  )
  const cellX = Math.floor(column)
  const cellZ = Math.floor(row)
  const u = column - cellX
  const v = row - cellZ
  const stride = widthSegments + 1
  const a = cellZ * stride + cellX
  const b = a + stride
  const c = b + 1
  const d = a + 1
  // PlaneGeometry splits each cell into the triangles (a, b, d) and (b, c, d).
  const [i0, i1, i2, w0, w1, w2] =
    u + v <= 1 ? [a, d, b, 1 - u - v, u, v] : [c, b, d, u + v - 1, 1 - u, 1 - v]

  normal
    .set(
      normals[i0 * 3] * w0 + normals[i1 * 3] * w1 + normals[i2 * 3] * w2,
      normals[i0 * 3 + 1] * w0 + normals[i1 * 3 + 1] * w1 + normals[i2 * 3 + 1] * w2,
      normals[i0 * 3 + 2] * w0 + normals[i1 * 3 + 2] * w1 + normals[i2 * 3 + 2] * w2,
    )
    .normalize()
  return (
    positions[i0 * 3 + 1] * w0 + positions[i1 * 3 + 1] * w1 + positions[i2 * 3 + 1] * w2
  )
}
