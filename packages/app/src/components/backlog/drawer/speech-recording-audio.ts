export const maxRecordingDurationMs = 5 * 60_000
// Five minutes of 16-bit mono PCM at this rate fit the transcription size limits.
export const speechSampleRate = 16_000

export async function recordingToSpeechInput(recording: Blob) {
  // MAI-Transcribe 2 rejects WebM recordings, so send PCM WAV.
  let audio: AudioBuffer
  try {
    const decoder = new OfflineAudioContext(1, 1, speechSampleRate)
    audio = await decoder.decodeAudioData(await recording.arrayBuffer())
  } catch {
    throw new Error("Unable to read the voice recording.")
  }

  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
    audio.getChannelData(index)
  )
  const wav = encodeSpeechWav(channels, audio.sampleRate)
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("Unable to read the recording."))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.readAsDataURL(new Blob([wav], { type: "audio/wav" }))
  })
  return { data, format: "wav" as const }
}

export function encodeSpeechWav(
  channels: readonly Float32Array[],
  sampleRate: number
) {
  const headerBytes = 44
  const bytesPerSample = 2
  const sampleCount = channels[0].length
  const audioBytes = sampleCount * bytesPerSample
  const buffer = new ArrayBuffer(headerBytes + audioBytes)
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const encoder = new TextEncoder()

  bytes.set(encoder.encode("RIFF"), 0)
  view.setUint32(4, buffer.byteLength - 8, true)
  bytes.set(encoder.encode("WAVEfmt "), 8)
  view.setUint32(16, 16, true) // PCM format chunk size
  view.setUint16(20, 1, true) // PCM encoding
  view.setUint16(22, 1, true) // Mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  bytes.set(encoder.encode("data"), 36)
  view.setUint32(40, audioBytes, true)

  for (let index = 0; index < sampleCount; index++) {
    let sum = 0
    for (const channel of channels) sum += channel[index]
    const sample = Math.max(-1, Math.min(1, sum / channels.length))
    const value = Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff))
    view.setInt16(headerBytes + index * bytesPerSample, value, true)
  }

  return buffer
}
