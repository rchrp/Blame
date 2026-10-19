export type SceneQuality = {
  terrainSegments: number
  terrainTextureSize: number
  plusFieldStep: number
  pixelRatioCap: number
  anisotropyCap: number
  useNativeAntialias: boolean
  plusHeightUpdateInterval: number
  plusHeightMoveThreshold: number
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

  if (profile.cores >= 10 && profile.memory >= 8 && profile.pixelLoad < 3_200_000) {
    return {
      terrainSegments: 128,
      terrainTextureSize: 192,
      plusFieldStep: 2.55,
      pixelRatioCap: 1.35,
      anisotropyCap: 6,
      useNativeAntialias: true,
      plusHeightUpdateInterval: 1 / 45,
      plusHeightMoveThreshold: 0.1,
      useDetailedTerrainMaterial: true,
    }
  }

  return {
    terrainSegments: 96,
    terrainTextureSize: 160,
    plusFieldStep: 2.95,
    pixelRatioCap: 1.1,
    anisotropyCap: 4,
    useNativeAntialias: true,
    plusHeightUpdateInterval: 1 / 36,
    plusHeightMoveThreshold: 0.14,
    useDetailedTerrainMaterial: false,
  }
}

export function createLeanSceneQuality(): SceneQuality {
  return {
    terrainSegments: 64,
    terrainTextureSize: 128,
    plusFieldStep: 3.45,
    pixelRatioCap: 1,
    anisotropyCap: 2,
    useNativeAntialias: true,
    plusHeightUpdateInterval: 1 / 30,
    plusHeightMoveThreshold: 0.18,
    useDetailedTerrainMaterial: false,
  }
}

export function createSoftwareSceneQuality(): SceneQuality {
  return {
    terrainSegments: 48,
    terrainTextureSize: 96,
    plusFieldStep: 4.4,
    pixelRatioCap: 0.75,
    anisotropyCap: 1,
    useNativeAntialias: false,
    plusHeightUpdateInterval: 1 / 24,
    plusHeightMoveThreshold: 0.24,
    useDetailedTerrainMaterial: false,
  }
}
