import type {
  SpeechOwnKeyChange,
  SpeechOwnKeyStatus,
  SpeechOwnKeyTest,
  SpeechOwnKeyTranscription,
} from "@blame/speech-contract"

/**
 * Desktop: voice input with the person's own OpenRouter key. The desktop
 * keeps the key encrypted and makes the call itself; the app only ever gets
 * the last four characters, and sends the key once, to save it.
 */
export type SpeechOwnKeyClient = {
  status(): Promise<SpeechOwnKeyStatus>
  /** Saves a key, a model or both; an empty model is the default one. */
  save(input: { key?: string; model?: string }): Promise<SpeechOwnKeyChange>
  remove(): Promise<SpeechOwnKeyStatus>
  /** Keeps the OpenRouter key connected in Models, resolved by the desktop. */
  useProviderKey(connection: {
    token?: string | null
    url: string
  }): Promise<SpeechOwnKeyChange>
  /** Checks the saved key and model without a transcription. */
  test(): Promise<SpeechOwnKeyTest>
  transcribe(input: {
    data: string
    format: string
  }): Promise<SpeechOwnKeyTranscription>
}
