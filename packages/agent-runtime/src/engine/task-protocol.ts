// The renderer's calls that run engine tasks (docs/engine-in-the-app.md,
// "Tasks"). Types only: the main process and the renderer import this file
// through `engine/protocol.ts`, and neither may load the engine host's code.

import type { SessionId } from "@blame/engine-client";
import type {
  ApproveAndMergeResult,
  GenerateCommitMessageResult,
  OpenPullRequestResult,
  ProjectCodePracticePreference,
  ProjectRunConfiguration,
  ResolveMergeConflictsResult,
} from "../types.js";
import type { EngineModelChoice } from "./protocol.js";

/** The folder a task works in, as the app knows it. */
export type TaskWorkspace = {
  root: string;
  /** The folder lives in the Blame Runtime VM (Lima, WSL), not on this machine. */
  inVm?: boolean;
};

/** What every task call carries. */
export type TaskCall = {
  model: EngineModelChoice;
  projectId?: string;
  /**
   * The task's session id, chosen by the caller to follow its progress
   * (`follow`) or stop it (`cancelTask`). A new one otherwise.
   */
  task?: SessionId;
};

export type GenerateTitleTask = TaskCall & {
  context: "quick-chat" | "user-story";
  prompt: string;
  workspace?: TaskWorkspace;
  runConfigurations?: ProjectRunConfiguration[];
};

export type OptimizeUserStoryTask = TaskCall & {
  prompt: string;
  title?: string;
  workspace?: TaskWorkspace;
};

/**
 * What a git flow of a story or of the Git page carries. Its agents are
 * tasks of their own, and the flow runs in the engine host, between them.
 */
export type GitFlowCall = Omit<TaskCall, "task"> & {
  repositoryRoot: string;
  worktree: string;
  /**
   * The worktree lives in the Blame Runtime VM: set by the main process,
   * which is the one that knows. Its agents that read files cannot run.
   */
  inVm?: boolean;
  codePractices?: ProjectCodePracticePreference[];
};

export type ApproveAndMergeTask = GitFlowCall & {
  storyBranch: string;
  /** The branch the story started from; else the project folder's branch. */
  targetBranch?: string;
  /** Worktrees where an agent runs, set by the main process: the target branch never moves under one. */
  activeWorktrees?: string[];
  /** Only true also pushes the target branch to its upstream. */
  push?: boolean;
  title: string;
  summary: string;
};

/** Commits the story's remaining work, pushes its branch, and opens (or finds) its pull request. */
export type OpenPullRequestTask = Omit<
  ApproveAndMergeTask,
  "activeWorktrees" | "push"
> & {
  /** The agent's final summary of the story, quoted in the pull request body. */
  agentSummary?: string;
};

export type GenerateCommitMessageTask = GitFlowCall & {
  title?: string;
  summary?: string;
  /** A Direct story's commit: the message closes the issues the story handles. */
  closeLinkedIssues?: boolean;
  /** The Git page's selected files; else every change. */
  selectedPaths?: string[];
};

export type ResolveMergeConflictsTask = GitFlowCall & {
  title?: string;
  summary?: string;
  targetBranch?: string;
};

export type EngineTaskMethods = {
  approveAndMerge: {
    input: ApproveAndMergeTask;
    result: ApproveAndMergeResult;
  };
  openPullRequest: {
    input: OpenPullRequestTask;
    result: OpenPullRequestResult;
  };
  generateCommitMessage: {
    input: GenerateCommitMessageTask;
    result: GenerateCommitMessageResult;
  };
  resolveMergeConflicts: {
    input: ResolveMergeConflictsTask;
    result: ResolveMergeConflictsResult;
  };
  generateTitle: {
    input: GenerateTitleTask;
    result: {
      session: SessionId;
      title: string;
      /** Only for a story given run configurations; null when none fits. */
      runConfigurationId?: string | null;
    };
  };
  optimizeUserStory: {
    input: OptimizeUserStoryTask;
    result: { session: SessionId; markdown: string };
  };
  /** Stops a running task; false when none runs by that id. */
  cancelTask: { input: { session: SessionId }; result: boolean };
  /** Deletes a session from the engine (a deleted quick chat). */
  deleteSession: { input: { session: SessionId }; result: null };
};

export const engineTaskMethods = [
  "generateTitle",
  "optimizeUserStory",
  "approveAndMerge",
  "openPullRequest",
  "generateCommitMessage",
  "resolveMergeConflicts",
  "cancelTask",
  "deleteSession",
] as const satisfies readonly (keyof EngineTaskMethods)[];
