// The story service's calls and events (docs/engine-in-the-app.md,
// "Development stories"). Types only: the main process and the renderer
// import this file through `engine/protocol.ts`, and neither may load the
// engine host's code.

import type { TurnOutcome } from "@blame/engine-client";
import type { AgentPersonalization } from "../personalization.js";
import type { ApproveAndMergeResult } from "../types.js";
import type { EngineModelChoice } from "./protocol.js";

/** A project opened on this computer: its id in the account and its folder. */
export type StoryProject = { id: string; path: string };

/** Where a story runs (`UserStory.runMode`). */
export type StoryRunMode = "local-container" | "vercel-compose" | "direct";

/** A model with the most input it takes, when the picker knows it. */
export type StoryModel = EngineModelChoice & { maxInputTokens?: number };

/**
 * What only a window knows and a story's start needs: the person's settings
 * kept on this device, and the Blame Runtime as the window sees it. Each
 * window sends them when they change; the host keeps the latest.
 */
export type StoryPreferences = {
  /** The account's agent model, as the model picker resolves it. */
  agentModel?: StoryModel;
  personalization?: Partial<AgentPersonalization>;
  /** Where a story with no choice of its own runs. */
  runMode: StoryRunMode;
  /** Cloud Preview needs Premium. */
  premium: boolean;
  /** The context cap picked for a story, by story id. */
  contextLimits?: Record<string, number>;
  /** The Blame Runtime's phase (`RuntimePhase` in the app). */
  runtimePhase: string;
};

/** A story's agent model asked for by its creator (`UserStory.requestedModel`). */
export type StoryRequestedModel = {
  providerId: string;
  modelId: string;
  credentialLabel?: string;
  reasoningEffort?: string;
};

/** Why a queued story does not start now. */
export type StoryWaitReason =
  /** Stories it starts after are not done yet. */
  | { kind: "dependencies"; storyIds: string[] }
  /** A story it starts after was discarded or deleted: it never starts. */
  | { kind: "dependency-dropped"; storyIds: string[] }
  /** The project's folder is not known on this computer. */
  | { kind: "no-project" }
  | { kind: "no-model" }
  | { kind: "signed-out" }
  /** The project's preview environment is being prepared. */
  | { kind: "initialization" }
  /** The Blame Runtime is starting, checking or updating. */
  | { kind: "runtime"; phase: string }
  /** The Blame Runtime must be installed or repaired. */
  | { kind: "needs-runtime"; phase: string }
  | { kind: "cloud-without-premium" }
  | {
      kind: "host-dependencies";
      /** The desktop's `HostDependencyReport`. */
      report: unknown;
      runtimeProfile: "local-container" | "vercel-compose";
      workspaceMode: "local-container" | "cloud-mirror" | "direct";
    }
  /** Git has no name and email to commit with. */
  | { kind: "git-identity" }
  /** The start failed; it is tried again. */
  | { kind: "error"; message: string };

export type StoryWaiting = {
  storyId: string;
  projectId: string;
  title: string;
  reason: StoryWaitReason;
};

/** What the queue does now, for the board. */
export type StoryQueueState = {
  waiting: StoryWaiting[];
  /** Stories being started now. */
  starting: string[];
  /** Local Container stories whose agent works (the runtime waits for them to update). */
  localRunning: number;
};

/** A message to a story's agent, as the composer has it. */
export type StoryMessageInput = {
  text: string;
  codeSelectionAttachments?: unknown[] | null;
  fileAttachments?: unknown[] | null;
};

/** What the person picked for a turn they start (a message, a resume). */
export type StoryTurnChoice = {
  /** The composer's model for this story; else its last model, else the account's. */
  model?: StoryModel;
  maxContextTokens?: number;
  personalization?: Partial<AgentPersonalization>;
  /** Ultra mode is on for the message. */
  ultra?: boolean;
};

