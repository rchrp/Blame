import type {
  ApiConnection,
  AgentBackendConfig,
  ReasoningSelection,
} from "./types.js";

export type NewProjectGenerationConfiguration =
  import("./new-project-options.js").NewProjectConfiguration;

export type StartNewProjectGenerationInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningSelection;
  credentialLabel?: string;
  configuration: NewProjectGenerationConfiguration;
  cwd: string;
  workspaceRoot: string;
  projectName: string;
  sessionId?: string;
  backend?: AgentBackendConfig;
  executionId?: string;
  storyId?: string;
};

export type NewProjectGenerationResult = {
  path: string;
  sessionId: string;
};

export type NewProjectsClient = {
  generate(
    input: StartNewProjectGenerationInput,
  ): Promise<NewProjectGenerationResult>;
};
