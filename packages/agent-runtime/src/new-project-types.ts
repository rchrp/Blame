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

export type NewProjectPlanMessage = {
  role: "user" | "assistant";
  text: string;
  configuration?: NewProjectGenerationConfiguration;
};

export type PlanNewProjectInput = Omit<
  StartNewProjectGenerationInput,
  "configuration"
> & {
  messages: NewProjectPlanMessage[];
  notes?: string;
};

export type PlanNewProjectResult = {
  sessionId: string;
  message: string;
  configuration?: NewProjectGenerationConfiguration;
  notes?: string;
};

export type NewProjectGenerationResult = {
  path: string;
  sessionId: string;
};

export type NewProjectsClient = {
  plan(input: PlanNewProjectInput): Promise<PlanNewProjectResult>;
  generate(
    input: StartNewProjectGenerationInput,
  ): Promise<NewProjectGenerationResult>;
};