/** What Approve & Merge leaves for the window to do and say. */
export type StoryMergeOutcome = {
  /** The story as the API keeps it now. */
  story: unknown;
  merge: ApproveAndMergeResult;
  repositoryRoot: string;
  /** The merged story's own repair of the preview environment, if it made one. */
  previewRepairCandidate?: unknown;
};

export type EngineStoryMethods = {
  /** The projects on this computer and the person's settings (`StoryPreferences`). */
  storySync: {
    input: { projects: StoryProject[]; preferences: StoryPreferences };
    result: null;
  };
  /** Reads a project's stories again (one the window changed), then looks at the queue. */
  storyRefresh: { input: { projectId?: string }; result: null };
  /** Looks at a waiting story again now (a dependency was installed, Git got a name). */
  storyRetry: { input: { storyId?: string }; result: null };
  storyQueueState: { input: undefined; result: StoryQueueState };
  /** Send to Dev Agent: the story joins the queue. */
  storyEnqueue: { input: { storyId: string }; result: unknown };
  /** A message to the story's agent; a paused or reviewed story resumes. */
  storySend: {
    input: {
      storyId: string;
      message: StoryMessageInput;
      /** While the agent works: into the running turn now. */
      steer?: boolean;
      turn?: StoryTurnChoice;
    };
    result: unknown;
  };
  /** Stops the running turn; the story waits, paused, where it was. */
  storyPause: { input: { storyId: string }; result: unknown };
  /** A paused agent picks its conversation back up. */
  storyResume: {
    input: { storyId: string; turn?: StoryTurnChoice };
    result: unknown;
  };
  /** Undoes a message to the agent and what followed, with its files. */
  storyRewind: {
    input: { storyId: string; to: number; restoreWorkspace: boolean };
    result: { finished: number };
  };
  /** Approve & Merge: the story's work into its target branch, then its cleanup. */
  storyApprove: {
    input: { storyId: string; push?: boolean; model: EngineModelChoice };
    result: StoryMergeOutcome;
  };
  /**
   * Done without a merge here: committed in the project folder, merged on
   * GitHub, or nothing to merge. Its agent, runtime and worktree go.
   */
  storyComplete: {
    input: {
      storyId: string;
      baseCommit?: string | null;
      mergeCommit?: string | null;
      mergedAt?: string | null;
    };
    result: unknown;
  };
  /** Back to the backlog: its agent stopped, its runtime and worktree gone. */
  storyToBacklog: { input: { storyId: string }; result: unknown };
  /** Discarded: its agent stopped; its runtime and worktree go meanwhile. */
  storyDiscard: { input: { storyId: string; reason: string }; result: unknown };
  /** Deleted for good, with its agent, runtime and worktree. */
  storyDelete: { input: { storyId: string }; result: null };
  /** What a git flow of a window (Open PR, a Direct commit) says went wrong; null clears it. */
  storyError: {
    input: { storyId: string; error: string | null };
    result: unknown;
  };
};

/** What the host tells the windows about stories. */
export type StoryHostEvent =
  /** The API now keeps this story so (its payload, as the API sends it). */
  | {
      type: "story";
      projectId: string;
      storyId: string;
      story: unknown;
      /** It started: its preview gets ready (`environment`: the saved preview environment). */
      started?: { environment: unknown };
      /** It runs Direct: the project has no working preview environment. */
      directFallback?: boolean;
    }
  | { type: "story-removed"; projectId: string; storyId: string }
  /** What a story ran (its worktree, previews) is being removed; `error` when that failed. */
  | {
      type: "story-cleanup";
      projectId: string;
      storyId: string;
      cleaning: boolean;
      error?: string;
    }
  | { type: "story-queue"; queue: StoryQueueState };

/** One turn of a story's agent ended (for the host's own listeners). */
export type StoryTurnEnded = {
  storyId: string;
  projectId: string;
  session: string;
  /** The story as the API keeps it once the turn's outcome is applied. */
  story: unknown;
  outcome?: TurnOutcome;
  /** What the agent reported: its finish_task summary, or its last text. */
  lastReply?: string;
};
