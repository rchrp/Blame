export type SceneQuality = {
  terrainSegments: number
  terrainTextureSize: number
  // Spacing of the grid of "+" markers lit around the pointer.
  plusFieldStep: number
  pixelRatioCap: number
  anisotropyCap: number
  useNativeAntialias: boolean
  useDetailedTerrainMaterial: boolean
  // Shades the terrain with the stone grain, on the cheaper material too.
  useTerrainBump: boolean
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
      terrainSegments: 176,
      terrainTextureSize: 192,
      plusFieldStep: 1.9,
      pixelRatioCap: 1.35,
      anisotropyCap: 6,
      useNativeAntialias: true,
      useDetailedTerrainMaterial: true,
      useTerrainBump: true,
    }
  }

  return {
    terrainSegments: 128,
    terrainTextureSize: 160,
    plusFieldStep: 2.1,
    pixelRatioCap: 1.1,
    anisotropyCap: 4,
    useNativeAntialias: true,
    useDetailedTerrainMaterial: false,
    useTerrainBump: true,
  }
}

export function createLeanSceneQuality(): SceneQuality {
  return {
    terrainSegments: 88,
    terrainTextureSize: 128,
    plusFieldStep: 2.4,
    pixelRatioCap: 1,
    anisotropyCap: 2,
    useNativeAntialias: true,
    useDetailedTerrainMaterial: false,
    useTerrainBump: true,
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
    useDetailedTerrainMaterial: false,
    useTerrainBump: false,
  }
}
