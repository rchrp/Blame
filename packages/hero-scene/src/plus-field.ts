import * as THREE from 'three'
import {
  PLUS_FIELD_BACK_Z,
  PLUS_FIELD_FRONT_Z,
  PLUS_FIELD_POINTER_X_RANGE,
  PLUS_FIELD_RADIUS,
  PLUS_FIELD_RESPONSE,
  PLUS_FIELD_TERRAIN_CLEARANCE,
  PLUS_HEIGHT_RESPONSE,
  PRIMARY_TERRAIN_OFFSET,
  PRIMARY_TERRAIN_SCALE,
  PRIMARY_TERRAIN_Y,
  PRIMARY_TERRAIN_Z,
  createFrameLerp,
} from './scene-constants'
import type { SceneQuality } from './scene-quality'
import { hashNoise2 } from './stone-textures'
import { sampleTerrainHeight, type TerrainRelief } from './terrain'

// The field of "+" markers that follows the pointer across the terrain.

type PlusMarker = {
  localX: number
  localZ: number
  scale: number
  rotation: number
  baseOpacity: number
  pulsePhase: number
  currentHeight: number
  targetHeight: number
}

export type PlusField = {
  group: THREE.Group
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  markers: PlusMarker[]
  matrix: THREE.Matrix4
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
  euler: THREE.Euler
  lastHeightUpdate: number
  lastSampleX: number
  lastSampleZ: number
  terrainRelief: TerrainRelief
}

export function createPlusField(
  quality: SceneQuality,
  terrainRelief: TerrainRelief,
): PlusField {
  const group = new THREE.Group()
  const markers: PlusMarker[] = []
  const geometry = createPlusGeometry()

  group.position.set(0, PRIMARY_TERRAIN_Y, 0)
  group.renderOrder = 8

  for (let localZ = -PLUS_FIELD_RADIUS; localZ <= PLUS_FIELD_RADIUS; localZ += quality.plusFieldStep) {
    for (let localX = -PLUS_FIELD_RADIUS; localX <= PLUS_FIELD_RADIUS; localX += quality.plusFieldStep) {
      const distance = Math.sqrt(localX ** 2 + localZ ** 2)

      if (distance > PLUS_FIELD_RADIUS) {
        continue
      }

      const edgeFade = 1 - THREE.MathUtils.smoothstep(
        PLUS_FIELD_RADIUS * 0.52,
        PLUS_FIELD_RADIUS,
        distance,
      )
      const jitterX = (hashNoise2(localX * 2.7, localZ * 2.7) - 0.5) * 0.42
      const jitterZ = (hashNoise2(localX * 3.1 + 17, localZ * 3.1 - 11) - 0.5) * 0.42
      const markerX = localX + jitterX
      const markerZ = localZ + jitterZ

      markers.push({
        localX: markerX,
        localZ: markerZ,
        rotation: (hashNoise2(localX + 8, localZ - 6) - 0.5) * 0.16,
        scale: 0.66 + edgeFade * 0.18,
        baseOpacity: 0.1 + edgeFade * 0.46,
        pulsePhase: markerX * 0.26 + markerZ * 0.19,
        currentHeight: 0,
        targetHeight: 0,
      })
    }
  }

  const material = createPlusMaterial()
  const mesh = new THREE.InstancedMesh(geometry, material, markers.length)
  const baseOpacity = new Float32Array(markers.length)
  const pulsePhase = new Float32Array(markers.length)
  const field = {
    group,
    mesh,
    markers,
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(),
    euler: new THREE.Euler(),
    lastHeightUpdate: -Infinity,
    lastSampleX: Infinity,
    lastSampleZ: Infinity,
    terrainRelief,
  }

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]
    baseOpacity[index] = marker.baseOpacity
    pulsePhase[index] = marker.pulsePhase
  }

  geometry.setAttribute('aBaseOpacity', new THREE.InstancedBufferAttribute(baseOpacity, 1))
  geometry.setAttribute('aPulsePhase', new THREE.InstancedBufferAttribute(pulsePhase, 1))
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  group.add(mesh)
  updatePlusTargetHeights(field, 0)
  snapPlusHeightsToTargets(field)
  updatePlusMatrices(field, 0)

  return field
}

