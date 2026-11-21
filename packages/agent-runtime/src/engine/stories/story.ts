// A development story as the story service reads it, and what the life of
// its agent means for it: the fields the service writes, its first and
// later messages, the end of each turn.

import { unverifiedChecks, type TurnOutcome } from "@blame/engine-client";
import type { AgentPersonalization } from "../../personalization.js";
import type { EngineLocation, EngineMessage } from "../protocol.js";
import type { StoryRequestedModel, StoryRunMode } from "../story-protocol.js";

export type StoryStatus =
  "backlog" | "ready" | "in-progress" | "in-review" | "done" | "discarded";

export type StoryWorkspaceMode = "direct" | "local-container" | "cloud-mirror";

export type StoryAgentModel = {
  providerId: string;
  modelId: string;
  reasoningEffort?: string | null;
  turns?: number;
};

type CodeSelection = {
  content: string;
  path: string;
  startLine: number;
  endLine: number;
  origin?: string;
};

type FileAttachment = {
  id: string;
  name: string;
  type: string;
  content?: string;
};

/** The fields of a story (`UserStory` in the app) the service reads. */
export type HostStory = {
  id: string;
  projectId: string;
  storyNumber: number;
  title: string;
  summary: string;
  status: StoryStatus;
  createdAt: string;
  codeSelectionAttachments?: CodeSelection[] | null;
  fileAttachments?: FileAttachment[] | null;
  fileAttachmentUploadPending?: boolean;
  branch?: string | null;
  targetBranch?: string | null;
  worktree?: string | null;
  workspaceMode?: StoryWorkspaceMode | null;
  runMode?: StoryRunMode | null;
  runConfigurationId?: string | null;
  ambition?: AgentPersonalization["ambition"] | null;
  agentStatus?: "Running" | "Paused" | null;
  agentLastError?: string | null;
  engineSessionId?: string | null;
  agentModels?: StoryAgentModel[] | null;
  /** Stories of the same project this one starts after, once each is done. */
  startsAfter?: string[] | null;
  /** The model its first run uses instead of the account's. */
  requestedModel?: StoryRequestedModel | null;
};

/** What the service writes to a story (the API's PATCH). */
export type StoryUpdate = Partial<
  Pick<
    HostStory,
    | "status"
    | "branch"
    | "targetBranch"
    | "worktree"
    | "workspaceMode"
    | "runMode"
    | "agentStatus"
    | "agentLastError"
    | "engineSessionId"
    | "agentModels"
  > & {
    previewUrl: string | null;
    baseCommit: string | null;
    mergeCommit: string | null;
    mergedAt: string | null;
    discardedReason: string | null;
    pullRequestUrl: string | null;
  }
>;

export function parseStory(value: unknown): HostStory {
  const story = value as Partial<HostStory> | undefined;
  if (
    !story ||
    typeof story !== "object" ||
    typeof story.id !== "string" ||
    typeof story.projectId !== "string" ||
    typeof story.title !== "string"
  )
    throw new Error("Unable to read user story.");
  return {
    ...story,
    summary: typeof story.summary === "string" ? story.summary : "",
    startsAfter: Array.isArray(story.startsAfter)
      ? story.startsAfter.filter((id): id is string => typeof id === "string")
      : [],
    requestedModel: requestedModel(story.requestedModel),
  } as HostStory;
}

function requestedModel(value: unknown): StoryRequestedModel | null {
  const model = value as Partial<StoryRequestedModel> | null | undefined;
  if (!model || typeof model !== "object") return null;
  if (typeof model.providerId !== "string" || !model.providerId) return null;
  if (typeof model.modelId !== "string" || !model.modelId) return null;
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(typeof model.credentialLabel === "string" && model.credentialLabel
      ? { credentialLabel: model.credentialLabel }
      : {}),
    ...(typeof model.reasoningEffort === "string" && model.reasoningEffort
      ? { reasoningEffort: model.reasoningEffort }
      : {}),
  };
}

/** Its files are uploaded (or it has some to read): its agent can start. */
export function readyForAgent(story: HostStory) {
  if (story.status !== "ready") return false;
  if (!story.fileAttachmentUploadPending) return true;
  return (
    story.fileAttachments?.some((file) => file.content !== undefined) ?? false
  );
}

/**
 * Where a story's worktree is, so its agent runs on the engine next to it. A
 * local-container worktree lives in the Blame Runtime VM on macOS and
 * Windows (on Linux, on the host).
 */
export function storyLocation(
  workspaceMode: StoryWorkspaceMode | null | undefined,
  platform: string = process.platform,
): EngineLocation {
  return (workspaceMode ?? "direct") === "local-container" &&
    platform !== "linux"
    ? "vm"
    : "host";
}

export function storyDisplayId(story: Pick<HostStory, "storyNumber">) {
  return `US-${String(story.storyNumber).padStart(3, "0")}`;
}

/** The models list with this one last (the card shows them; the next turn reuses the last). */
export function withAgentModel(
  models: StoryAgentModel[] | null | undefined,
  model: StoryAgentModel,
): StoryAgentModel[] {
  const others = (models ?? []).filter(
    (item) =>
      item.providerId !== model.providerId ||
      item.modelId !== model.modelId ||
      (item.reasoningEffort ?? null) !== (model.reasoningEffort ?? null),
  );
  return [...others, model].slice(-16);
}

