import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import {
  CELEBRATION_DURATION,
  SUN_AZIMUTH_DEGREES,
  SUN_ELEVATION_DEGREES,
} from './scene-constants'
import type { ResponsiveTerrain } from './terrain'

// Sky, celebration waves and disposal helpers.

export function createCelebrationWaves(terrain: ResponsiveTerrain) {
  return [0, 0.42].map((delay) => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uRadius: { value: 0 },
        uOpacity: { value: 0 },
        uColor: {
          value: new THREE.Color(delay === 0 ? 0xa8e3ff : 0x858cff),
        },
      },
      vertexShader: `
        varying vec2 vTerrainPosition;

        void main() {
          vTerrainPosition = position.xz;
          vec3 liftedPosition = position + normal * 0.08;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(liftedPosition, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uRadius;
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec2 vTerrainPosition;

        void main() {
          float distanceFromOrigin = length(vTerrainPosition - vec2(0.0, -3.0));
          float ring = 1.0 - smoothstep(0.0, 1.15, abs(distanceFromOrigin - uRadius));
          gl_FragColor = vec4(uColor, ring * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
    const wave = new THREE.Mesh(terrain.mesh.geometry.clone(), material)
    wave.position.copy(terrain.mesh.position)
    wave.renderOrder = 12
    wave.userData.celebrationDelay = delay
    return wave
  })
}

export function updateCelebrationWaveGeometry(
  waves: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[],
  terrainGeometry: THREE.PlaneGeometry,
) {
  for (const wave of waves) {
    if (wave.userData.terrainGeometry === terrainGeometry) {
      continue
    }
    wave.geometry.dispose()
    wave.geometry = terrainGeometry.clone()
    wave.userData.terrainGeometry = terrainGeometry
  }
}

export function updateCelebrationWaves(
  waves: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[],
  time: number,
) {
  for (const wave of waves) {
    const progress = THREE.MathUtils.clamp(
      (time - 0.58 - Number(wave.userData.celebrationDelay)) / 1.75,
      0,
      1,
    )
    const easedProgress = 1 - (1 - progress) ** 3
    wave.material.uniforms.uRadius.value = THREE.MathUtils.lerp(0.2, 42, easedProgress)
    wave.material.uniforms.uOpacity.value =
      Math.sin(progress * Math.PI) * (1 - progress * 0.58) * 0.72
    wave.visible = progress > 0 && progress < 1
  }

  return time < CELEBRATION_DURATION
}

export function createSunDirection() {
  const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEGREES)
  const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEGREES)

  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta)
}

export function createAtmosphericSky() {
  const sky = new Sky()
  sky.scale.setScalar(450000)

  const uniforms = sky.material.uniforms
  uniforms.turbidity.value = 8.8
  uniforms.rayleigh.value = 1.05
  uniforms.mieCoefficient.value = 0.012
  uniforms.mieDirectionalG.value = 0.79
  uniforms.cloudCoverage.value = 0.18
  uniforms.cloudDensity.value = 0.14
  uniforms.cloudElevation.value = 0.62
  uniforms.sunPosition.value.copy(createSunDirection())
  sky.material.fragmentShader = sky.material.fragmentShader.replace(
    'gl_FragColor = vec4( texColor, 1.0 );',
    `
      vec3 paletteZenith = vec3(0.024, 0.032, 1);
      vec3 paletteHorizon = vec3(0.260, 0.235, 1);
      vec3 paletteSun = vec3(0.470, 0.410, 1);
      float horizonTint = 1.0 - smoothstep(0.0, 0.58, direction.y);
      float sunTint = pow(max(dot(direction, vSunDirection), 0.0), 12.0);
      vec3 paletteColor = mix(paletteZenith, paletteHorizon, horizonTint);
      paletteColor = mix(paletteColor, paletteSun, sunTint * 0.38);
      texColor = mix(texColor * 0.38, paletteColor, 0.82);
      gl_FragColor = vec4( texColor, 1.0 );
    `,
  )

  if ('showSunDisc' in uniforms) {
    uniforms.showSunDisc.value = true
  }

  sky.material.depthWrite = false
  sky.material.depthTest = false
  sky.renderOrder = -1000
  return sky
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    material.forEach((item) => item.dispose())
    return
  }

  material.dispose()
}

export function disposeObject3D(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Sprite) {
      child.material.map?.dispose()
      child.material.dispose()
      return
    }

    if (
      child instanceof THREE.Mesh ||
      child instanceof THREE.Line ||
      child instanceof THREE.Points
    ) {
      child.geometry.dispose()
      disposeMaterial(child.material)
    }
  })
}
