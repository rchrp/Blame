import { defaultSpeechTranscriptionModel } from "./limits.js";

// The checks on what the person types in Settings. Light on purpose: they
// catch a pasted URL or a stray space, OpenRouter has the last word.

export type SpeechInputCheck<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const openRouterKeyShape = /^sk-or-[A-Za-z0-9_-]{16,}$/;
const modelIdShape =
  /^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

export function checkOpenRouterKey(input: string): SpeechInputCheck<string> {
  const key = input.trim();
  if (!key) return { ok: false, message: "Paste your OpenRouter API key." };
  if (!openRouterKeyShape.test(key)) {
    return {
      ok: false,
      message:
        "That does not look like an OpenRouter key. They start with sk-or-.",
    };
  }
  return { ok: true, value: key };
}

/** An empty model means the default one: `value` is then undefined. */
export function checkSpeechModel(
  input: string,
): SpeechInputCheck<string | undefined> {
  const model = input.trim();
  if (!model) return { ok: true, value: undefined };
  if (!modelIdShape.test(model)) {
    return {
      ok: false,
      message: `Use the OpenRouter model id, like ${defaultSpeechTranscriptionModel}.`,
    };
  }
  return { ok: true, value: model };
}

export function openRouterKeyLastFour(key: string) {
  return key.slice(-4);
}
