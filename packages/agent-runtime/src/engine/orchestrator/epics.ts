// What the orchestrator reads and writes of an epic in the account's API
// (`/projects/epics`). The screen creates the epic and writes its settings
// and status; the host writes its branches and its conversation's session.

import { apiRequest } from "../../cloud-api.js";
import type { ApiConnection } from "../../types.js";
import type { Epic, EpicSettings, EpicStatus } from "../protocol.js";

const statuses = new Set<EpicStatus>([
  "active",
  "paused",
  "completed",
  "discarded",
]);

export function parseEpic(value: unknown): Epic {
  const epic = value as Partial<Epic> | undefined;
  if (
    !epic ||
    typeof epic !== "object" ||
    typeof epic.id !== "string" ||
    typeof epic.projectId !== "string"
  )
    throw new Error("Unable to read the epic.");
  const text = (field: unknown) =>
    typeof field === "string" && field ? field : null;
  return {
    id: epic.id,
    projectId: epic.projectId,
    title: typeof epic.title === "string" ? epic.title : "Epic",
    goal: text(epic.goal),
    // A status this build does not know is never taken as free to run.
    status: statuses.has(epic.status as EpicStatus)
      ? (epic.status as EpicStatus)
      : "paused",
    branch: text(epic.branch),
    targetBranch: text(epic.targetBranch),
    engineSessionId: text(epic.engineSessionId),
    settings:
      epic.settings && typeof epic.settings === "object"
        ? (epic.settings as EpicSettings)
        : {},
    mergedAt: text(epic.mergedAt),
    mergeCommit: text(epic.mergeCommit),
  };
}

export type EpicUpdate = Partial<
  Pick<
    Epic,
    | "branch"
    | "targetBranch"
    | "engineSessionId"
    | "status"
    | "mergedAt"
    | "mergeCommit"
    | "settings"
  >
>;

export function epicApi(connection: ApiConnection) {
  const timeout = () => AbortSignal.timeout(15_000);
  return {
    async get(id: string): Promise<Epic> {
      return parseEpic(
        await apiRequest<unknown>(
          connection,
          `/projects/epics/${encodeURIComponent(id)}`,
          { signal: timeout() },
        ),
      );
    },
    async list(projectId: string): Promise<Epic[]> {
      const value = await apiRequest<unknown>(
        connection,
        `/projects/epics?${new URLSearchParams({ projectId })}`,
        { signal: timeout() },
      );
      return (Array.isArray(value) ? value : []).map(parseEpic);
    },
    async update(id: string, input: EpicUpdate): Promise<Epic> {
      return parseEpic(
        await apiRequest<unknown>(
          connection,
          `/projects/epics/${encodeURIComponent(id)}`,
          {
            body: JSON.stringify(input),
            method: "PATCH",
            signal: timeout(),
          },
        ),
      );
    },
  };
}

export type EpicApi = ReturnType<typeof epicApi>;
