// The contract between the renderer, the main process and the engine host
// (docs/engine-in-the-app.md). Types and a few pure helpers only: the main
// process and the renderer import this file, and neither may load the
// engine host's code.

import type {
  FollowEvent,
  PlanProgress,
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
  CredentialStorage,
  MoveProviderCredentialInput,
  SubscriptionUsage,
} from "../types.js";
import { engineTaskMethods, type EngineTaskMethods } from "./task-protocol.js";
import type { EngineStoryMethods, StoryHostEvent } from "./story-protocol.js";
import type {
  EpicState,
  OrchestratorSettings,
} from "./orchestrator-protocol.js";

export type * from "./task-protocol.js";
export type * from "./story-protocol.js";
export type * from "./orchestrator-protocol.js";
export {
  orchestratorToolNames,
  orchestratorWakeTag,
  orchestratorWakeText,
  parseOrchestratorWake,
} from "./orchestrator-protocol.js";
// The orchestrator's choice of a story's model, for the screen too (pure).
export { escalateModel, resolveModelIntent } from "./model-intent.js";
export type {
  ModelEscalationInput,
  ModelIntentInput,
  ModelIntentResolution,
  ModelKey,
  ModelPool,
  ModelRange,
  ModelResolution,
} from "./model-intent.js";
export { engineMainOnlyMethods } from "./task-protocol.js";
// What the app answers the self-repair tools (`blameApp` service).
export type { BlameAppLog, BlameAppState } from "./tools/blame-types.js";
import type { DesktopServiceMethods } from "./desktop-services.js";
import type { PreviewInitialization } from "../preview-selection.js";

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
  /**
   * The project's saved preview environment, which decides the story's
   * preview tools (its surface and manifest).
   */
  projectInitialization?: PreviewInitialization;
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
  | { purpose: "new-project"; settings: NewProjectSettings }
  /** An epic's conversation (docs/orchestrator.md). */
  | { purpose: "orchestrator"; settings: OrchestratorSettings };

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
  /** How far the agent's plan is; absent without one. */
  plan?: PlanProgress;
  /** How many turns each model answered (`turnsByModel`), in order of first use. */
  models: Array<{ providerId: string; modelId: string; turns: number }>;
  /** A turn runs, as the records say (a compaction is not a turn). */
  turnRunning?: boolean;
  /** The last turns that ended (at most 100), oldest first, with how and what the agent said. */
  endedTurns?: Array<{ turn: string; outcome: TurnOutcome; reply?: string }>;
  /** What its requests cost, rewound ones included (micro-USD). */
  spentMicroUsd?: number;
  /** Requests the catalog had no price for: `spentMicroUsd` is a floor. */
  unpricedRequests?: number;
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
  /** Read by the model with the message, never shown in the conversation. */
  context?: string;
  /** Ultra mode is on for this message: the agent may start helper agents. */
  ultra?: boolean;
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
  /** Takes back a message queued behind the running turn, before it runs. */
  withdraw: { input: EngineSessionRef & { turn: string }; result: null };
  /** Sends a queued message into the running turn now (once). */
  promote: {
    input: EngineSessionRef & { turn: string };
    result: { turn: string };
  };
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
  /** Moves a credential to Blame's account or to this computer's keychain. */
  moveCredential: {
    input: MoveProviderCredentialInput;
    result: ProviderCredentialSummary;
  };
  /** Whether this computer can keep credentials in its keychain. */
  credentialStorage: { input: undefined; result: { device: boolean } };
  /** The ChatGPT sign-in in the browser, kept in the API or on this computer. */
  signInChatGpt: {
    input: { label?: string; storage?: CredentialStorage };
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
  /** The skills a user may start with `/name` in a workspace (the composers' picker). */
  listSkills: {
    input: { workspaceRoot: string };
    result: {
      name: string;
      description?: string;
      argumentHint?: string;
    }[];
  };
  shutdown: { input: undefined; result: null };
  /** An epic's conversation, spend and unreported turns (docs/orchestrator.md). */
  epicState: { input: { epicId: string }; result: EpicState };
  /**
   * The window changed an epic in the API (its settings, a pause, a
   * resume): the host reads it again, holds or releases its queued
   * stories, and wakes the orchestrator if that is due.
   */
  epicChanged: { input: { epicId: string }; result: EpicState };
} & EngineTaskMethods &
  EngineStoryMethods;

export type EngineHostMethod = keyof EngineHostMethods;
export type EngineHostInput<M extends EngineHostMethod> =
  EngineHostMethods[M]["input"];
export type EngineHostResult<M extends EngineHostMethod> =
  EngineHostMethods[M]["result"];

/** The story service's calls (`story-protocol.ts`). */
export const engineStoryMethods = [
  "storySync",
  "storyWindowClosed",
  "storyRefresh",
  "storyRetry",
  "storyQueueState",
  "storyEnqueue",
  "storySend",
  "storyPause",
  "storyResume",
  "storyRewind",
  "storyApprove",
  "storyComplete",
  "storyToBacklog",
  "storyDiscard",
  "storyDelete",
  "storyError",
] as const satisfies readonly (keyof EngineStoryMethods)[];

/** Story calls only the main process makes. */
export const engineStoryMainOnlyMethods = [
  "storyWindowClosed",
] as const satisfies readonly (keyof EngineStoryMethods)[];

export const engineHostMethods = [
  "connect",
  "createSession",
  "configure",
  "send",
  "interrupt",
  "withdraw",
  "promote",
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
  "moveCredential",
  "credentialStorage",
  "signInChatGpt",
  "claudeCodeStatus",
  "connectClaudeCode",
  "planUsage",
  "listSkills",
  "shutdown",
  "status",
  "epicState",
  "epicChanged",
  ...engineTaskMethods,
  ...engineStoryMethods,
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
      /** The folder the session works in, when the host knows it. */
      workspace?: string;
    }
  /** How far a followed session's plan is, each time it moves. */
  | { type: "plan"; session: SessionId; plan: PlanProgress | undefined }
  /** An epic's state changed (`epicState`); no `projectId`: story listeners skip it. */
  | { type: "epic"; epicId: string; state: EpicState }
  | StoryHostEvent;

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
 * Whether a model's conversation may start helper agents (ultra mode). Each
 * helper of Claude Code would be a whole Claude Code process, so the engine
 * offers the tool and refuses the call there.
 */
export function helperAgentsAvailable(providerId: string) {
  return providerId !== "claude-code";
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

export type EnginePlanEvent = Extract<EngineHostEvent, { type: "plan" }>;

export type EngineStoryEvent = StoryHostEvent;

export type EngineEpicEvent = Extract<EngineHostEvent, { type: "epic" }>;

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
  /** The progress of the plans of the sessions the host follows. */
  onPlan(callback: (event: EnginePlanEvent) => void): () => void;
  /** Stories the story service changed, and its queue. */
  onStory(callback: (event: EngineStoryEvent) => void): () => void;
  /** Epics whose state changed (the orchestrator's conversation, spend). */
  onEpic?(callback: (event: EngineEpicEvent) => void): () => void;
};
