import * as THREE from 'three'
import {
  createAtmosphericSky,
  createCelebrationWaves,
  createSunDirection,
  disposeObject3D,
  updateCelebrationWaveGeometry,
  updateCelebrationWaves,
} from './effects'
import { createFramePacer } from './frame-pacing'
import { createPlusField, updatePlusField } from './plus-field'
import { createFrameLerp } from './scene-constants'
import {
  createSceneQuality,
  createSoftwareSceneQuality,
  readDeviceProfile,
  type SceneQuality,
} from './scene-quality'
import { createStoneTextures } from './stone-textures'
import {
  createTerrain,
  createTerrainLayout,
  terrainReliefPresets,
  updateTerrainLayout,
  type HeroSceneTerrainPreset,
} from './terrain'

export { terrainReliefPresets, type HeroSceneTerrainPreset }

const SUN_DIRECTION = createSunDirection()
const TWILIGHT_FOG_COLOR = 0x3666ff
const FRAME_DELTA_MAX = 0.1
const CAMERA_POINTER_RESPONSE = 7
const CAMERA_TRAVEL_RESPONSE = 1.6
const CAMERA_BASE_Y = 7.4
const CAMERA_BASE_Z = 21
const CAMERA_TRAVEL_Y = 1.3
const CAMERA_TRAVEL_Z = 9
const CAMERA_INTRO_TRAVEL = -0.85
const MOBILE_VIEWPORT_BREAKPOINT = 768
const SETTLED_EPSILON = 0.0015

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
