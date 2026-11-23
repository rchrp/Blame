// What speech to text accepts, wherever it runs: Blame's hosted API and the
// desktop's own OpenRouter key share these, so the two never drift.

export const speechTranscriptionFormats = [
  "aac",
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "ogg",
  "wav",
  "webm",
] as const;

export type SpeechTranscriptionFormat =
  (typeof speechTranscriptionFormats)[number];

export const speechTranscriptionMaxAudioBytes = 12_000_000;
export const speechTranscriptionMaxEncodedChars = 16_000_000;

/** The model Blame transcribes with unless the person picks another. */
export const defaultSpeechTranscriptionModel = "openai/gpt-transcribe";

export const openRouterApiBase = "https://openrouter.ai/api/v1";

export function isSpeechTranscriptionFormat(
  value: unknown,
): value is SpeechTranscriptionFormat {
  return (
    typeof value === "string" &&
    (speechTranscriptionFormats as readonly string[]).includes(value)
  );
}
