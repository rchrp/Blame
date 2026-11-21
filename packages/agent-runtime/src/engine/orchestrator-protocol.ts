// The orchestrator's contract with the windows (docs/orchestrator.md): the
// settings a window sends with each message, the epic as the host reads it,
// the state and spend the screen shows, each tool's input, and the host's
// wake message. Types and pure helpers only: the main process and the
// renderer import this file through `engine/protocol.ts`.

import type { TurnOutcome, UserBlock } from "@blame/engine-client";
import type { AgentPersonalization } from "../personalization.js";
import type { ModelIntent, ModelKey, ModelRange } from "./model-intent.js";
import type { EngineModelChoice, EngineWorkspace } from "./protocol.js";

export type { ModelIntent } from "./model-intent.js";

export type EpicStatus = "active" | "paused" | "completed" | "discarded";

/** The epic's settings, as the screen writes them (`epic.settings`). */
export type EpicSettings = {
  /** The model the orchestrator runs on; the account's agent model without it. */
  orchestratorModel?: EngineModelChoice;
  /** The slice of the smart ranking stories may use, 0 (cheapest) to 1. */
  modelRange?: ModelRange;
  /** The providers stories may use; empty or absent: every connected one. */
  providers?: string[];
  /** The models the person hid in the model selector. */
  hiddenModels?: ModelKey[];
  /** What the epic may spend, stories and orchestrator together. */
  budgetMicroUsd?: number;
  /** Starting stories and approving a merge wait for the person's Allow. */
  askBeforeLaunch?: boolean;
};

/** An epic as the API keeps it (`/projects/epics`). */
export type Epic = {
  id: string;
  projectId: string;
  title: string;
  goal: string | null;
  status: EpicStatus;
  branch: string | null;
  targetBranch: string | null;
  engineSessionId: string | null;
  settings: EpicSettings;
  mergedAt: string | null;
  mergeCommit: string | null;
};

/**
 * What a window sends with each message to an epic's conversation (purpose
 * `orchestrator`). The host reads the epic and its settings itself.
 */
export type OrchestratorSettings = {
  /** The project folder, read only. */
  workspace: EngineWorkspace;
  projectId: string;
  epicId: string;
  /**
   * The orchestrator's model as the window shows it: the epic's
   * `orchestratorModel`, else the account's agent model. The epic's own
   * setting wins when it has one.
   */
  model: EngineModelChoice;
  maxContextTokens?: number;
  personalization?: Partial<AgentPersonalization>;
};

/**
 * Where the epic's conversation stands, from its records:
 * - `idle`: no turn yet;
 * - `working`: a turn runs (or a message waits behind one);
 * - `waiting`: it ended with `end_turn` `wait` and sleeps until woken;
 * - `asking`: it ended with `ask` and waits for the person's answer;
 * - `finished`: it ended with `finish`, the epic waits for the person's review;
 * - `stopped`: the person stopped its turn;
 * - `failed`: its turn failed, hit a limit or never ended through `end_turn`.
 */
export type OrchestratorConversationState =
  "idle" | "working" | "waiting" | "asking" | "finished" | "stopped" | "failed";

/** One story's spend, from its session's records (micro-USD). */
export type EpicStorySpend = {
  storyId: string;
  microUsd: number;
  /** Requests the catalog had no price for: the amount is a floor. */
  unpricedRequests: number;
};

/** What the epic spent: its stories and its orchestrator, from their records. */
export type EpicSpend = {
  orchestratorMicroUsd: number;
  storiesMicroUsd: number;
  totalMicroUsd: number;
  /** Absent without a budget. */
  budgetMicroUsd?: number;
  remainingMicroUsd?: number;
  /** The budget is spent: no story starts and no message goes to one. */
  spent: boolean;
  unpricedRequests: number;
  stories: EpicStorySpend[];
};

/** What the screen shows of an epic besides its stories (`epicState`, `epic` events). */
export type EpicState = {
  epicId: string;
  /** The epic's conversation; absent before it is created. */
  session?: string;
  conversation: OrchestratorConversationState;
  /** Why it is `failed`. */
  error?: string;
  /** The question of an `ask`, with its options. */
  question?: { text: string; options: string[] };
  /** The summary of a `finish`. */
  summary?: string;
  /** Story turns that ended and that the orchestrator has not heard of yet. */
  unreported: number;
  /** Queued stories only the person can start, and why (the epic needs them). */
  blocked?: EpicBlockedStory[];
  spend: EpicSpend;
};

/** A queued story of the epic that will not start by itself. */
export type EpicBlockedStory = {
  storyId: string;
  /** `US-004`. */
  number: string;
  title: string;
  /** Why, in words (a start that keeps failing gives its error). */
  reason: string;
};

/** The intent a story's model was chosen by. */
export type StoryIntent = ModelIntent;

