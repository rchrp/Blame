import {
  speechTranscriptionConfig,
  speechTranscriptionMaxAudioBytes,
  type SpeechTranscriptionFormat,
  type SpeechTranscriptionConfig,
} from '#config/speech_transcription'
import { openRouterTranscriptionBody } from '@blame/speech-contract'

type SpeechTranscriptionInput = {
  data: string
  format: SpeechTranscriptionFormat
}

export type SpeechTranscriptionDiagnostics = {
  audioBytes: number
  cause?: string
  format: SpeechTranscriptionFormat
  model: string
  phase: 'request' | 'response'
  upstreamError?: string
  upstreamGenerationId?: string
  upstreamRequestId?: string
  upstreamStatus?: number
}

export class SpeechTranscriptionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly diagnostics?: SpeechTranscriptionDiagnostics
  ) {
    super(message)
    this.name = 'SpeechTranscriptionError'
  }
}

export default class SpeechTranscriptionService {
  constructor(
    private readonly config: SpeechTranscriptionConfig = speechTranscriptionConfig(),
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async transcribe(input: SpeechTranscriptionInput) {
    if (!this.config.apiKey) {
      throw new SpeechTranscriptionError('Speech transcription is not configured.', 503)
    }

    const audio = decodeAudio(input.data)
    if (audio.byteLength > speechTranscriptionMaxAudioBytes) {
      throw new SpeechTranscriptionError('Audio recording is too large.', 413)
    }

    const diagnostics = {
      audioBytes: audio.byteLength,
      format: input.format,
      model: this.config.model,
    }

    let response: Response
    try {
      response = await this.fetcher('https://openrouter.ai/api/v1/audio/transcriptions', {
        body: JSON.stringify(openRouterTranscriptionBody({ ...input, model: this.config.model })),
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': envSiteUrl(),
          'X-OpenRouter-Title': 'Blame',
        },
        method: 'POST',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (error) {
      throw new SpeechTranscriptionError('Speech transcription is temporarily unavailable.', 503, {
        ...diagnostics,
        cause: errorMessage(error),
        phase: 'request',
      })
    }

    const body = await response.json().catch(() => null)
    if (!response.ok) {
      throw new SpeechTranscriptionError(
        response.status === 429
          ? 'Speech transcription is temporarily busy.'
          : 'Speech transcription is temporarily unavailable.',
        response.status === 429 ? 503 : 502,
        {
          ...diagnostics,
          phase: 'response',
          upstreamError: upstreamError(body),
          upstreamGenerationId: response.headers.get('x-generation-id') ?? undefined,
          upstreamRequestId: response.headers.get('x-request-id') ?? undefined,
          upstreamStatus: response.status,
        }
      )
    }

    const text = transcriptionText(body)
    if (text === undefined) {
      throw new SpeechTranscriptionError(
        'Speech transcription returned an invalid response.',
        502,
        {
          ...diagnostics,
          phase: 'response',
          upstreamGenerationId: response.headers.get('x-generation-id') ?? undefined,
          upstreamRequestId: response.headers.get('x-request-id') ?? undefined,
          upstreamStatus: response.status,
        }
      )
    }
    return { text }
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function upstreamError(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const error = 'error' in value ? value.error : undefined
  if (typeof error === 'string') return truncate(error)
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return truncate(error.message)
  }
  if ('message' in value && typeof value.message === 'string') return truncate(value.message)
  return undefined
}

function truncate(value: string) {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value
}

function decodeAudio(data: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new SpeechTranscriptionError('Audio recording is invalid.', 422)
  }
  const audio = Buffer.from(data, 'base64')
  if (audio.byteLength === 0) throw new SpeechTranscriptionError('Audio recording is empty.', 422)
  return audio
}

function transcriptionText(value: unknown) {
  if (!value || typeof value !== 'object' || !('text' in value)) return undefined
  const text = value.text
  return typeof text === 'string' ? text.trim() : undefined
}

function envSiteUrl() {
  return process.env.BLAME_SITE_URL ?? 'https://blame.dev'
}
