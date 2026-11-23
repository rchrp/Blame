import type {
  DeviceCredential,
  DeviceCredentialInput,
  ProviderCredentialSummary,
} from "@blame/agent-runtime";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SecretStorage } from "../local-api/local-api-key.ts";

/** Electron's safeStorage, with the backend Linux reports. */
export type DeviceKeyStorage = SecretStorage & {
  getSelectedStorageBackend?(): string;
};

type StoredCredential = {
  id: string;
  providerId: string;
  label: string;
  authMethod: "api-key" | "oauth";
  baseUrl: string | null;
  modelIds?: string[];
  accountId?: string | null;
  expiresAt?: string | null;
  lastFour?: string;
  createdAt: string;
  updatedAt: string | null;
};

type Secrets = { apiKey: string; oauthCredentials?: unknown };

const indexFile = "credentials.json";
const defaultLabel = "default";

/**
 * Provider credentials that stay on this computer: never sent to the API,
 * answered to the engine without it. Each secret is its own file, encrypted by
 * the system keychain (Electron's safeStorage); the index next to them holds
 * what the UI may show (provider, label, address, the last four characters
 * of a key) and nothing secret.
 */
export class DeviceCredentialStore {
  private readonly directory: string;
  private readonly storage: DeviceKeyStorage;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, storage: DeviceKeyStorage) {
    this.directory = directory;
    this.storage = storage;
  }

  /** Whether a credential can be kept safely here (a keychain exists). */
  async available() {
    if (!(await this.storage.isAsyncEncryptionAvailable())) return false;
    // Linux without a keyring falls back to a plain-text "encryption".
    try {
      const backend = this.storage.getSelectedStorageBackend?.();
      return backend !== "basic_text" && backend !== "unknown";
    } catch {
      return true;
    }
  }

  async list(): Promise<ProviderCredentialSummary[]> {
    return (await this.index()).map(summary);
  }

  /** The credential with its secrets, for the engine host; never for the UI. */
  async resolve(input: {
    providerId: string;
    label?: string;
  }): Promise<DeviceCredential | null> {
    const label = input.label ?? defaultLabel;
    const entry = (await this.index()).find(
      (candidate) =>
        candidate.providerId === input.providerId && candidate.label === label,
    );
    if (!entry) return null;
    const secrets = await this.secrets(entry.id);
    // The keychain changed under the file: the key has to be entered again.
    if (!secrets) return null;
    return {
      id: entry.id,
      providerId: entry.providerId,
      label: entry.label,
      authMethod: entry.authMethod,
      apiKey: secrets.apiKey,
      baseUrl: entry.baseUrl,
      ...(entry.modelIds ? { modelIds: entry.modelIds } : {}),
      oauthCredentials: (secrets.oauthCredentials ??
        null) as DeviceCredential["oauthCredentials"],
    };
  }

  /** Saves or replaces the credential of that provider and label. */
  save(input: DeviceCredentialInput): Promise<ProviderCredentialSummary> {
    return this.serialized(async () => {
      if (!(await this.available())) {
        throw new Error(
          "The system keychain is unavailable: Blame cannot keep this credential on this computer.",
        );
      }
      const label = input.label?.trim() || defaultLabel;
      const apiKey = input.apiKey;
      if (typeof apiKey !== "string" || (!apiKey && !input.oauthCredentials))
        throw new Error("A credential needs a key.");
      const entries = await this.index();
      const existing = entries.find(
        (entry) =>
          entry.providerId === input.providerId && entry.label === label,
      );
      const now = new Date().toISOString();
      const oauth = input.oauthCredentials;
      const entry: StoredCredential = {
        id: existing?.id ?? `device-${randomUUID()}`,
        providerId: input.providerId,
        label,
        authMethod: oauth ? "oauth" : "api-key",
        baseUrl: input.baseUrl ?? null,
        ...(input.modelIds ? { modelIds: input.modelIds } : {}),
        ...(oauth
          ? {
              accountId: oauth.accountId ?? oauth.email ?? null,
              expiresAt: new Date(oauth.expires).toISOString(),
            }
          : { lastFour: apiKey.slice(-4) }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing ? now : null,
      };
      const secrets: Secrets = { apiKey, oauthCredentials: oauth };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.write(
        `${entry.id}.bin`,
        await this.storage.encryptStringAsync(JSON.stringify(secrets)),
      );
      await this.write(
        indexFile,
        JSON.stringify({
          credentials: [
            ...entries.filter((item) => item.id !== entry.id),
            entry,
          ],
        }),
      );
      return summary(entry);
    });
  }

  remove(id: string): Promise<void> {
    return this.serialized(async () => {
      const entries = await this.index();
      if (!entries.some((entry) => entry.id === id)) return;
      await this.write(
        indexFile,
        JSON.stringify({
          credentials: entries.filter((entry) => entry.id !== id),
        }),
      );
      await rm(join(this.directory, `${safeName(id)}.bin`), { force: true });
    });
  }

  private async secrets(id: string): Promise<Secrets | undefined> {
    const stored = await readFile(
      join(this.directory, `${safeName(id)}.bin`),
    ).catch(() => undefined);
    if (!stored) return undefined;
    try {
      const value: unknown = JSON.parse(
        (await this.storage.decryptStringAsync(stored)).result,
      );
      return value && typeof (value as Secrets).apiKey === "string"
        ? (value as Secrets)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async index(): Promise<StoredCredential[]> {
    let text: string;
    try {
      text = await readFile(join(this.directory, indexFile), "utf8");
    } catch (error) {
      // No file yet is an empty store; any other failure must not look like
      // one, or the next save would write an index that forgets the rest.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const value: unknown = JSON.parse(text);
    const list = (value as { credentials?: unknown } | null)?.credentials;
    return Array.isArray(list)
      ? list.filter(
          (entry): entry is StoredCredential =>
            Boolean(entry) &&
            typeof (entry as StoredCredential).id === "string" &&
            typeof (entry as StoredCredential).providerId === "string",
        )
      : [];
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async write(name: string, content: string | Buffer) {
    const path = join(this.directory, name);
    const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }
}

function summary(entry: StoredCredential): ProviderCredentialSummary {
  return {
    id: entry.id,
    userId: "device",
    providerId: entry.providerId,
    label: entry.label,
    authMethod: entry.authMethod,
    baseUrl: entry.baseUrl,
    ...(entry.modelIds ? { modelIds: entry.modelIds } : {}),
    accountId: entry.accountId ?? null,
    expiresAt: entry.expiresAt ?? null,
    storage: "device",
    ...(entry.lastFour ? { lastFour: entry.lastFour } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** An id from a caller never reaches outside the store's folder. */
function safeName(id: string) {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}
