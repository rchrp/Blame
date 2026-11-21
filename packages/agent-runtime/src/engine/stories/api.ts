// What the story service reads and writes in the account's API: the
// stories, their project's preview environment and code practices, and
// the files attached to them.

import { apiRequest } from "../../cloud-api.js";
import type {
  ApiConnection,
  PreviewManifest,
  ProjectCodePracticePreference,
  ProjectRunConfiguration,
} from "../../types.js";
import { parseStory, type HostStory, type StoryUpdate } from "./story.js";

/** The project's saved preview environment, as the API keeps it. */
export type ProjectInitialization = {
  status: string;
  previewManifest: PreviewManifest | null;
  runConfigurations: ProjectRunConfiguration[];
  databaseMode?: string | null;
  createdAt: string;
  updatedAt: string | null;
};

export type ProjectInitializationSnapshot = {
  initialization: ProjectInitialization | null;
  practices: ProjectCodePracticePreference[];
};

/** A story as the API keeps it, with its payload as the API sent it. */
export type StoryRecord = { story: HostStory; payload: unknown };

export function storyApi(connection: ApiConnection) {
  const record = (payload: unknown): StoryRecord => ({
    story: parseStory(payload),
    payload,
  });
  return {
    async list(projectId: string): Promise<StoryRecord[]> {
      const query = new URLSearchParams({ projectId, view: "summary" });
      const value = await apiRequest<unknown>(
        connection,
        `/projects/user-stories?${query}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      return (Array.isArray(value) ? value : []).map(record);
    },
    async get(id: string): Promise<StoryRecord> {
      return record(
        await apiRequest<unknown>(
          connection,
          `/projects/user-stories/${encodeURIComponent(id)}`,
          { signal: AbortSignal.timeout(15_000) },
        ),
      );
    },
    async update(id: string, input: StoryUpdate): Promise<StoryRecord> {
      return record(
        await apiRequest<unknown>(
          connection,
          `/projects/user-stories/${encodeURIComponent(id)}`,
          {
            body: JSON.stringify(boundedUpdate(input)),
            method: "PATCH",
            signal: AbortSignal.timeout(15_000),
          },
        ),
      );
    },
    async create(input: Record<string, unknown>): Promise<StoryRecord> {
      return record(
        await apiRequest<unknown>(connection, "/projects/user-stories", {
          body: JSON.stringify(input),
          method: "POST",
          signal: AbortSignal.timeout(15_000),
        }),
      );
    },
    async delete(id: string) {
      await apiRequest<void>(
        connection,
        `/projects/user-stories/${encodeURIComponent(id)}`,
        { method: "DELETE", signal: AbortSignal.timeout(15_000) },
      );
    },
    async initialization(
      projectId: string,
    ): Promise<ProjectInitializationSnapshot> {
      const value = await apiRequest<Partial<ProjectInitializationSnapshot>>(
        connection,
        `/projects/${encodeURIComponent(projectId)}/initialization`,
        { signal: AbortSignal.timeout(15_000) },
      );
      return {
        initialization: value?.initialization ?? null,
        practices: Array.isArray(value?.practices) ? value.practices : [],
      };
    },
    /** An attached file's bytes, base64-encoded, for the agent. */
    async attachment(id: string, name: string): Promise<string | undefined> {
      const stored = await apiRequest<{ downloadUrl?: string }>(
        connection,
        `/attachments/${encodeURIComponent(id)}`,
        { method: "GET", signal: AbortSignal.timeout(15_000) },
      );
      const url = stored?.downloadUrl;
      if (!url) return undefined;
      const sameApi = url.startsWith(
        connection.url.replace(/\/api\/v1\/?$/, ""),
      );
      const response = await fetch(url, {
        headers:
          sameApi && connection.token
            ? { Authorization: `Bearer ${connection.token}` }
            : {},
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new Error(`${name} could not be read (${response.status}).`);
      return Buffer.from(await response.arrayBuffer()).toString("base64");
    },
  };
}

export type StoryApi = ReturnType<typeof storyApi>;

// The API keeps up to this much of the agent's last error; a provider's
// message can be longer, and the story's state must still be written.
const agentLastErrorLimit = 4096;

function boundedUpdate(input: StoryUpdate): StoryUpdate {
  const error = input.agentLastError;
  if (!error || error.length <= agentLastErrorLimit) return input;
  return {
    ...input,
    agentLastError: `${error.slice(0, agentLastErrorLimit - 1)}…`,
  };
}
