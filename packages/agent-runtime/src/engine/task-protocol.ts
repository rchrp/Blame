// The renderer's calls that run engine tasks (docs/engine-in-the-app.md,
// "Tasks"). Types only: the main process and the renderer import this file
// through `engine/protocol.ts`, and neither may load the engine host's code.

import type { SessionId } from "@blame/engine-client";
import type { ProjectRunConfiguration } from "../types.js";
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

export type EngineTaskMethods = {
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
  "cancelTask",
  "deleteSession",
] as const satisfies readonly (keyof EngineTaskMethods)[];
