import type { ClineCore } from "@cline/sdk";
import type { AgentTelemetry } from "./agent-telemetry.js";
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

/** Runtime services shared by the conversation-based planning workflows. */
export type PlanningHost = {
  core(backend?: AgentBackendConfig): Promise<ClineCore>;
  credential(input: RuntimeCredentialInput): Promise<{
    apiKey: string;
    baseUrl: string | null;
    authMethod?: string;
  }>;
  git?: (cwd: string, args: string[]) => Promise<string>;
  subscribe(sessionId: string, backend?: AgentBackendConfig): Promise<void>;
  telemetry: Pick<AgentTelemetry, "runOperation">;
  unsubscribe(sessionId: string): Promise<void>;
};
