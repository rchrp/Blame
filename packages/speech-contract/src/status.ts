import type { SpeechFailure } from "./failures.js";

/** What Settings and the voice input may know: never the key itself. */
export type SpeechOwnKeyStatus = {
  configured: boolean;
  /** The model Blame transcribes with when the person set none. */
  defaultModel: string;
  /** The last four characters of the saved key. */
  lastFour?: string;
  /** The model the person chose; absent for the default. */
  model?: string;
  /** False where the system keychain cannot protect a key. */
  storageAvailable: boolean;
};

export type SpeechOwnKeyChange =
  { ok: true; status: SpeechOwnKeyStatus } | ({ ok: false } & SpeechFailure);

export type SpeechOwnKeyTest = { ok: true } | ({ ok: false } & SpeechFailure);

export type SpeechOwnKeyTranscription =
  { ok: true; text: string } | ({ ok: false } & SpeechFailure);
