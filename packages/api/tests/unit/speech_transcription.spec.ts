import SpeechTranscriptionRateLimiter from '#services/speech_transcription_rate_limiter'
import SpeechTranscriptionService, {
  SpeechTranscriptionError,
} from '#services/speech_transcription_service'
import type { SpeechTranscriptionConfig } from '#config/speech_transcription'
import { test } from '@japa/runner'

test.group('speech transcription', () => {
  test('limits bursts while allowing concurrent requests below the configured limit', ({
    assert,
  }) => {
    let now = 0
    const limiter = new SpeechTranscriptionRateLimiter(2, 1, () => now)

    const first = limiter.acquire('user-1')
    assert.isNotNull(first)
    assert.isNull(limiter.acquire('user-1'))
    limiter.release(first!)
    assert.isNotNull(limiter.acquire('user-2'))

    now = 60_000
    assert.isNotNull(limiter.acquire('user-1'))
  })

  test('sends base64 audio to OpenRouter and returns its transcription', async ({ assert }) => {
    let requestBody: Record<string, unknown> | undefined
    let requestMethod: string | undefined
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      requestMethod = init?.method
      return jsonResponse({ text: '  Create a story from my voice.  ' })
    }
    const service = new SpeechTranscriptionService(testConfig(), fetcher as typeof fetch)

    const result = await service.transcribe({
      data: Buffer.from('voice').toString('base64'),
      format: 'webm',
    })

    assert.equal(result.text, 'Create a story from my voice.')
    assert.equal(requestMethod, 'POST')
    assert.deepEqual(requestBody, {
      input_audio: { data: Buffer.from('voice').toString('base64'), format: 'webm' },
      model: 'openai/test-transcribe',
      temperature: 0,
    })
  })

  test('requests Azure clean transcription for MAI-Transcribe 2', async ({ assert }) => {
    let requestBody: unknown
    const fetcher: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return jsonResponse({ text: 'Create a story.' })
    }
    const model = 'microsoft/mai-transcribe-2'
    const service = new SpeechTranscriptionService({ ...testConfig(), model }, fetcher)
    const data = Buffer.from('voice').toString('base64')

    const result = await service.transcribe({ data, format: 'wav' })

    assert.deepEqual(result, { text: 'Create a story.' })
    assert.deepEqual(requestBody, {
      input_audio: { data, format: 'wav' },
      model,
      temperature: 0,
      provider: {
        options: {
          azure: { enhancedMode: { modelOptions: { transcribeStyle: 'clean' } } },
        },
      },
    })
  })

  test('rejects malformed audio before calling OpenRouter', async ({ assert }) => {
    let called = false
    const fetcher = async () => {
      called = true
      return jsonResponse({ text: 'unexpected' })
    }
    const service = new SpeechTranscriptionService(testConfig(), fetcher as typeof fetch)

    let error: unknown
    try {
      await service.transcribe({ data: 'not-base64', format: 'webm' })
    } catch (caught) {
      error = caught
    }
    assert.instanceOf(error, SpeechTranscriptionError)
    assert.equal((error as SpeechTranscriptionError).status, 422)
    assert.isFalse(called)
  })

  test('keeps safe upstream diagnostics when OpenRouter rejects the audio', async ({ assert }) => {
    const fetcher = async () =>
      jsonResponse(
        { error: { code: 'invalid_request_error', message: 'unsupported audio format' } },
        400,
        { 'x-request-id': 'openrouter-request-123' }
      )
    const service = new SpeechTranscriptionService(testConfig(), fetcher as typeof fetch)

    let error: unknown
    try {
      await service.transcribe({
        data: Buffer.from('voice').toString('base64'),
        format: 'webm',
      })
    } catch (caught) {
      error = caught
    }

    assert.instanceOf(error, SpeechTranscriptionError)
    assert.equal((error as SpeechTranscriptionError).status, 502)
    assert.deepEqual((error as SpeechTranscriptionError).diagnostics, {
      audioBytes: 5,
      format: 'webm',
      model: 'openai/test-transcribe',
      phase: 'response',
      upstreamError: 'unsupported audio format',
      upstreamGenerationId: undefined,
      upstreamRequestId: 'openrouter-request-123',
      upstreamStatus: 400,
    })
  })
})

function testConfig(): SpeechTranscriptionConfig {
  return {
    apiKey: 'test-key',
    maxConcurrentPerUser: 2,
    model: 'openai/test-transcribe',
    requestsPerMinute: 20,
    timeoutMs: 1_000,
  }
}

function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json', ...headers },
    status,
  })
}
