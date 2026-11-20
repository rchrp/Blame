// The contract between the renderer, the main process and the engine host
// (docs/engine-in-the-app.md). Types and a few pure helpers only: the main
// process and the renderer import this file, and neither may load the
// engine host's code.

import type {
  FollowEvent,
  ReasoningEffort,
  Seq,
  SessionId,
  ToolCallId,
  TurnOutcome,
} from "@blame/engine-client";
import type { AgentPersonalization } from "../personalization.js";
import type {
  ApiConnection,
  ClaudeCodeStatus,
  ProjectCodePracticePreference,
  ProviderCredentialSummary,
  ProviderListResponse,
  ReasoningSelection,
  SaveProviderCredentialInput,
  SubscriptionUsage,
} from "../types.js";

/** What a conversation is for; each has its own config builder in the host. */
export type EnginePurpose = "quick-chat";

/** The model a conversation uses. */
export type EngineModelChoice = {
  /** The engine's provider id, e.g. `chatgpt`: the one the whole app uses. */
  providerId: string;
  modelId: string;
  /** Which of the user's credentials for this provider, when they have several. */
  credentialLabel?: string;
  /** The reasoning picked in the model selector (`engineReasoning` maps it). */
  reasoning?: ReasoningSelection;
};

/** What the renderer decides about a quick chat; the host builds the rest. */
export type QuickChatSettings = {
  workspaceRoot: string;
  projectId?: string;
  model: EngineModelChoice;
  maxContextTokens?: number;
  /** How the person wants agents to talk and work (`personalization.ts`). */
  personalization?: Partial<AgentPersonalization>;
  codePractices?: ProjectCodePracticePreference[];
};

export type EngineSessionSettings = {
  purpose: "quick-chat";
  settings: QuickChatSettings;
};

/** One file the person attached to a message, as the renderer read it. */
export type EngineAttachment = {
  name: string;
  mediaType: string;
  /** The bytes, base64-encoded. */
  data: string;
};

export type EngineMessage = {
  text: string;
  attachments?: EngineAttachment[];
};

export type EngineHostMethods = {
  connect: { input: { api: ApiConnection | null }; result: null };
  createSession: {
    input: EngineSessionSettings & { session: SessionId };
    result: { session: SessionId; head: Seq };
  };
  /** Sets the settings when the config they build differs from the session's. */
  configure: {
    input: EngineSessionSettings & { session: SessionId };
    result: { changed: boolean };
  };
  send: {
    input: {
      session: SessionId;
      message: EngineMessage;
      delivery: "turn" | "steer";
      /**
       * The settings picked when the message was sent: applied first, as
       * `configure` does, so the turn runs with them.
       */
      settings?: EngineSessionSettings;
    };
    result: { turn: string; started: boolean };
  };
  interrupt: { input: { session: SessionId }; result: null };
  compact: { input: { session: SessionId }; result: null };
  rewind: {
    input: { session: SessionId; to: Seq; restoreWorkspace: boolean };
    result: { finished: Seq };
  };
  undoRewind: { input: { session: SessionId }; result: null };
  resolveApproval: {
    input: {
      session: SessionId;
      call: ToolCallId;
      decision: "approved" | "denied";
    };
    result: boolean;
  };
  /** The caller names the subscription, so it can follow again after a host restart. */
  follow: { input: { session: SessionId; subscription: string }; result: null };
  unfollow: { input: { subscription: string }; result: null };
  running: { input: undefined; result: SessionId[] };
  /**
   * The providers and models to offer (the engine's models.dev catalog) with
   * the person's credentials; `refresh` asks models.dev first.
   */
  providers: { input: { refresh?: boolean }; result: ProviderListResponse };
  saveCredential: {
    input: SaveProviderCredentialInput;
    result: ProviderCredentialSummary;
  };
  deleteCredential: { input: { id: string }; result: null };
  /** The ChatGPT sign-in in the browser, kept in the API. */
  signInChatGpt: {
    input: { label?: string };
    result: ProviderCredentialSummary;
  };
  claudeCodeStatus: { input: undefined; result: ClaudeCodeStatus };
  connectClaudeCode: {
    input: { label?: string };
    result: { credential: ProviderCredentialSummary; status: ClaudeCodeStatus };
  };
  planUsage: {
    input: { providerId: string; credentialLabel?: string };
    result: SubscriptionUsage | null;
  };
  shutdown: { input: undefined; result: null };
};

