import type {
  AgentBackendConfig,
  ApiConnection,
  ReasoningSelection,
} from "./types.js";

export type RuntimeCredentialInput = {
  apiConnection: ApiConnection;
  backend?: AgentBackendConfig;
  reasoningEffort?: ReasoningSelection;
  providerId: string;
  modelId?: string;
  credentialLabel?: string;
};
