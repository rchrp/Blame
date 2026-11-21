// What the UI renders, computed from a session's records and live deltas.
// Every object here is immutable: a change replaces the object, so a view
// layer can skip whatever kept its identity.

import type {
  CheckpointId,
  ErrorInfo,
  JsonValue,
  ModelRef,
  NoticeLevel,
  RequestId,
  Seq,
  SessionActivity,
  SessionConfig,
  StopReason,
  ToolCallId,
  ToolEffect,
  ToolOutcome,
  ToolResultBlock,
  TurnId,
  TurnOutcome,
  Usage,
  UserBlock,
  WorkspaceRestore,
} from "../protocol.js";
import type { PlanChange, PlanView } from "./plan.js";

/** Token counts and cost, summed. Absent counters count as zero. */
export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  /** Millionths of a US dollar, over the requests that were priced. */
  readonly costMicroUsd: number;
  /** Replies and compactions counted. */
  readonly requests: number;
  /** Of those, how many came without a price (so `costMicroUsd` is a floor). */
  readonly unpricedRequests: number;
}

/** Where the workspace and the conversation can be put back to. */
export interface RewindTarget {
  /** `to` of `session/rewind`: the last record that stays, just before this message. */
  readonly to: Seq;
  /** A checkpoint exists, so the files can be restored too (`restore_workspace`). */
  readonly workspace: boolean;
}

export interface MessageInfo {
  /** Seq of the `AssistantMessage` record. */
  readonly seq: Seq;
  readonly request: RequestId;
  readonly model: ModelRef | undefined;
  /** Which try of the request produced it (1 unless earlier ones failed). */
  readonly attempt: number;
  readonly stop: StopReason;
  readonly usage: Usage;
  /** Visible blocks of the message, to tell its last one (where usage is shown). */
  readonly blockCount: number;
}

interface ItemBase {
  /** Stable across updates and unique within the transcript. */
  readonly key: string;
  /** Seq of the record that created the item. */
  readonly seq: Seq;
  readonly atMs: number;
}

export interface UserItem extends ItemBase {
  readonly kind: "user";
  readonly turn: TurnId;
  readonly blocks: readonly UserBlock[];
  /** `steer` joins the running turn at its next request. */
  readonly delivery: "turn" | "steer";
  /** Steer only: the model has been given it (a request started since). */
  readonly delivered: boolean;
  /** Opening messages only. */
  readonly rewind: RewindTarget | undefined;
}

export interface TextItem extends ItemBase {
  readonly kind: "text";
  readonly turn: TurnId;
  readonly block: number;
  readonly text: string;
  readonly message: MessageInfo;
}

export interface ReasoningItem extends ItemBase {
  readonly kind: "reasoning";
  readonly turn: TurnId;
  readonly block: number;
  /** Empty when the provider hides its reasoning. */
  readonly text: string;
  readonly message: MessageInfo;
}

export type ToolCallState =
  /** The model asked; nothing has happened yet. */
  | "requested"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  /** The engine died while it ran: what it did is unknown. */
  | "interrupted";

export type ApprovalState = "none" | "requested" | "approved" | "denied";

export interface ToolCallItem extends ItemBase {
  readonly kind: "tool_call";
  readonly turn: TurnId;
  readonly block: number;
  readonly call: ToolCallId;
  readonly name: string;
  readonly input: JsonValue;
  readonly state: ToolCallState;
  readonly approval: ApprovalState;
  readonly effect: ToolEffect | undefined;
  /** More than one when recovery ran the call again. */
  readonly starts: number;
  readonly startedAtMs: number | undefined;
  readonly finishedAtMs: number | undefined;
  readonly outcome: ToolOutcome | undefined;
  /** The call's single result: the first `ToolCallFinished` for it. */
  readonly result: readonly ToolResultBlock[] | undefined;
  /** The turn ended (or was cut by a rewind) before the call produced a result. */
  readonly endedWithoutResult: boolean;
  readonly message: MessageInfo | undefined;
}

export interface RequestFailedItem extends ItemBase {
  readonly kind: "request_failed";
  readonly turn: TurnId;
  readonly request: RequestId;
  readonly attempt: number;
  readonly error: ErrorInfo;
  /** The same request was sent again after this failure. */
  readonly retried: boolean;
}

export interface TurnEndedItem extends ItemBase {
  readonly kind: "turn_ended";
  readonly turn: TurnId;
  readonly outcome: TurnOutcome;
}

export interface CompactionItem extends ItemBase {
  readonly kind: "compaction";
  /** Records up to here are summarised for the model; they stay in the transcript. */
  readonly through: Seq;
  readonly summary: string;
  readonly usage: Usage;
}

