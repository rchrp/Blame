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
import type { DesktopServiceMethods } from "./desktop-services.js";

/** What a conversation is for; each has its own config builder in the host. */
export type EnginePurpose = EngineSessionSettings["purpose"];

/**
 * Where a workspace lives, which decides the engine that works on it: the
 * one on this computer, or (later) one inside the Blame Runtime VM.
 */
export type EngineLocation = "host" | "vm";

/** A workspace as the renderer names it; the host picks the engine for it. */
export type EngineWorkspace = { root: string; location: EngineLocation };

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

/** How a story's worktree is run (`UserStory.workspaceMode`). */
export type StoryWorkspaceMode = "direct" | "local-container" | "cloud-mirror";

/** What the renderer decides about a development story's agent. */
export type DevelopmentStorySettings = {
  workspace: EngineWorkspace;
  workspaceMode: StoryWorkspaceMode;
  projectId: string;
  storyId: string;
  /** The story's title, shown to the agent with its first message. */
  title: string;
  model: EngineModelChoice;
  maxContextTokens?: number;
  personalization?: Partial<AgentPersonalization>;
  codePractices?: ProjectCodePracticePreference[];
  /** The story's managed preview, when it has one (its devtools scope). */
  previewDevtoolsScope?: string;
};

/** Plan mode: an agent that reads the project and proposes stories. */
export type PlanSettings = {
  workspace: EngineWorkspace;
  projectId: string;
  model: EngineModelChoice;
  maxContextTokens?: number;
  personalization?: Partial<AgentPersonalization>;
};

/**
 * The new-project assistant: it helps pick a stack, in a scratch folder the
 * host makes for the conversation (there is no project yet).
 */
export type NewProjectSettings = {
  /** The project's working name. */
  title: string;
  model: EngineModelChoice;
  personalization?: Partial<AgentPersonalization>;
};

export type EngineSessionSettings =
  | { purpose: "quick-chat"; settings: QuickChatSettings }
  | { purpose: "development-story"; settings: DevelopmentStorySettings }
  | { purpose: "plan"; settings: PlanSettings }
  | { purpose: "new-project"; settings: NewProjectSettings };

/** Where a session's engine is, for calls that name only the session (default: this computer). */
export type EngineSessionRef = {
  session: SessionId;
  location?: EngineLocation;
};

/** A session as its records say, without following it. */
export type EngineSessionStatus = {
  session: SessionId;
  /** The engine has the session (on this computer or in Blame's database). */
  exists: boolean;
  running: boolean;
  /** How its last turn ended, when one did. */
  lastOutcome?: TurnOutcome;
  /**
   * What the agent said its last finished turn did: the summary it handed
   * finish_task, or else its last text. A pull request describes the story
   * with it.
   */
  lastReply?: string;
  turns: number;
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
    input: EngineSessionRef & {
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
  interrupt: { input: EngineSessionRef; result: null };
  compact: { input: EngineSessionRef; result: null };
  rewind: {
    input: EngineSessionRef & { to: Seq; restoreWorkspace: boolean };
    result: { finished: Seq };
  };
  undoRewind: { input: EngineSessionRef; result: null };
  resolveApproval: {
    input: EngineSessionRef & {
      call: ToolCallId;
      decision: "approved" | "denied";
    };
    result: boolean;
  };
  /** The caller names the subscription, so it can follow again after a host restart. */
  follow: {
    input: EngineSessionRef & { subscription: string };
    result: null;
  };
  unfollow: { input: { subscription: string }; result: null };
  running: { input: undefined; result: SessionId[] };
  /** Where each session stands, from its records (recovery after a quit). */
  status: {
    input: { sessions: SessionId[]; location?: EngineLocation };
    result: EngineSessionStatus[];
  };
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
  "status",
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
export type EngineDesktopMethods = DesktopServiceMethods;

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
  /** The host no longer waits for this desktop request: stop its work. */
  | { kind: "desktop-cancel"; id: number }
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
    kind === "desktop-cancel" ||
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
  follow(
    session: SessionId,
    onEvent: (event: FollowEvent) => void,
    location?: EngineLocation,
  ): () => void;
  /** Turns starting and ending in any session. */
  onActivity(callback: (event: EngineActivityEvent) => void): () => void;
};
