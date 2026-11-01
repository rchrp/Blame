// Value noise for the terrain's relief: smooth, deterministic and the same
// on every machine.

export function fbm2(x: number, y: number, octaves: number) {
  let value = 0
  let amplitude = 0.5
  let frequency = 1
  let amplitudeTotal = 0

  for (let octave = 0; octave < octaves; octave += 1) {
    value += valueNoise2(x * frequency, y * frequency) * amplitude
    amplitudeTotal += amplitude
    frequency *= 2.03
    amplitude *= 0.52
  }

  return value / amplitudeTotal
}

function valueNoise2(x: number, y: number) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const xFade = smoothNoiseFraction(x - x0)
  const yFade = smoothNoiseFraction(y - y0)
  const bottomLeft = hashNoise2(x0, y0)
  const bottomRight = hashNoise2(x0 + 1, y0)
  const topLeft = hashNoise2(x0, y0 + 1)
  const topRight = hashNoise2(x0 + 1, y0 + 1)
  const bottom = lerp(bottomLeft, bottomRight, xFade)
  const top = lerp(topLeft, topRight, xFade)

  return lerp(bottom, top, yFade)
}

// Same formula as THREE.MathUtils.lerp, kept local so the hot loop avoids the
// property lookups.
function lerp(from: number, to: number, amount: number) {
  return (1 - amount) * from + amount * to
}

function smoothNoiseFraction(value: number) {
  return value * value * value * (value * (value * 6 - 15) + 10)
}

export function hashNoise2(x: number, y: number) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return value - Math.floor(value)
}
