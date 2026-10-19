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
      emissive: 0x071225,
      emissiveIntensity: 0.18,
    }))
  }

  return applyTerrainHorizonFade(new THREE.MeshStandardMaterial({
    color: 0x1d2a42,
    map: textures.color,
    bumpMap: textures.bump,
    bumpScale: 0.045,
    roughnessMap: textures.roughness,
    roughness: 0.92,
    metalness: 0,
    emissive: 0x071225,
    emissiveIntensity: 0.12,
  }))
}

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
        `,
      )
      .replace(
        '#include <begin_vertex>',
        `
          #include <begin_vertex>
          vTerrainLocalZ = position.z;
        `,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `
          #include <common>
          varying float vTerrainLocalZ;
        `,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `
          float terrainHorizonAlpha = smoothstep(${TERRAIN_HORIZON_FADE_END_Z.toFixed(1)}, ${TERRAIN_HORIZON_FADE_START_Z.toFixed(1)}, vTerrainLocalZ);
          vec4 diffuseColor = vec4( diffuse, opacity * terrainHorizonAlpha );
        `,
      )
  }
  material.customProgramCacheKey = () => 'terrain-horizon-fade-v1'

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

  return (
    (horizonRise * 0.8 +
      distantMesa * 0.78 * terrainRelief.mesaIntensity +
      diagonalEscarpment * 0.68 * terrainRelief.escarpmentIntensity +
      foregroundShelf * 0.62 * terrainRelief.foregroundShelfIntensity +
      striatedRidges * (1.4 + coarseNoise * 1.1) * terrainRelief.ridgeIntensity +
      erodedChannels * 0.76 +
      stoneMass * 0.86 * terrainRelief.stoneMassIntensity +
      windErosion -
      terrainRelief.baseDepth) *
    scale *
    terrainRelief.heightScale
  )
}