function createPlusGeometry() {
  const shape = new THREE.Shape()
  const armLength = 0.42
  const armWidth = 0.12

  shape.moveTo(-armWidth, -armLength)
  shape.lineTo(armWidth, -armLength)
  shape.lineTo(armWidth, -armWidth)
  shape.lineTo(armLength, -armWidth)
  shape.lineTo(armLength, armWidth)
  shape.lineTo(armWidth, armWidth)
  shape.lineTo(armWidth, armLength)
  shape.lineTo(-armWidth, armLength)
  shape.lineTo(-armWidth, armWidth)
  shape.lineTo(-armLength, armWidth)
  shape.lineTo(-armLength, -armWidth)
  shape.lineTo(-armWidth, -armWidth)
  shape.closePath()

  return new THREE.ShapeGeometry(shape)
}

function createPlusMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: `
      uniform float uTime;
      attribute float aBaseOpacity;
      attribute float aPulsePhase;
      varying float vOpacity;

      void main() {
        vOpacity = max(0.02, aBaseOpacity + sin(uTime * 1.7 + aPulsePhase) * 0.08);
        vec4 instancePosition = instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * instancePosition;
      }
    `,
    fragmentShader: `
      varying float vOpacity;

      void main() {
        gl_FragColor = vec4(1.0, 1.0, 1.0, vOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  })
}

export function updatePlusField(
  field: PlusField,
  pointer: THREE.Vector2,
  elapsed: number,
  delta: number,
  quality: SceneQuality,
) {
  const follow = createFrameLerp(PLUS_FIELD_RESPONSE, delta)
  const targetZ = THREE.MathUtils.mapLinear(
    pointer.y,
    -1,
    1,
    PLUS_FIELD_BACK_Z,
    PLUS_FIELD_FRONT_Z,
  )
  field.group.position.x = THREE.MathUtils.lerp(
    field.group.position.x,
    pointer.x * PLUS_FIELD_POINTER_X_RANGE,
    follow,
  )
  field.group.position.z = THREE.MathUtils.lerp(field.group.position.z, targetZ, follow)
  field.mesh.material.uniforms.uTime.value = elapsed

  if (!shouldUpdatePlusHeights(field, elapsed, quality)) {
    updatePlusMatrices(field, delta)
    return
  }

  updatePlusTargetHeights(field, elapsed)
  updatePlusMatrices(field, delta)
}

function shouldUpdatePlusHeights(
  field: PlusField,
  elapsed: number,
  quality: SceneQuality,
) {
  if (elapsed - field.lastHeightUpdate < quality.plusHeightUpdateInterval) {
    return false
  }

  const movement = Math.hypot(
    field.group.position.x - field.lastSampleX,
    field.group.position.z - field.lastSampleZ,
  )

  return movement >= quality.plusHeightMoveThreshold
}

function updatePlusTargetHeights(field: PlusField, elapsed: number) {
  field.lastHeightUpdate = elapsed
  field.lastSampleX = field.group.position.x
  field.lastSampleZ = field.group.position.z

  for (const marker of field.markers) {
    const terrainX = field.group.position.x + marker.localX
    const terrainZ = field.group.position.z + marker.localZ - PRIMARY_TERRAIN_Z
    marker.targetHeight = sampleTerrainHeight(
      terrainX,
      terrainZ,
      PRIMARY_TERRAIN_OFFSET,
      PRIMARY_TERRAIN_SCALE,
      field.terrainRelief,
    )
  }
}

function snapPlusHeightsToTargets(field: PlusField) {
  for (const marker of field.markers) {
    marker.currentHeight = marker.targetHeight
  }
}

function updatePlusMatrices(field: PlusField, delta: number) {
  const heightFollow = createFrameLerp(PLUS_HEIGHT_RESPONSE, delta)

  for (let index = 0; index < field.markers.length; index += 1) {
    const marker = field.markers[index]
    marker.currentHeight = THREE.MathUtils.lerp(
      marker.currentHeight,
      marker.targetHeight,
      heightFollow,
    )

    field.position.set(
      marker.localX,
      marker.currentHeight + PLUS_FIELD_TERRAIN_CLEARANCE,
      marker.localZ,
    )
    field.euler.set(-Math.PI / 2, 0, marker.rotation)
    field.quaternion.setFromEuler(field.euler)
    field.scale.setScalar(marker.scale)
    field.matrix.compose(field.position, field.quaternion, field.scale)
    field.mesh.setMatrixAt(index, field.matrix)
  }

  field.mesh.instanceMatrix.needsUpdate = true
}
