export type SceneQuality = {
  terrainSegments: number
  // Spacing of the grid of "+" markers lit around the pointer.
  plusFieldStep: number
  pixelRatioCap: number
  useNativeAntialias: boolean
  useDetailedTerrainMaterial: boolean
}

export type DeviceProfile = {
  cores: number
  memory: number
  saveData: boolean
  coarsePointer: boolean
  viewportWidth: number
  pixelLoad: number
}

export function readDeviceProfile(): DeviceProfile {
  const navigatorProfile = navigator as Navigator & {
    connection?: { saveData?: boolean }
    deviceMemory?: number
  }

  return {
    cores: navigator.hardwareConcurrency ?? 4,
    memory: navigatorProfile.deviceMemory ?? 8,
    saveData: navigatorProfile.connection?.saveData === true,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    viewportWidth: window.innerWidth,
    pixelLoad: window.innerWidth * window.innerHeight * window.devicePixelRatio ** 2,
  }
}

export function createSceneQuality(profile: DeviceProfile): SceneQuality {
  if (
    profile.saveData ||
    profile.coarsePointer ||
    profile.viewportWidth < 900 ||
    profile.cores <= 4 ||
    profile.memory <= 4
  ) {
    return createLeanSceneQuality()
  }

  // The machine decides the terrain's surface; the screen's pixel count only
  // limits how many pixels draw it. A large or high-density screen keeps the
  // same lit, reflective stone, at a lower resolution.
  if (profile.cores >= 8 && profile.memory >= 8) {
    return {
      terrainSegments: 176,
      plusFieldStep: 1.9,
      pixelRatioCap: profile.cores >= 10 && profile.pixelLoad < 3_200_000 ? 1.35 : 1.1,
      useNativeAntialias: true,
      useDetailedTerrainMaterial: true,
    }
  }

  return {
    terrainSegments: 128,
    plusFieldStep: 2.1,
    pixelRatioCap: 1.1,
    useNativeAntialias: true,
    useDetailedTerrainMaterial: false,
  }
}

export function createLeanSceneQuality(): SceneQuality {
  return {
    terrainSegments: 88,
    plusFieldStep: 2.4,
    pixelRatioCap: 1,
    useNativeAntialias: true,
    useDetailedTerrainMaterial: false,
  }
}

export function createSoftwareSceneQuality(): SceneQuality {
  return {
    terrainSegments: 48,
    plusFieldStep: 4.4,
    pixelRatioCap: 0.75,
    useNativeAntialias: false,
    useDetailedTerrainMaterial: false,
  }
}
