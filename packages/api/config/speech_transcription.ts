import env from '#start/env'
import { defaultSpeechTranscriptionModel } from '@blame/speech-contract'

export {
  speechTranscriptionFormats,
  speechTranscriptionMaxAudioBytes,
  speechTranscriptionMaxEncodedChars,
  type SpeechTranscriptionFormat,
} from '@blame/speech-contract'

export type SpeechTranscriptionConfig = ReturnType<typeof speechTranscriptionConfig>

export function speechTranscriptionConfig() {
  const requestsPerMinute = env.get('BLAME_SPEECH_TO_TEXT_REQUESTS_PER_MINUTE') ?? 20
  const maxConcurrentPerUser = env.get('BLAME_SPEECH_TO_TEXT_MAX_CONCURRENT') ?? 2

  if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1) {
    throw new Error('BLAME_SPEECH_TO_TEXT_REQUESTS_PER_MINUTE must be positive')
  }
  if (!Number.isInteger(maxConcurrentPerUser) || maxConcurrentPerUser < 1) {
    throw new Error('BLAME_SPEECH_TO_TEXT_MAX_CONCURRENT must be positive')
  }

  return {
    apiKey: env.get('OPENROUTER_API_KEY')?.release().trim() ?? '',
    maxConcurrentPerUser,
    model: env.get('BLAME_SPEECH_TO_TEXT_MODEL') ?? defaultSpeechTranscriptionModel,
    requestsPerMinute,
    timeoutMs: env.get('BLAME_SPEECH_TO_TEXT_TIMEOUT_MS') ?? 60_000,
  }
}
