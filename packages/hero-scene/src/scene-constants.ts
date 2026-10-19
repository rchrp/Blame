// Scene layout shared by the terrain, the plus field and the effects.
export const TERRAIN_REFERENCE_WIDTH = 132
export const TERRAIN_DEPTH = 132
export const TERRAIN_REFERENCE_ASPECT = 16 / 9
export const TERRAIN_ULTRAWIDE_MARGIN = 1.25
export const TERRAIN_WIDTH_SNAP = 4
export const TERRAIN_MIN_WIDTH_MARGIN = 5
export const TERRAIN_HORIZON_FADE_START_Z = -48
export const TERRAIN_HORIZON_FADE_END_Z = -66
export const PLUS_FIELD_RADIUS = 11.5
export const PLUS_FIELD_BACK_Z = -80
export const PLUS_FIELD_FRONT_Z = 0
export const PLUS_FIELD_POINTER_X_RANGE = 40
export const PLUS_FIELD_TERRAIN_CLEARANCE = 0.24
export const PLUS_FIELD_RESPONSE = 9
export const PLUS_HEIGHT_RESPONSE = 20
export const TERRAIN_MIN_WIDTH =
  (PLUS_FIELD_POINTER_X_RANGE + PLUS_FIELD_RADIUS + TERRAIN_MIN_WIDTH_MARGIN) * 2
export const PRIMARY_TERRAIN_OFFSET = 0
export const PRIMARY_TERRAIN_Y = -5
export const PRIMARY_TERRAIN_Z = -15
export const PRIMARY_TERRAIN_SCALE = 2
export const SUN_ELEVATION_DEGREES = 5.2
export const SUN_AZIMUTH_DEGREES = -166
export const CELEBRATION_DURATION = 2.8

// Exponential smoothing factor that behaves the same at any frame rate.
export function createFrameLerp(response: number, delta: number) {
  return 1 - Math.exp(-response * delta)
}
