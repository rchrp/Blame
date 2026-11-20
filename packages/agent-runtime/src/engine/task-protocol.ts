// The renderer's calls that run engine tasks (docs/engine-in-the-app.md,
// "Tasks"). Types only: the main process and the renderer import this file
// through `engine/protocol.ts`, and neither may load the engine host's code.

import type { SessionId } from "@blame/engine-client";
import type { NewProjectConfiguration } from "../new-project-options.js";
import type {
  PreviewManifest,
  ProjectCodePracticeResult,
  ProjectInitializationDiagnostics,
  ProjectInitializationImpactClassification,
  ProjectInitializationImpactDiagnostics,
  ProjectInitializationPreferences,
  ProjectInitializationRepairClassification,
  ProjectRunConfiguration,
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

/** A result the API refused, sent back to the agent of the next run. */
export type InitializationFeedback = {
  validationError: string;
  previousResult: string;
};

/** The preview setup of a project, as the agent submits it and the API saves it. */
export type ProjectPreviewSetup = {
  previewManifest: PreviewManifest;
  runConfigurations: ProjectRunConfiguration[];
};

export type InitializeProjectTask = TaskCall & {
  /** The project checkout, on this machine. */
  workspace: TaskWorkspace;
  preferences?: ProjectInitializationPreferences;
  validationFeedback?: InitializationFeedback;
};

export type RepairProjectInitializationTask = TaskCall &
  ProjectPreviewSetup & {
    workspace: TaskWorkspace;
    preferences?: ProjectInitializationPreferences;
    diagnostics:
      ProjectInitializationDiagnostics | ProjectInitializationImpactDiagnostics;
  };

export type RepairProjectInitializationResult = {
  session: SessionId;
  classification: ProjectInitializationRepairClassification;
  reason: string;
} & Partial<ProjectPreviewSetup>;

export type AssessInitializationImpactTask = TaskCall &
  ProjectPreviewSetup & {
    /** The repository the commits belong to, on this machine. */
    workspace: TaskWorkspace;
    baseCommit: string;
    mergeCommit: string;
  };

export type AssessProjectInitializationImpactResult = {
  /** Absent when the diff alone decided, without an agent. */
  session?: SessionId;
  classification: ProjectInitializationImpactClassification;
  reason: string;
  repairInstruction?: string;
  diagnostics: ProjectInitializationImpactDiagnostics;
};

export type AnalyzeCodePracticesTask = TaskCall & {
  workspace: TaskWorkspace;
};

export type GenerateNewProjectTask = TaskCall & {
  /** The new project's empty folder, on this machine. */
  workspace: TaskWorkspace;
  projectName: string;
  configuration: NewProjectConfiguration;
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
  /** The preview setup of a project, from its files (a long task to follow). */
  initializeProject: {
    input: InitializeProjectTask;
    result: { session: SessionId } & ProjectPreviewSetup;
  };
  /** A preview setup that failed, diagnosed and repaired when it can be. */
  repairProjectInitialization: {
    input: RepairProjectInitializationTask;
    result: RepairProjectInitializationResult;
  };
  /** Whether the commits between two revisions change what the setup needs. */
  assessInitializationImpact: {
    input: AssessInitializationImpactTask;
    result: AssessProjectInitializationImpactResult;
  };
  analyzeCodePractices: {
    input: AnalyzeCodePracticesTask;
    result: { session: SessionId; practices: ProjectCodePracticeResult[] };
  };
  /** Scaffolds a new project in its empty folder (a long task to follow). */
  generateNewProject: {
    input: GenerateNewProjectTask;
    result: { session: SessionId; summary: string };
  };
  /** Stops a running task; false when none runs by that id. */
  cancelTask: { input: { session: SessionId }; result: boolean };
  /** Deletes a session from the engine (a deleted quick chat). */
  deleteSession: { input: { session: SessionId }; result: null };
};

export const engineTaskMethods = [
  "generateTitle",
  "optimizeUserStory",
  "initializeProject",
  "repairProjectInitialization",
  "assessInitializationImpact",
  "analyzeCodePractices",
  "generateNewProject",
  "cancelTask",
  "deleteSession",
] as const satisfies readonly (keyof EngineTaskMethods)[];
