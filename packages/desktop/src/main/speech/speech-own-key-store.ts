import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkOpenRouterKey,
  checkSpeechModel,
  defaultSpeechTranscriptionModel,
  openRouterKeyLastFour,
  speechFailure,
  type SpeechOwnKeyChange,
  type SpeechOwnKeyStatus,
} from "@blame/speech-contract";
import type { SecretStorage } from "../local-api/local-api-key.ts";

/** Electron's safeStorage, with the backend Linux reports. */
export type SpeechKeyStorage = SecretStorage & {
  getSelectedStorageBackend?(): string;
};

const keyFile = "openrouter-key.bin";
const settingsFile = "settings.json";

type StoredSettings = { lastFour?: string; model?: string };

/**
 * The person's own OpenRouter key for voice input. It lives on this computer
 * only, encrypted through the system keychain (safeStorage); what the rest
 * of the app may know is the last four characters and the model id.
 */
export class SpeechOwnKeyStore {
  private readonly directory: string;
  private readonly storage: SpeechKeyStorage;

  constructor(directory: string, storage: SpeechKeyStorage) {
    this.directory = directory;
    this.storage = storage;
  }

  async status(): Promise<SpeechOwnKeyStatus> {
    const settings = await this.settings();
    return {
      configured: Boolean(settings.lastFour) && (await this.hasKeyFile()),
      defaultModel: defaultSpeechTranscriptionModel,
      lastFour: settings.lastFour,
      model: settings.model,
      storageAvailable: await this.storageAvailable(),
    };
  }

  /**
   * Saves a key, a model or both. An empty model goes back to the default.
   * Without the keychain nothing is written.
   */
  async save(input: {
    key?: string;
    model?: string;
  }): Promise<SpeechOwnKeyChange> {
    const key =
      input.key === undefined ? undefined : checkOpenRouterKey(input.key);
    if (key && !key.ok) return invalid("invalid-key", key.message);
    const model =
      input.model === undefined ? undefined : checkSpeechModel(input.model);
    if (model && !model.ok) return invalid("model-unavailable", model.message);
    if (key && !(await this.storageAvailable())) {
      return { ok: false, ...speechFailure("keychain-unavailable") };
    }
    if (!key && !(await this.status()).configured && !model) {
      return { ok: false, ...speechFailure("not-configured") };
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const settings = await this.settings();
    if (key) {
      await this.write(
        keyFile,
        await this.storage.encryptStringAsync(key.value),
      );
      settings.lastFour = openRouterKeyLastFour(key.value);
    }
    if (model) settings.model = model.value;
    await this.write(settingsFile, JSON.stringify(settings));
    return { ok: true, status: await this.status() };
  }

  async remove() {
    await rm(join(this.directory, keyFile), { force: true });
    const settings = await this.settings();
    delete settings.lastFour;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.write(settingsFile, JSON.stringify(settings));
    return this.status();
  }

  /** The key and model to call OpenRouter with. Stays in this process. */
  async credentials() {
    const stored = await readFile(join(this.directory, keyFile)).catch(
      () => undefined,
    );
    if (!stored) return undefined;
    try {
      const key = (await this.storage.decryptStringAsync(stored)).result;
      const settings = await this.settings();
      return { key, model: settings.model ?? defaultSpeechTranscriptionModel };
    } catch {
      // The keychain changed under the file: the key must be entered again.
      return undefined;
    }
  }

  private async storageAvailable() {
    if (!(await this.storage.isAsyncEncryptionAvailable())) return false;
    // Linux without a keyring falls back to a plain-text "encryption".
    try {
      const backend = this.storage.getSelectedStorageBackend?.();
      return backend !== "basic_text" && backend !== "unknown";
    } catch {
      return true;
    }
  }

  private async hasKeyFile() {
    return readFile(join(this.directory, keyFile)).then(
      () => true,
      () => false,
    );
  }

  private async settings(): Promise<StoredSettings> {
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.directory, settingsFile), "utf8"),
      );
      if (!value || typeof value !== "object") return {};
      const { lastFour, model } = value as Record<string, unknown>;
      return {
        lastFour: typeof lastFour === "string" ? lastFour : undefined,
        model: typeof model === "string" ? model : undefined,
      };
    } catch {
      return {};
    }
  }

  private async write(name: string, content: string | Buffer) {
    const path = join(this.directory, name);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  }
}

function invalid(
  code: "invalid-key" | "model-unavailable",
  message: string,
): SpeechOwnKeyChange {
  return { ok: false, code, message };
}
