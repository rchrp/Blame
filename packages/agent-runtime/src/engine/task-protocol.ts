// The renderer's calls that run engine tasks (docs/engine-in-the-app.md,
// "Tasks"). Types only: the main process and the renderer import this file
// through `engine/protocol.ts`, and neither may load the engine host's code.

import type { SessionId } from "@blame/engine-client";
import type {
  ApproveAndMergeResult,
  GenerateCommitMessageResult,
  MapSecurityAuditResult,
  OpenPullRequestResult,
  ProjectCodePracticePreference,
  ProjectRunConfiguration,
  ResolveMergeConflictsResult,
  SecurityAuditDiscoveryResult,
  SecurityAuditMode,
  SecurityAuditPerspective,
  ValidateSecurityAuditResult,
} from "../types.js";
import type { NewProjectConfiguration } from "../new-project-options.js";
import type {
  PreviewManifest,
  ProjectCodePracticeResult,
  ProjectInitializationDiagnostics,
  ProjectInitializationImpactClassification,
  ProjectInitializationImpactDiagnostics,
  ProjectInitializationPreferences,
  ProjectInitializationRepairClassification,
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

/** One investigator of a security audit, reading the project's code. */
export type DiscoverSecurityAuditTask = TaskCall & {
  workspace: TaskWorkspace;
  mode: SecurityAuditMode;
  perspective: SecurityAuditPerspective;
  repository: MapSecurityAuditResult;
};

/** The audit's validator: confirms or rejects every candidate in the code. */
export type ValidateSecurityAuditTask = TaskCall & {
  workspace: TaskWorkspace;
  mode: SecurityAuditMode;
  repository: MapSecurityAuditResult;
  /** The investigators' and the deterministic scanners' candidates. */
  discoveries: SecurityAuditDiscoveryResult[];
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
  discoverSecurityAudit: {
    input: DiscoverSecurityAuditTask;
    result: SecurityAuditDiscoveryResult & { session: SessionId };
  };
  validateSecurityAudit: {
    input: ValidateSecurityAuditTask;
    result: ValidateSecurityAuditResult & { session: SessionId };
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
  "approveAndMerge",
  "openPullRequest",
  "generateCommitMessage",
  "resolveMergeConflicts",
  "discoverSecurityAudit",
  "validateSecurityAudit",
  "initializeProject",
  "repairProjectInitialization",
  "assessInitializationImpact",
  "analyzeCodePractices",
  "generateNewProject",
  "cancelTask",
  "deleteSession",
] as const satisfies readonly (keyof EngineTaskMethods)[];