export type EngineHostMethod = keyof EngineHostMethods;
export type EngineHostInput<M extends EngineHostMethod> =
  EngineHostMethods[M]["input"];
export type EngineHostResult<M extends EngineHostMethod> =
  EngineHostMethods[M]["result"];

export const engineHostMethods = [
  "connect",
  "createSession",
  "configure",
  "send",
  "interrupt",
  "compact",
  "rewind",
  "undoRewind",
  "resolveApproval",
  "follow",
  "unfollow",
  "running",
  "providers",
  "saveCredential",
  "deleteCredential",
  "signInChatGpt",
  "claudeCodeStatus",
  "connectClaudeCode",
  "planUsage",
  "shutdown",
] as const satisfies readonly EngineHostMethod[];

/** What the host tells the renderers. */
export type EngineHostEvent =
  | { type: "follow"; subscription: string; event: FollowEvent }
  /** A turn started (`running`) or every turn of the session ended. */
  | {
      type: "activity";
      session: SessionId;
      running: boolean;
      outcome?: TurnOutcome;
    };

/** What the host asks of the main process: desktop services its tools use. */
export type EngineDesktopMethods = {
  renderWebPage: {
    input: { url: string; timeoutMs?: number };
    result: { url: string; html: string };
  };
  /** Opens a sign-in page in the person's browser. */
  openExternal: { input: { url: string }; result: null };
};

export type EngineDesktopMethod = keyof EngineDesktopMethods;

/** Messages on the port between the main process and the engine host. */
export type EngineHostMessage =
  | { kind: "request"; id: number; method: EngineHostMethod; input: unknown }
  | {
      kind: "response";
      id: number;
      result?: unknown;
      error?: { message: string };
    }
  | { kind: "event"; event: EngineHostEvent }
  | {
      kind: "desktop-request";
      id: number;
      method: EngineDesktopMethod;
      input: unknown;
    }
  | {
      kind: "desktop-response";
      id: number;
      result?: unknown;
      error?: { message: string };
    }
  | { kind: "ready" };

export function isEngineHostMessage(
  value: unknown,
): value is EngineHostMessage {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "request" ||
    kind === "response" ||
    kind === "event" ||
    kind === "desktop-request" ||
    kind === "desktop-response" ||
    kind === "ready"
  );
}

/**
 * The engine's reasoning effort for the selector's choice: `none` turns
 * reasoning off (the engine asks for the least where a model cannot stop),
 * `enabled` leaves the provider's default.
 */
export function engineReasoning(
  selection: ReasoningSelection | undefined,
): ReasoningEffort | undefined {
  if (!selection || selection === "enabled") return undefined;
  if (selection === "none") return "off";
  return selection;
}

/** Calls a window makes itself; following goes through `follow` below. */
export type EngineWindowMethod = Exclude<
  EngineHostMethod,
  "follow" | "unfollow" | "shutdown"
>;

export type EngineActivityEvent = Extract<
  EngineHostEvent,
  { type: "activity" }
>;

/** `platform.engine`: the renderer's only way to the engine. */
export type EnginePlatformClient = {
  call<M extends EngineWindowMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>>;
  /** Everything about one session, from its first record; returns the way to stop. */
  follow(session: SessionId, onEvent: (event: FollowEvent) => void): () => void;
  /** Turns starting and ending in any session. */
  onActivity(callback: (event: EngineActivityEvent) => void): () => void;
};
