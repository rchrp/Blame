export {
  defaultSpeechTranscriptionModel,
  isSpeechTranscriptionFormat,
  openRouterApiBase,
  speechTranscriptionFormats,
  speechTranscriptionMaxAudioBytes,
  speechTranscriptionMaxEncodedChars,
} from "./limits.js";
export type { SpeechTranscriptionFormat } from "./limits.js";
export {
  checkOpenRouterKey,
  checkSpeechModel,
  openRouterKeyLastFour,
} from "./own-key.js";
export type { SpeechInputCheck } from "./own-key.js";
export {
  openRouterErrorMessage,
  openRouterSpeechFailure,
  speechFailure,
  speechFailureNeedsSettings,
} from "./failures.js";
export type { SpeechFailure, SpeechFailureCode } from "./failures.js";
export type {
  SpeechOwnKeyChange,
  SpeechOwnKeyStatus,
  SpeechOwnKeyTest,
  SpeechOwnKeyTranscription,
} from "./status.js";
