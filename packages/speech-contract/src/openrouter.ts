import type { SpeechTranscriptionFormat } from "./limits.js";

export function openRouterTranscriptionBody(input: {
  data: string;
  format: SpeechTranscriptionFormat;
  model: string;
}) {
  const { data, format, model } = input;
  const body = { input_audio: { data, format }, model, temperature: 0 };
  if (model !== "microsoft/mai-transcribe-2") return body;

  return {
    ...body,
    provider: {
      options: {
        azure: { enhancedMode: { modelOptions: { transcribeStyle: "clean" } } },
      },
    },
  };
}
