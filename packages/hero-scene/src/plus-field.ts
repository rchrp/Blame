import * as THREE from 'three'
import {
  PLUS_FIELD_BACK_Z,
  PLUS_FIELD_FRONT_Z,
  PLUS_FIELD_POINTER_X_RANGE,
  PLUS_FIELD_RADIUS,
  PLUS_FIELD_RESPONSE,
  PLUS_FIELD_TERRAIN_CLEARANCE,
  TERRAIN_HORIZON_FADE_END_Z,
  TERRAIN_HORIZON_FADE_START_Z,
  createFrameLerp,
} from './scene-constants'
import type { SceneQuality } from './scene-quality'
import { sampleTerrainSurface, type ResponsiveTerrain } from './terrain'

// The "+" markers lit around the pointer. They form a fixed grid laid on the
// terrain, each one resting on the rendered surface and tilted with its
// slope; a round light follows the pointer across the grid, brightest and
// largest at its centre, fading out towards its rim. The grid never moves,
// so only two uniforms change per frame, and the terrain hides the markers a
// ridge stands in front of.

export type PlusField = {
  group: THREE.Group
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  center: THREE.Vector2
  terrainGeometry: THREE.BufferGeometry | null
}

export function createPlusField(
  quality: SceneQuality,
  terrain: ResponsiveTerrain,
  fogDensity: number,
  panRange = 0,
): PlusField {
  const grid = createGrid(quality.plusFieldStep, terrain, panRange)
  const geometry = createPlusGeometry()
  geometry.setAttribute(
    'aGrid',
    new THREE.InstancedBufferAttribute(new Float32Array(grid.flat()), 2),
  )

  const mesh = new THREE.InstancedMesh(
    geometry,
    createPlusMaterial(terrain.mesh.position.z, fogDensity),
    grid.length,
  )
  mesh.frustumCulled = false
  mesh.renderOrder = 8

  const group = new THREE.Group()
  group.add(mesh)

  const field: PlusField = {
    group,
    mesh,
    center: new THREE.Vector2(0, (PLUS_FIELD_BACK_Z + PLUS_FIELD_FRONT_Z) / 2),
    terrainGeometry: null,
  }
  placePlusField(field, terrain)
  return field
}

// Grid points, in the terrain group's space, wherever the light can reach and
// the terrain is drawn, wherever the camera pans.
function createGrid(step: number, terrain: ResponsiveTerrain, panRange: number) {
  const reachX = PLUS_FIELD_POINTER_X_RANGE + PLUS_FIELD_RADIUS + panRange / 2
  const terrainZ = terrain.mesh.position.z
  const nearZ = Math.min(
    PLUS_FIELD_FRONT_Z + PLUS_FIELD_RADIUS,
    terrainZ + terrain.layout.depth / 2 - step,
  )
  const farZ = Math.max(
    PLUS_FIELD_BACK_Z - PLUS_FIELD_RADIUS,
    terrainZ + TERRAIN_HORIZON_FADE_END_Z,
  )
  const points: [number, number][] = []
  for (let z = Math.ceil(farZ / step) * step; z <= nearZ; z += step) {
    for (let x = Math.ceil(-reachX / step) * step; x <= reachX; x += step) {
      points.push([x, z])
    }
  }
  return points
}

// Sets every marker on the terrain as it is drawn. Run again whenever the
// terrain geometry is rebuilt.
export function placePlusField(field: PlusField, terrain: ResponsiveTerrain) {
  const geometry = terrain.mesh.geometry
  if (field.terrainGeometry === geometry) {
    return
  }
  field.terrainGeometry = geometry

  const grid = field.mesh.geometry.getAttribute('aGrid') as THREE.InstancedBufferAttribute
  const normal = new THREE.Vector3()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3(1, 1, 1)
  const matrix = new THREE.Matrix4()
  const facing = new THREE.Vector3(0, 0, 1)
  const halfWidth = terrain.layout.width / 2 - 1

  for (let index = 0; index < grid.count; index += 1) {
    const x = THREE.MathUtils.clamp(grid.getX(index), -halfWidth, halfWidth)
    const z = grid.getY(index)
    const height = sampleTerrainSurface(terrain, x, z - terrain.mesh.position.z, normal)
    position
      .set(x, terrain.mesh.position.y + height, z)
      .addScaledVector(normal, PLUS_FIELD_TERRAIN_CLEARANCE)
    quaternion.setFromUnitVectors(facing, normal)
    matrix.compose(position, quaternion, scale)
    field.mesh.setMatrixAt(index, matrix)
  }
  field.mesh.instanceMatrix.needsUpdate = true
}

function createPlusGeometry() {
  const shape = new THREE.Shape()
  const armLength = 0.48
  const armWidth = 0.135

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

function createPlusMaterial(terrainZ: number, fogDensity: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2() },
      uRadius: { value: PLUS_FIELD_RADIUS },
      uFogDensity: { value: fogDensity },
      uStrength: { value: 1 },
    },
    vertexShader: `
      uniform float uTime;
      uniform vec2 uCenter;
      uniform float uRadius;
      uniform float uFogDensity;
      uniform float uStrength;
      attribute vec2 aGrid;
      varying float vOpacity;

      void main() {
        float light = 1.0 - smoothstep(0.0, 1.0, distance(aGrid, uCenter) / uRadius);
        light *= light;
        // Outside the light: no marker, no fragments.
        if (light < 0.004) {
          vOpacity = 0.0;
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        vec4 viewPosition = modelViewMatrix * instanceMatrix * vec4(position * mix(0.55, 1.0, light), 1.0);
        // The same fog and horizon fade as the terrain under it.
        float depth = -viewPosition.z;
        float fog = exp(-uFogDensity * uFogDensity * depth * depth);
        float horizon = smoothstep(${TERRAIN_HORIZON_FADE_END_Z.toFixed(1)}, ${TERRAIN_HORIZON_FADE_START_Z.toFixed(1)}, aGrid.y - ${terrainZ.toFixed(1)});
        float pulse = 0.9 + 0.1 * sin(uTime * 1.7 + aGrid.x * 0.26 + aGrid.y * 0.19);
        vOpacity = light * 0.88 * uStrength * pulse * mix(0.35, 1.0, fog) * horizon;
        gl_Position = projectionMatrix * viewPosition;
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
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  })
}

const target = new THREE.Vector2()

// `focusX` is where the camera looks along the ground: the light follows the
// pointer around it.
export function updatePlusField(
  field: PlusField,
  pointer: THREE.Vector2,
  focusX: number,
  elapsed: number,
  delta: number,
) {
  target.set(
    focusX + pointer.x * PLUS_FIELD_POINTER_X_RANGE,
    THREE.MathUtils.mapLinear(pointer.y, -1, 1, PLUS_FIELD_BACK_Z, PLUS_FIELD_FRONT_Z),
  )
  field.center.lerp(target, createFrameLerp(PLUS_FIELD_RESPONSE, delta))
  const uniforms = field.mesh.material.uniforms
  uniforms.uCenter.value.copy(field.center)
  uniforms.uTime.value = elapsed
}
