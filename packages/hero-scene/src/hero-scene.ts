import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import { createFramePacer } from './frame-pacing'
import {
  createSceneQuality,
  createSoftwareSceneQuality,
  readDeviceProfile,
  type SceneQuality,
} from './scene-quality'
import {
  createStoneTextures,
  fbm2,
  hashNoise2,
  type TerrainTextures,
} from './stone-textures'

const TERRAIN_REFERENCE_WIDTH = 132
const TERRAIN_DEPTH = 132
const TERRAIN_REFERENCE_ASPECT = 16 / 9
const TERRAIN_ULTRAWIDE_MARGIN = 1.25
const TERRAIN_WIDTH_SNAP = 4
const TERRAIN_MIN_WIDTH_MARGIN = 5
const SUN_ELEVATION_DEGREES = 5.2
const SUN_AZIMUTH_DEGREES = -166
const SUN_DIRECTION = createSunDirection()
const TWILIGHT_FOG_COLOR = 0x3666ff
const PLUS_FIELD_RADIUS = 11.5
const PLUS_FIELD_BACK_Z = -80
const PLUS_FIELD_FRONT_Z = 0
const PLUS_FIELD_POINTER_X_RANGE = 40
const PLUS_FIELD_TERRAIN_CLEARANCE = 0.24
const TERRAIN_MIN_WIDTH =
  (PLUS_FIELD_POINTER_X_RANGE + PLUS_FIELD_RADIUS + TERRAIN_MIN_WIDTH_MARGIN) * 2
const PRIMARY_TERRAIN_OFFSET = 0
const PRIMARY_TERRAIN_Y = -5
const PRIMARY_TERRAIN_Z = -15
const PRIMARY_TERRAIN_SCALE = 2
const FRAME_DELTA_MAX = 0.1
const CAMERA_POINTER_RESPONSE = 7
const CAMERA_TRAVEL_RESPONSE = 1.6
const CAMERA_BASE_Y = 7.4
const CAMERA_BASE_Z = 21
const CAMERA_TRAVEL_Y = 1.3
const CAMERA_TRAVEL_Z = 9
const CAMERA_INTRO_TRAVEL = -0.85
const CELEBRATION_DURATION = 2.8
const PLUS_FIELD_RESPONSE = 9
const PLUS_HEIGHT_RESPONSE = 20
const TERRAIN_HORIZON_FADE_START_Z = -48
const TERRAIN_HORIZON_FADE_END_Z = -66
const MOBILE_VIEWPORT_BREAKPOINT = 768
const SETTLED_EPSILON = 0.0015

