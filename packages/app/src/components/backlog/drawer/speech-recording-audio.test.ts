import assert from "node:assert/strict"
import test from "node:test"
import {
  speechTranscriptionMaxAudioBytes,
  speechTranscriptionMaxEncodedChars,
} from "@blame/speech-contract"
import {
  encodeSpeechWav,
  maxRecordingDurationMs,
  speechSampleRate,
} from "./speech-recording-audio.ts"

test("speech audio is encoded as mono 16-bit PCM WAV at the decoded sample rate", () => {
  const channels = [
    Float32Array.of(0, 0.75, -0.75, 1.5, -1.5),
    Float32Array.of(0, 0.25, -0.25, 1, -1),
  ]
  const wav = Buffer.from(encodeSpeechWav(channels, 16_000))

  assert.equal(wav.toString("ascii", 0, 4), "RIFF")
  assert.equal(wav.readUInt32LE(4), wav.length - 8)
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ")
  assert.equal(wav.readUInt32LE(16), 16)
  assert.equal(wav.readUInt16LE(20), 1)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 16_000)
  assert.equal(wav.readUInt32LE(28), 32_000)
  assert.equal(wav.readUInt16LE(32), 2)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.toString("ascii", 36, 40), "data")
  assert.equal(wav.readUInt32LE(40), wav.length - 44)
  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => wav.readInt16LE(44 + index * 2)),
    [0, 16_384, -16_384, 32_767, -32_768]
  )
})

test("a full five-minute dictation fits the shared transcription size limits", () => {
  assert.equal(maxRecordingDurationMs, 300_000)
  const samples = new Float32Array(
    (maxRecordingDurationMs / 1_000) * speechSampleRate
  )
  const wav = Buffer.from(encodeSpeechWav([samples], speechSampleRate))

  assert.ok(wav.byteLength <= speechTranscriptionMaxAudioBytes)
  assert.ok(wav.toString("base64").length <= speechTranscriptionMaxEncodedChars)
})
