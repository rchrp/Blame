import {
  isSpeechTranscriptionFormat,
  openRouterApiBase,
  openRouterErrorMessage,
  openRouterSpeechFailure,
  speechFailure,
  speechTranscriptionMaxAudioBytes,
  speechTranscriptionMaxEncodedChars,
  type SpeechOwnKeyTest,
  type SpeechOwnKeyTranscription,
} from "@blame/speech-contract";

// Speech to text with the person's own OpenRouter key, called from this
// computer: the audio never goes through Blame. The request has the shape the
// hosted API sends (packages/api/app/services/speech_transcription_service.ts).

export type OpenRouterSpeechOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const transcriptionTimeoutMs = 60_000;
const checkTimeoutMs = 15_000;
const siteUrl = "https://blame.dev";

/**
 * OpenRouter's API address. A test server on this computer may stand in for
 * it (BLAME_OPENROUTER_BASE_URL); no other address is ever used, so the key
 * cannot be sent anywhere else by the environment.
 */
export function openRouterBaseUrl(
  environment: Record<string, string | undefined> = process.env,
) {
  const override = environment.BLAME_OPENROUTER_BASE_URL?.trim();
  if (!override) return openRouterApiBase;
  try {
    const url = new URL(override);
    const local =
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.hostname.endsWith(".localhost");
    if (local && (url.protocol === "http:" || url.protocol === "https:")) {
      return override.replace(/\/$/, "");
    }
  } catch {
    // Not an address: the real one stays.
  }
  return openRouterApiBase;
}

export async function transcribeWithOpenRouter(
  input: { data: string; format: string; key: string; model: string },
  options: OpenRouterSpeechOptions = {},
): Promise<SpeechOwnKeyTranscription> {
  const audio = checkAudio(input.data, input.format);
  if (audio) return { ok: false, ...audio };
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `${options.baseUrl ?? openRouterBaseUrl()}/audio/transcriptions`,
      {
        body: JSON.stringify({
          input_audio: { data: input.data, format: input.format },
          model: input.model,
          temperature: 0,
        }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": siteUrl,
          "X-OpenRouter-Title": "Blame",
        },
        method: "POST",
        signal: AbortSignal.timeout(
          options.timeoutMs ?? transcriptionTimeoutMs,
        ),
      },
    );
  } catch (error) {
    return { ok: false, ...requestFailure(error) };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      ...openRouterSpeechFailure({
        message: openRouterErrorMessage(body),
        status: response.status,
      }),
    };
  }
  const text = transcriptionText(body);
  if (text === undefined) return { ok: false, ...speechFailure("unavailable") };
  return { ok: true, text };
}

/**
 * Checks the key and the model without a transcription, so nothing is
 * billed: the key's own record, then OpenRouter's list of transcription
 * models. A list that cannot be read does not fail the check.
 */
export async function testOpenRouterKey(
  input: { key: string; model: string },
  options: OpenRouterSpeechOptions = {},
): Promise<SpeechOwnKeyTest> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.baseUrl ?? openRouterBaseUrl();
  const get = (path: string) =>
    fetcher(`${base}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.key}`,
        "HTTP-Referer": siteUrl,
        "X-OpenRouter-Title": "Blame",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? checkTimeoutMs),
    });
  let keyResponse: Response;
  try {
    keyResponse = await get("/key");
  } catch (error) {
    return { ok: false, ...requestFailure(error) };
  }
  const keyBody: unknown = await keyResponse.json().catch(() => null);
  if (!keyResponse.ok) {
    return {
      ok: false,
      ...openRouterSpeechFailure({
        message: openRouterErrorMessage(keyBody),
        status: keyResponse.status,
      }),
    };
  }
  if (keyLimitReached(keyBody)) {
    return { ok: false, ...speechFailure("no-credits") };
  }
  const models = await get("/models?output_modalities=transcription")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const ids = modelIds(models);
  if (ids && !ids.includes(input.model)) {
    return { ok: false, ...speechFailure("model-unavailable") };
  }
  return { ok: true };
}

function checkAudio(data: string, format: string) {
  if (!isSpeechTranscriptionFormat(format)) {
    return speechFailure("invalid-audio");
  }
  if (!data || data.length > speechTranscriptionMaxEncodedChars) {
    return speechFailure(data ? "too-large" : "invalid-audio");
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  ) {
    return speechFailure("invalid-audio");
  }
  const bytes = Math.floor((data.length * 3) / 4);
  return bytes > speechTranscriptionMaxAudioBytes
    ? speechFailure("too-large")
    : undefined;
}

function requestFailure(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  return speechFailure(
    name === "TimeoutError" || name === "AbortError" ? "timeout" : "offline",
  );
}

function transcriptionText(value: unknown) {
  if (!value || typeof value !== "object" || !("text" in value))
    return undefined;
  return typeof value.text === "string" ? value.text.trim() : undefined;
}

// A key capped at an amount that is used up; null or absent means no cap.
function keyLimitReached(value: unknown) {
  const data = (value as { data?: { limit_remaining?: unknown } } | null)?.data;
  return typeof data?.limit_remaining === "number" && data.limit_remaining <= 0;
}

function modelIds(value: unknown) {
  const data = (value as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  return data.flatMap((model) =>
    model &&
    typeof model === "object" &&
    typeof (model as { id?: unknown }).id === "string"
      ? [(model as { id: string }).id]
      : [],
  );
}