type TerrainRelief = {
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

export type HeroSceneOptions = {
  terrainPreset?: HeroSceneTerrainPreset
  // Plays the celebration waves once, shortly after the first frame.
  celebration?: boolean
  // Starts the camera further back and glides it into place.
  intro?: boolean
  // Initial camera travel, from 0 (resting) to 1 (furthest forward).
  travel?: number
  // 'high-performance' wakes the discrete GPU on dual-GPU laptops. Use
  // 'default' where battery life matters more than headroom.
  powerPreference?: WebGLPowerPreference
  // Called once the first frame is on screen, after shaders have compiled.
  onReady?: () => void
}

export type HeroSceneController = {
  // Moves the camera forward over the terrain, from 0 to 1. Eased.
  setTravel(travel: number): void
  // Sends the celebration waves across the terrain.
  celebrate(): void
  dispose(): void
}

type TerrainLayout = {
  width: number
  depth: number
  widthSegments: number
  depthSegments: number
}

type ResponsiveTerrain = {
  group: THREE.Group
  mesh: THREE.Mesh<
    THREE.PlaneGeometry,
    THREE.MeshLambertMaterial | THREE.MeshStandardMaterial
  >
  layout: TerrainLayout
}

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

type PlusField = {
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

function isMobileSceneDevice() {
  return (
    window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT ||
    window.matchMedia('(pointer: coarse)').matches
  )
}

function usesSoftwareRenderer(renderer: THREE.WebGLRenderer) {
  const context = renderer.getContext()
  const debugInfo = context.getExtension('WEBGL_debug_renderer_info')

  if (!debugInfo) {
    return false
  }

  const rendererName = String(
    context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
  ).toLowerCase()

  return /swiftshader|software|llvmpipe|mesa offscreen/.test(rendererName)
}

export function createHeroScene(
  container: HTMLElement,
  options: HeroSceneOptions = {},
): HeroSceneController {
  const terrainRelief = terrainReliefPresets[options.terrainPreset ?? 'default']
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let quality = createSceneQuality(readDeviceProfile())
  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(TWILIGHT_FOG_COLOR, 0.012)

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 500000)
  camera.position.set(0, CAMERA_BASE_Y, CAMERA_BASE_Z)

  const powerPreference = options.powerPreference ?? 'high-performance'
  let renderer = createRenderer(quality, powerPreference)
  const softwareRenderer = usesSoftwareRenderer(renderer)
  if (softwareRenderer) {
    renderer.dispose()
    quality = createSoftwareSceneQuality()
    renderer = createRenderer(quality, powerPreference)
  }
  // Without a GPU every frame is drawn by the CPU and competes with the page
  // itself. Show the scene as a still image there, like for reduced motion.
  const staticScene = reducedMotion || softwareRenderer
  const shouldRenderInteractivePlusField = !isMobileSceneDevice() && !staticScene
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.62
  renderer.shadowMap.enabled = false
  renderer.domElement.style.display = 'block'
  container.appendChild(renderer.domElement)

  const sky = createAtmosphericSky()
  scene.add(sky)

  const terrainTextures = createStoneTextures(renderer, quality)
  const initialBounds = container.getBoundingClientRect()
  const terrainLayout = createTerrainLayout(
    quality,
    initialBounds.width,
    initialBounds.height,
  )
  const terrain = createTerrain(terrainTextures, quality, terrainLayout, terrainRelief)
  scene.add(terrain.group)

  let celebrationWaves: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = []
  let celebrationStart: number | null = null

  const plusField = shouldRenderInteractivePlusField
    ? createPlusField(quality, terrainRelief)
    : null

  if (plusField) {
    terrain.group.add(plusField.group)
  }

  const ambientLight = new THREE.HemisphereLight(0xbdc3fd, 0x07101f, 0.78)
  scene.add(ambientLight)

  const sunLight = new THREE.DirectionalLight(0xb3acf3, 2.8)
  sunLight.position.copy(SUN_DIRECTION).multiplyScalar(34)
  scene.add(sunLight)

  const sunFill = new THREE.PointLight(0x9799fc, 26, 110, 1.45)
  sunFill.position.copy(SUN_DIRECTION).multiplyScalar(38)
  scene.add(sunFill)

  const iceLight = new THREE.DirectionalLight(0x9799fc, 0.48)
  iceLight.position.set(15, 5, 15)
  scene.add(iceLight)

  const pointer = new THREE.Vector2(0, 0)
  const targetPointer = new THREE.Vector2(0, 0)
  const pacer = createFramePacer()
  const initialTravel = clampTravel(options.travel ?? 0)
  let travel = options.intro && !staticScene ? CAMERA_INTRO_TRAVEL : initialTravel
  let targetTravel = initialTravel
  let elapsed = 0
  let lastFrameTime: number | null = null
  let animationFrame = 0
  let disposed = false
  let ready = false
  let pageVisible = document.visibilityState !== 'hidden'
  let onScreen = true
  let pendingResize = true

  const applyResize = () => {
    pendingResize = false
    const { width, height } = container.getBoundingClientRect()
    if (width === 0 || height === 0) {
      return
    }
    renderer.setSize(width, height, false)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    camera.aspect = width / Math.max(height, 1)
    camera.updateProjectionMatrix()
    updateTerrainLayout(terrain, quality, terrainRelief, width, height)
    updateCelebrationWaveGeometry(celebrationWaves, terrain.mesh.geometry)
  }

  const updateCamera = (delta: number) => {
    pointer.lerp(targetPointer, createFrameLerp(CAMERA_POINTER_RESPONSE, delta))
    travel = THREE.MathUtils.lerp(
      travel,
      targetTravel,
      createFrameLerp(CAMERA_TRAVEL_RESPONSE, delta),
    )

    camera.position.x = pointer.x * 1.1
    camera.position.y = CAMERA_BASE_Y - pointer.y * 0.32 - travel * CAMERA_TRAVEL_Y
    camera.position.z = CAMERA_BASE_Z - travel * CAMERA_TRAVEL_Z
    camera.lookAt(
      pointer.x * 1.8,
      -0.52 - travel * 0.4,
      -8.5 - travel * CAMERA_TRAVEL_Z,
    )
  }

  const isSettled = () =>
    celebrationStart === null &&
    Math.abs(travel - targetTravel) < SETTLED_EPSILON &&
    pointer.distanceToSquared(targetPointer) < SETTLED_EPSILON ** 2

  const renderFrame = (delta: number) => {
    if (pendingResize) {
      applyResize()
    }
    elapsed += delta
    updateCamera(delta)

    terrain.group.rotation.z = Math.sin(elapsed * 0.08) * 0.006 + pointer.x * 0.012
    if (plusField) {
      updatePlusField(plusField, targetPointer, elapsed, delta, quality)
    }
    if (celebrationStart !== null) {
      const active = updateCelebrationWaves(celebrationWaves, elapsed - celebrationStart)
      if (!active) {
        celebrationStart = null
      }
    }

    renderer.render(scene, camera)
  }

  const shouldAnimate = () => ready && !disposed && pageVisible && onScreen

  const loop = (now: number) => {
    animationFrame = 0
    if (!shouldAnimate()) {
      lastFrameTime = null
      return
    }
    animationFrame = requestAnimationFrame(loop)

    if (!pacer.shouldRender(now, isSettled())) {
      return
    }

    const delta =
      lastFrameTime === null
        ? 1 / 60
        : Math.min((now - lastFrameTime) / 1000, FRAME_DELTA_MAX)
    lastFrameTime = now
    renderFrame(delta)
  }

  const startLoop = () => {
    if (staticScene) {
      // Still scene: no animation loop, the image is only redrawn when
      // something changes.
      if (ready && !disposed) {
        travel = targetTravel
        renderFrame(0)
      }
      return
    }
    if (animationFrame || !shouldAnimate()) {
      return
    }
    pacer.reset()
    animationFrame = requestAnimationFrame(loop)
  }

  const stopLoop = () => {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame)
      animationFrame = 0
    }
    lastFrameTime = null
  }

  const handleResize = () => {
    pendingResize = true
    if (staticScene) {
      startLoop()
      return
    }
    pacer.markActive(performance.now())
    startLoop()
  }

  const handlePointerMove = (event: PointerEvent) => {
    const bounds = container.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) {
      return
    }
    targetPointer.x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2
    targetPointer.y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2
    pacer.markActive(performance.now())
  }

  const handleVisibilityChange = () => {
    pageVisible = document.visibilityState !== 'hidden'
    if (pageVisible) startLoop()
    else stopLoop()
  }

  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleResize)
  resizeObserver?.observe(container)
  if (!resizeObserver) {
    window.addEventListener('resize', handleResize)
  }

  // Stop rendering entirely while the scene is scrolled out of view or
  // covered by a page that hides it.
  const intersectionObserver =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => {
          onScreen = entries.some((entry) => entry.isIntersecting)
          if (onScreen) startLoop()
          else stopLoop()
        })
  intersectionObserver?.observe(container)

  if (!staticScene) {
    window.addEventListener('pointermove', handlePointerMove, { passive: true })
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)

  const markReady = () => {
    if (disposed || ready) {
      return
    }
    ready = true
    applyResize()
    renderFrame(0)
    if (options.celebration && !staticScene) {
      controller.celebrate()
    }
    pacer.markActive(performance.now())
    startLoop()
    options.onReady?.()
  }

  const controller: HeroSceneController = {
    setTravel(nextTravel) {
      targetTravel = clampTravel(nextTravel)
      pacer.markActive(performance.now())
      startLoop()
    },
    celebrate() {
      if (staticScene || disposed) {
        return
      }
      if (celebrationWaves.length === 0) {
        celebrationWaves = createCelebrationWaves(terrain)
        for (const wave of celebrationWaves) {
          terrain.group.add(wave)
        }
      }
      celebrationStart = elapsed
      pacer.markActive(performance.now())
      startLoop()
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      stopLoop()
      resizeObserver?.disconnect()
      intersectionObserver?.disconnect()
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      disposeObject3D(sky)
      disposeObject3D(terrain.group)
      terrainTextures.color.dispose()
      terrainTextures.bump?.dispose()
      terrainTextures.roughness?.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }

  // Compile every shader before the first frame. With
  // KHR_parallel_shader_compile this happens off the main thread, so the page
  // stays responsive while the GPU prepares, then the scene appears complete
  // instead of stuttering through its first frames.
  applyResize()
  if (renderer.extensions.has('KHR_parallel_shader_compile')) {
    renderer.compileAsync(scene, camera).then(markReady, markReady)
  } else {
    // Without the extension compileAsync would block anyway; compile on the
    // next frame so the page can paint first.
    requestAnimationFrame(() => {
      if (disposed) return
      renderer.compile(scene, camera)
      markReady()
    })
  }

  return controller
}

function clampTravel(value: number) {
  return THREE.MathUtils.clamp(value, 0, 1)
}

function createRenderer(quality: SceneQuality, powerPreference: WebGLPowerPreference) {
  return new THREE.WebGLRenderer({
    alpha: true,
    antialias: quality.useNativeAntialias,
    powerPreference,
  })
}

function createCelebrationWaves(terrain: ResponsiveTerrain) {
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

function updateCelebrationWaveGeometry(
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

function updateCelebrationWaves(
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

function createTerrain(
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

function createTerrainLayout(
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

function updateTerrainLayout(
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

function sampleTerrainHeight(
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

function createPlusField(
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

function updatePlusField(
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

function createFrameLerp(response: number, delta: number) {
  return 1 - Math.exp(-response * delta)
}

function createSunDirection() {
  const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEGREES)
  const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEGREES)

  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta)
}

function createAtmosphericSky() {
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
  uniforms.sunPosition.value.copy(SUN_DIRECTION)
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

function disposeObject3D(object: THREE.Object3D) {
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