export interface NoticeItem extends ItemBase {
  readonly kind: "notice";
  readonly level: NoticeLevel;
  readonly code: string;
  readonly text: string;
}

export interface ModelChangedItem extends ItemBase {
  readonly kind: "model_changed";
  readonly model: ModelRef;
  readonly previous: ModelRef | undefined;
}

/** Where a rewind cut the conversation. What it removed is no longer in `items`. */
export interface RewindItem extends ItemBase {
  readonly kind: "rewind";
  /** The last record that stayed. */
  readonly to: Seq;
  readonly workspace: WorkspaceRestore;
  /** Commands the removed turns ran, whose effects outside the tracked files stay. */
  readonly unrevertedCommands: readonly string[];
}

export type TranscriptItem =
  | UserItem
  | TextItem
  | ReasoningItem
  | ToolCallItem
  | RequestFailedItem
  | TurnEndedItem
  | CompactionItem
  | NoticeItem
  | ModelChangedItem
  | RewindItem;

export type TurnStatus =
  /** Waiting behind the running turn. */
  | "queued"
  | "running"
  | "completed"
  | "interrupted"
  | "limit_reached"
  | "failed"
  /** A rewind cut the log while it was open. */
  | "rewound"
  /**
   * A queued message the user took back before it ran (removed, or sent
   * into the running turn instead): not a turn of the conversation.
   */
  | "withdrawn";

export interface TurnView {
  readonly turn: TurnId;
  /** Seq of the message that opened it; absent when the transcript starts mid-turn. */
  readonly userSeq: Seq | undefined;
  readonly startedAtMs: number;
  readonly status: TurnStatus;
  readonly outcome: TurnOutcome | undefined;
  readonly endedAtMs: number | undefined;
  readonly checkpoint: CheckpointId | undefined;
  /** Distinct model requests sent (retries of one count once). */
  readonly requests: number;
  readonly usage: UsageTotals;
}

/** A turn whose start can be restored: the files were snapshotted when it opened. */
export interface CheckpointView {
  readonly turn: TurnId;
  readonly checkpoint: CheckpointId;
  /**
   * The checkpointer's reference to the files as they were (for git, a tree
   * in the workspace's repository): what a turn's changes are diffed from.
   */
  readonly snapshot: string;
  /** The message that opened the turn. */
  readonly userSeq: Seq;
  /** `to` of `session/rewind` to restore the workspace as it was before that message. */
  readonly to: Seq;
}

export interface LiveBlock {
  readonly index: number;
  readonly kind: "text" | "reasoning" | "tool_call";
  /** What has streamed so far. */
  readonly text: string;
  readonly call: ToolCallId | undefined;
  readonly tool: string | undefined;
  /** The tool call's input JSON as far as it has arrived (often not yet parseable). */
  readonly inputJson: string;
}

/** The reply being streamed right now. Replaced by the stored records that follow. */
export interface LiveReply {
  readonly request: RequestId;
  readonly blocks: readonly LiveBlock[];
}

export interface Transcript {
  /** Seq of the last record applied. */
  readonly lastSeq: Seq;
  readonly config: SessionConfig | undefined;
  /** In order, everything a rewind has not removed. */
  readonly items: readonly TranscriptItem[];
  /** In the order they were opened. */
  readonly turns: readonly TurnView[];
  /** The turn that is running, if any. */
  readonly runningTurn: TurnId | undefined;
  /** Calls waiting for the user's decision, oldest first. */
  readonly pendingApprovals: readonly ToolCallItem[];
  readonly checkpoints: readonly CheckpointView[];
  readonly usage: {
    /** Of the records in effect. */
    readonly total: UsageTotals;
    /** Of every record ever applied, rewound ones included: what was actually spent. */
    readonly spent: UsageTotals;
  };
  /** Records up to here are summarised for the model. */
  readonly compactedThrough: Seq | undefined;
  /** The `RewindFinished` an undo would reverse: only the very next record may undo it. */
  readonly undoableRewind: Seq | undefined;
  readonly activity: SessionActivity;
  readonly live: LiveReply | undefined;
  /** Output of tools still running, by call. */
  readonly toolProgress: ReadonlyMap<ToolCallId, string>;
  /** The agent's plan now: the latest `update_plan` call that completed. */
  readonly plan: PlanView | undefined;
  /** What each completed `update_plan` call did to the plan before it. */
  readonly planChanges: ReadonlyMap<ToolCallId, PlanChange>;
}
