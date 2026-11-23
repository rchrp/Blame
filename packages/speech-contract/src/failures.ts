// How a speech to text call with the person's own OpenRouter key can fail,
// and what to tell them. Each code says whether Settings is the way out.

export type SpeechFailureCode =
  | "forbidden"
  | "invalid-audio"
  | "invalid-key"
  | "keychain-unavailable"
  | "model-unavailable"
  | "no-credits"
  | "not-configured"
  | "offline"
  | "rate-limited"
  | "timeout"
  | "too-large"
  | "unavailable";

export type SpeechFailure = { code: SpeechFailureCode; message: string };

const messages: Record<SpeechFailureCode, string> = {
  forbidden: "OpenRouter refused the request made with your key.",
  "invalid-audio": "The recording could not be read. Try again.",
  "invalid-key": "OpenRouter did not accept your API key.",
  "keychain-unavailable":
    "This computer has no system keychain to protect the key, so Blame does not store it.",
  "model-unavailable": "OpenRouter cannot use this model for transcription.",
  "no-credits": "Your OpenRouter account is out of credits.",
  "not-configured": "No OpenRouter key is saved on this computer.",
  offline: "Blame could not reach OpenRouter. Check your connection.",
  "rate-limited":
    "OpenRouter is limiting requests with this key. Try again in a moment.",
  timeout: "OpenRouter took too long to answer. Try again.",
  "too-large": "This recording is too large to transcribe.",
  unavailable: "OpenRouter is not available right now. Try again later.",
};

export function speechFailure(code: SpeechFailureCode): SpeechFailure {
  return { code, message: messages[code] };
}

// The failures a change in Settings fixes.
const settingsCodes: ReadonlySet<SpeechFailureCode> = new Set([
  "forbidden",
  "invalid-key",
  "model-unavailable",
  "no-credits",
  "not-configured",
]);

export function speechFailureNeedsSettings(code: SpeechFailureCode) {
  return settingsCodes.has(code);
}

/**
 * Reads an OpenRouter error answer. The upstream message only helps tell a
 * wrong model from a wrong recording; it is never shown.
 */
export function openRouterSpeechFailure(input: {
  message?: string;
  status: number;
}): SpeechFailure {
  return speechFailure(openRouterFailureCode(input));
}

function openRouterFailureCode({
  message,
  status,
}: {
  message?: string;
  status: number;
}): SpeechFailureCode {
  if (status === 401) return "invalid-key";
  if (status === 402) return "no-credits";
  if (status === 403) return "forbidden";
  if (status === 404) return "model-unavailable";
  if (status === 400) {
    return message && /\bmodel\b/i.test(message)
      ? "model-unavailable"
      : "invalid-audio";
  }
  if (status === 408 || status === 504 || status === 524) return "timeout";
  if (status === 413) return "too-large";
  if (status === 429) return "rate-limited";
  return "unavailable";
}

/** The message in an OpenRouter error body, whatever its shape. */
export function openRouterErrorMessage(body: unknown) {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}
