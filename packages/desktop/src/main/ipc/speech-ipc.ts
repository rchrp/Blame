import { ipcMain, type WebContents } from "electron";
import {
  speechFailure,
  type SpeechOwnKeyChange,
  type SpeechOwnKeyTest,
  type SpeechOwnKeyTranscription,
} from "@blame/speech-contract";
import {
  testOpenRouterKey,
  transcribeWithOpenRouter,
  type OpenRouterSpeechOptions,
} from "../speech/openrouter-speech.ts";
import { resolveOpenRouterProviderKey } from "../speech/provider-key.ts";
import type { SpeechOwnKeyStore } from "../speech/speech-own-key-store.ts";

/**
 * Voice input with the person's own OpenRouter key. The key is written by
 * `speech-key:save` and read only here, in the main process: nothing the
 * renderer can call returns it.
 */
export function registerSpeechIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
  options?: OpenRouterSpeechOptions;
  store: SpeechOwnKeyStore;
}) {
  const owner = (event: Electron.IpcMainInvokeEvent) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Speech request was rejected");
  };

  ipcMain.handle("speech-key:status", (event) => {
    owner(event);
    return input.store.status();
  });
  ipcMain.handle(
    "speech-key:save",
    (event, value: unknown): Promise<SpeechOwnKeyChange> => {
      owner(event);
      const body = record(value);
      return input.store.save({
        key: typeof body.key === "string" ? body.key : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
      });
    },
  );
  ipcMain.handle("speech-key:remove", (event) => {
    owner(event);
    return input.store.remove();
  });
  ipcMain.handle(
    "speech-key:use-provider-key",
    async (event, value: unknown): Promise<SpeechOwnKeyChange> => {
      owner(event);
      const body = record(value);
      if (typeof body.url !== "string" || !body.url)
        return { ok: false, ...speechFailure("not-configured") };
      const key = await resolveOpenRouterProviderKey({
        token: typeof body.token === "string" ? body.token : undefined,
        url: body.url,
      });
      if (!key) return { ok: false, ...speechFailure("not-configured") };
      return input.store.save({ key });
    },
  );
  ipcMain.handle(
    "speech-key:test",
    async (event): Promise<SpeechOwnKeyTest> => {
      owner(event);
      const credentials = await input.store.credentials();
      if (!credentials)
        return { ok: false, ...speechFailure("not-configured") };
      return testOpenRouterKey(credentials, input.options);
    },
  );
  ipcMain.handle(
    "speech-key:transcribe",
    async (event, value: unknown): Promise<SpeechOwnKeyTranscription> => {
      owner(event);
      const body = record(value);
      const credentials = await input.store.credentials();
      if (!credentials)
        return { ok: false, ...speechFailure("not-configured") };
      return transcribeWithOpenRouter(
        {
          ...credentials,
          data: typeof body.data === "string" ? body.data : "",
          format: typeof body.format === "string" ? body.format : "",
        },
        input.options,
      );
    },
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