/** A story `create_stories` creates. */
export type OrchestratorNewStory = {
  /** The orchestrator's own name for it, for `startsAfter` within one call. */
  key: string;
  title: string;
  /** What the agent reads first: the goal, what exists, done, out of scope, when to ask. */
  brief: string;
  /** Keys of this call or ids of the epic's stories it starts after. */
  startsAfter?: string[];
  intent: StoryIntent;
  /** Created in the backlog instead of the queue; `update_story` queues it. */
  hold?: boolean;
};

/** Each tool's input, as the model sends it and the transcript keeps it. */
export type OrchestratorToolInputs = {
  epic_board: Record<string, never>;
  create_stories: { reason: string; stories: OrchestratorNewStory[] };
  update_story: {
    reason: string;
    storyId: string;
    title?: string;
    brief?: string;
    startsAfter?: string[];
    intent?: StoryIntent;
    /** Queues a story that was held. */
    queue?: boolean;
  };
  story_report: { storyId: string };
  message_story: {
    reason: string;
    storyId: string;
    kind: "answer" | "changes";
    message: string;
    /** Runs this turn on the next model up. */
    escalate?: boolean;
  };
  approve_story: { reason: string; storyId: string };
  reject_story: { reason: string; storyId: string };
  end_turn: {
    action: "wait" | "ask" | "finish";
    reason: string;
    /** `ask`: the question for the person. */
    question?: string;
    /** `ask`: the answers to offer. */
    options?: string[];
    /** `finish`: the epic's summary for the person's review. */
    summary?: string;
  };
};

export type OrchestratorTool = keyof OrchestratorToolInputs;

export const orchestratorToolNames = [
  "epic_board",
  "create_stories",
  "update_story",
  "story_report",
  "message_story",
  "approve_story",
  "reject_story",
  "end_turn",
] as const satisfies readonly OrchestratorTool[];

/** The board's counts, by what the person or the orchestrator owes. */
export type EpicBoardCounts = {
  working: number;
  queued: number;
  held: number;
  inReview: number;
  paused: number;
  merged: number;
  rejected: number;
};

/** One story's ended turn, as the wake tells it. */
export type OrchestratorWakeStory = {
  storyId: string;
  /** `US-004`. */
  number: string;
  title: string;
  /** The story's session and the turn in it: each is told once. */
  session: string;
  turn: string;
  outcome: TurnOutcome["status"];
  /** Its finish_task was accepted: the harness verified the work. */
  verified: boolean;
  /** The checks that still failed when it stopped. */
  failingChecks?: string[];
  error?: string;
  /** The story's status once the turn's end was applied. */
  status: string;
  /** The first lines of the agent's reply. */
  reply?: string;
};

/**
 * The host's message to the orchestrator: never the person's. It is one
 * `context` block (no `text` block) whose text is `<orchestrator_wake>`, a
 * JSON line, `</orchestrator_wake>`: `parseOrchestratorWake` reads it back.
 * - `stories`: story turns ended (no story of the epic works any more, or
 *   one ended that another starts after);
 * - `resumed`: Blame stopped while the orchestrator worked (a quit, a
 *   crash): it goes on from the board;
 * - `idle`: it waits, and no story of the epic works or can start any more
 *   with no ended turn to tell (a story deleted from the board).
 */
export type OrchestratorWake = {
  reason: "stories" | "resumed" | "idle";
  stories: OrchestratorWakeStory[];
  board: EpicBoardCounts;
  /** Queued stories only the person can start, and why. */
  blocked?: EpicBlockedStory[];
  budget?: { spent: boolean; remainingMicroUsd?: number };
};

export const orchestratorWakeTag = "orchestrator_wake";

const wakeOpen = `<${orchestratorWakeTag}>`;
const wakeClose = `</${orchestratorWakeTag}>`;

/** The text of the host's wake message (its one context block). */
export function orchestratorWakeText(wake: OrchestratorWake): string {
  const note =
    wake.reason === "resumed"
      ? "Blame stopped while you were working. Read the board and go on."
      : wake.reason === "idle"
        ? "No story of the epic works or will start by itself. Read the board; ask the person for what only they can fix."
        : "Stories you started ended a turn. Call story_report for one's full report.";
  return `${wakeOpen}\n${note}\n${JSON.stringify(wake)}\n${wakeClose}`;
}

/**
 * The wake a user message carries, when it is the host's: exactly one
 * `context` block holding the wake. A message the person wrote always has
 * a text block, so it is never read as one.
 */
export function parseOrchestratorWake(
  blocks: readonly UserBlock[],
): OrchestratorWake | undefined {
  if (blocks.length !== 1) return undefined;
  const [block] = blocks;
  if (block?.type !== "context") return undefined;
  const text = block.text.trim();
  if (!text.startsWith(wakeOpen) || !text.endsWith(wakeClose)) return undefined;
  const line = text
    .slice(wakeOpen.length, -wakeClose.length)
    .trim()
    .split("\n")
    .at(-1);
  try {
    const wake = JSON.parse(line ?? "") as OrchestratorWake;
    return wake && Array.isArray(wake.stories) ? wake : undefined;
  } catch {
    return undefined;
  }
}
