import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  PreviewVariableRequest,
  PreviewVariableScope,
} from "@blame/agent-runtime";
import type { StoredVariable } from "./environment-resolver.ts";

// Preview variables people set in the Variables tab: per project (every
// story) or per story. Values are encrypted one by one with a key the system
// keychain protects (Electron's safeStorage); key names stay readable, and
// so do the variables the development agent asked for, which have none.

/** The parts of Electron's safeStorage the store needs. */
export type SecretStorage = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string }>;
};

type StoredEntry = {
  key: string;
  serviceId?: string;
  /** Base64 of the value encrypted by the keychain-protected key. */
  value: string;
  updatedAt: string;
};

type StoreFile = {
  version: 1;
  projects: Record<string, StoredEntry[]>;
  stories: Record<
    string,
    { variables: StoredEntry[]; requests: PreviewVariableRequest[] }
  >;
};

const variableKey = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export class PreviewVariablesStore {
  private readonly file: string;
  private readonly secrets: SecretStorage;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, secrets: SecretStorage) {
    this.file = file;
    this.secrets = secrets;
  }

  encrypted() {
    return this.secrets.isAsyncEncryptionAvailable().catch(() => false);
  }

  async variables(
    scope: PreviewVariableScope,
    owner: string,
  ): Promise<StoredVariable[]> {
    const content = await this.read();
    const entries =
      scope === "project"
        ? (content.projects[owner] ?? [])
        : (content.stories[owner]?.variables ?? []);
    return Promise.all(
      entries.map(async (entry) => ({
        key: entry.key,
        ...(entry.serviceId ? { serviceId: entry.serviceId } : {}),
        value: (
          await this.secrets.decryptStringAsync(
            Buffer.from(entry.value, "base64"),
          )
        ).result,
      })),
    );
  }

  /** Sets a variable, or removes it when `value` is undefined. */
  set(
    scope: PreviewVariableScope,
    owner: string,
    variable: { key: string; value?: string; serviceId?: string },
  ) {
    if (!variableKey.test(variable.key))
      return Promise.reject(invalidName(variable.key));
    return this.update(async (content) => {
      const current =
        scope === "project"
          ? (content.projects[owner] ?? [])
          : (content.stories[owner]?.variables ?? []);
      const rest = current.filter(
        (entry) =>
          entry.key !== variable.key ||
          (entry.serviceId ?? "") !== (variable.serviceId ?? ""),
      );
      const next =
        variable.value === undefined
          ? rest
          : [
              ...rest,
              {
                key: variable.key,
                ...(variable.serviceId
                  ? { serviceId: variable.serviceId }
                  : {}),
                value: await this.encrypt(variable.value),
                updatedAt: new Date().toISOString(),
              },
            ];
      if (scope === "project") content.projects[owner] = next;
      else {
        const story = storyEntry(content, owner);
        story.variables = next;
        if (variable.value !== undefined)
          story.requests = story.requests.filter(
            ({ key }) => key !== variable.key,
          );
      }
    });
  }

  async requests(story: string) {
    return (await this.read()).stories[story]?.requests ?? [];
  }

  /** Records a variable the development agent needs; one per key. */
  request(story: string, request: Omit<PreviewVariableRequest, "requestedAt">) {
    if (!variableKey.test(request.key))
      return Promise.reject(invalidName(request.key));
    return this.update((content) => {
      const entry = storyEntry(content, story);
      entry.requests = [
        ...entry.requests.filter(({ key }) => key !== request.key),
        {
          key: request.key,
          reason: request.reason.slice(0, 500),
          ...(request.serviceId ? { serviceId: request.serviceId } : {}),
          requestedAt: new Date().toISOString(),
        },
      ];
    });
  }

  dismissRequest(story: string, key: string) {
    return this.update((content) => {
      const entry = storyEntry(content, story);
      entry.requests = entry.requests.filter((request) => request.key !== key);
    });
  }

  /** Forgets a story's overrides and requests, once its worktree is gone. */
  forgetStory(story: string) {
    return this.update((content) => {
      delete content.stories[story];
    });
  }

  private async encrypt(value: string) {
    if (!(await this.encrypted()))
      throw new Error(
        "The system keychain is unavailable: Blame cannot store preview variables safely.",
      );
    return (await this.secrets.encryptStringAsync(value)).toString("base64");
  }

  private update(change: (content: StoreFile) => void | Promise<void>) {
    const next = this.queue.then(async () => {
      const content = await this.read();
      await change(content);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, this.file);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as StoreFile;
      return {
        version: 1,
        projects: parsed.projects ?? {},
        stories: parsed.stories ?? {},
      };
    } catch {
      return { version: 1, projects: {}, stories: {} };
    }
  }
}

function invalidName(key: string) {
  return new Error(`"${key}" is not a valid variable name.`);
}

function storyEntry(content: StoreFile, story: string) {
  content.stories[story] ??= { variables: [], requests: [] };
  return content.stories[story]!;
}

let store: PreviewVariablesStore | undefined;

/** Called once the app is ready, with the user data folder's file. */
export function configurePreviewVariables(
  file: string,
  secrets: SecretStorage,
) {
  store = new PreviewVariablesStore(file, secrets);
}

export function previewVariablesStore() {
  return store;
}

/** A removed story's overrides and requests go with it. */
export function forgetStoryVariables(worktree: string) {
  return store?.forgetStory(worktree).catch(() => undefined);
}