/**
 * The story's models with how many turns each answered, as the engine's
 * records count them: every entry of a model carries its count, and a model
 * the records name but the story does not list is added. Undefined when
 * nothing changes.
 */
export function withTurnCounts(
  models: StoryAgentModel[] | null | undefined,
  counts: ReadonlyArray<{ providerId: string; modelId: string; turns: number }>,
): StoryAgentModel[] | undefined {
  const key = (model: { providerId: string; modelId: string }) =>
    `${model.providerId}\u0000${model.modelId}`;
  const turns = new Map(counts.map((count) => [key(count), count.turns]));
  const listed = new Set((models ?? []).map(key));
  const next = [
    ...(models ?? []).map((model) => {
      const { turns: _, ...rest } = model;
      void _;
      const count = turns.get(key(model));
      return count ? { ...rest, turns: count } : rest;
    }),
    ...counts
      .filter((count) => !listed.has(key(count)))
      .map(({ providerId, modelId, turns: count }) => ({
        providerId,
        modelId,
        turns: count,
      })),
  ].slice(-16);
  return JSON.stringify(next) === JSON.stringify(models ?? [])
    ? undefined
    : next;
}

/** A turn the agent ended without a finish the checks accepted (the app words it the same). */
export const unfinishedTurnText =
  "The agent stopped without finishing: its work was not checked with finish_task.";

/**
 * What the end of every turn of a story's agent means for the story:
 * done, it waits for review; stopped (by the person, by a limit, by Blame
 * quitting), it is paused where it was; failed, it waits paused with the
 * reason, from its records.
 */
export function storyOutcomeUpdate(
  story: Pick<HostStory, "status">,
  outcome: TurnOutcome | undefined,
): StoryUpdate {
  if (story.status !== "in-progress") return { agentStatus: null };
  switch (outcome?.status) {
    case "completed":
      return { agentStatus: null, status: "in-review" };
    // The engine already retried what could be retried.
    case "failed":
      return { agentStatus: "Paused", agentLastError: outcome.error.message };
    // The agent stopped without a finish the checks accepted. When they
    // refused it because a check still fails, its reply stands, unverified,
    // and the story waits for review; otherwise it is paused.
    case "contract_unmet":
      return unverifiedChecks({ outcome })
        ? { agentStatus: null, status: "in-review" }
        : { agentStatus: "Paused", agentLastError: unfinishedTurnText };
    default:
      return { agentStatus: "Paused" };
  }
}

export const storyResumeMessage =
  "Continue the story where you left off: check what is already done in the worktree before going on.";

/** What a story keeps of its runtime once it leaves In Progress and In Review. */
export function inactiveStoryFields(): StoryUpdate {
  return {
    agentStatus: null,
    branch: null,
    previewUrl: null,
    worktree: null,
    workspaceMode: null,
  };
}

/**
 * A message to the story's agent: the text, code excerpts quoted in it,
 * and attached files read as the model gets them (images, PDFs, text).
 */
export async function storyMessage(
  text: string,
  codeSelections: unknown[] | null | undefined,
  files: unknown[] | null | undefined,
  readFile: (file: FileAttachment) => Promise<string | undefined>,
): Promise<EngineMessage> {
  const selections = (codeSelections ?? []).filter(isCodeSelection);
  const excerpts = selections
    .filter((excerpt) => excerpt.origin !== "story")
    .map(
      (excerpt) =>
        `${excerpt.path}, ${lineLabel(excerpt).toLowerCase()}:\n\n\`\`\`\n${excerpt.content}\n\`\`\``,
    );
  const stories = selections
    .filter((excerpt) => excerpt.origin === "story")
    .map((excerpt) => `Builds on ${excerpt.path}: ${excerpt.content}`);
  const attachments: NonNullable<EngineMessage["attachments"]> = [];
  for (const file of (files ?? []).filter(isFileAttachment)) {
    const data = file.content ?? (await readFile(file));
    if (data)
      attachments.push({
        data,
        mediaType: file.type || "application/octet-stream",
        name: file.name,
      });
  }
  return {
    text: [text.trim(), ...excerpts, ...stories].filter(Boolean).join("\n\n"),
    attachments,
  };
}

function lineLabel(excerpt: Pick<CodeSelection, "startLine" | "endLine">) {
  return excerpt.startLine === excerpt.endLine
    ? `Line ${excerpt.startLine}`
    : `Lines ${excerpt.startLine}-${excerpt.endLine}`;
}

function isCodeSelection(value: unknown): value is CodeSelection {
  const item = value as Partial<CodeSelection> | null;
  return (
    !!item &&
    typeof item.content === "string" &&
    typeof item.path === "string" &&
    typeof item.startLine === "number" &&
    typeof item.endLine === "number"
  );
}

function isFileAttachment(value: unknown): value is FileAttachment {
  const item = value as Partial<FileAttachment> | null;
  return (
    !!item &&
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    (item.content === undefined || typeof item.content === "string")
  );
}
