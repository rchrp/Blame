import type {
  AssistantBlock,
  Delta,
  RecordBody,
  RequestId,
  Seq,
  SessionActivity,
  SessionConfig,
  SessionRecord,
  ToolCallId,
  TurnId,
  TurnOutcome,
} from "../protocol.js";
import { LiveState } from "./live.js";
import type {
  CheckpointView,
  MessageInfo,
  ToolCallItem,
  ToolCallState,
  Transcript,
  TranscriptItem,
  TurnStatus,
  TurnView,
  UsageTotals,
} from "./model.js";
import { NO_USAGE, addUsage } from "./usage.js";

type Undo = () => void;

/** One record in effect (or the cut a rewind left), with what it takes to take it back. */
interface Entry {
  readonly seq: Seq;
  readonly record: SessionRecord;
  /** The cut left by a `RewindFinished` rather than a record of its own. */
  readonly boundary: boolean;
  readonly undos: Undo[];
}

/** What the latest rewind removed, while the very next record can still undo it. */
interface Undoable {
  readonly finished: Seq;
  readonly removed: Entry[];
}

/** The small, copied-on-write part of the state. */
interface Scalars {
  readonly config: SessionConfig | undefined;
  readonly compactedThrough: Seq | undefined;
  readonly total: UsageTotals;
  /** Turns opened and not ended, oldest first: the first runs, the others wait. */
  readonly open: readonly TurnId[];
  /** The request in flight as the log knows it, to attribute its reply. */
  readonly current:
    | { request: RequestId; attempt: number; model: MessageInfo["model"] }
    | undefined;
  /** The last failure, until the request is sent again. */
  readonly retry: { request: RequestId; index: number } | undefined;
  /** Steer messages the model has not been given yet, as item indexes. */
  readonly steers: readonly number[];
}

const INITIAL: Scalars = {
  config: undefined,
  compactedThrough: undefined,
  total: NO_USAGE,
  open: [],
  current: undefined,
  retry: undefined,
  steers: [],
};

/**
 * Folds a session's records into what the UI shows, one record at a time.
 *
 * Which records are in effect follows the engine's own reading of the log
 * (`effective` in blame-engine-core's projection): a `RewindFinished` removes
 * every record after its `to` and leaves a cut; a `RewindUndone` right after
 * it puts them back; anything else in between makes the rewind final.
 *
 * Applying a record costs time in proportion to what it touches. A rewind
 * (and its undo) costs in proportion to the records removed (or restored),
 * because each record in effect keeps the inverse of its own changes instead
 * of the transcript being rebuilt. Deltas never touch the stored part.
 *
 * The reducer is deterministic and does no I/O: the same records and deltas,
 * in the same order, always give the same transcript.
 */
export class TranscriptReducer {
  private entries: Entry[] = [];
  private undoable: Undoable | undefined;
  private lastApplied: Seq = 0;
  private current: Undo[] = [];

  private items: TranscriptItem[] = [];
  private callIndex = new Map<ToolCallId, number>();
  private turnIndex = new Map<TurnId, number>();
  private turns = new Map<TurnId, TurnView>();
  private turnOrder: TurnId[] = [];
  private userIndex = new Map<TurnId, number>();
  private awaiting: ToolCallId[] = [];
  private checkpoints: CheckpointView[] = [];
  private s: Scalars = INITIAL;
  private spent: UsageTotals = NO_USAGE;

  private readonly live = new LiveState();
  private dirty = true;
  private snapshotCache: Transcript | undefined;
  private liveVersion = 0;
  private snapshotLiveVersion = -1;

  /** Seq of the last record applied. */
  get lastSeq(): Seq {
    return this.lastApplied;
  }

  /**
   * Applies the next record. A record at or below `lastSeq` was seen before
   * and is ignored, so replaying overlapping pages is harmless. Returns
   * whether it was applied.
   */
  applyRecord(record: SessionRecord): boolean {
    if (record.seq <= this.lastApplied) return false;
    this.lastApplied = record.seq;
    this.dirty = true;
    const body = record;
    switch (body.type) {
      case "rewind_started":
        this.undoable = undefined;
        return true;
      case "rewind_finished":
        this.finishRewind(record);
        return true;
      case "rewind_undone":
        this.undoRewind(record);
        return true;
    }
    this.spend(body);
    this.enter(record, false);
    this.undoable = undefined;
    return true;
  }

  applyRecords(records: readonly SessionRecord[]): void {
    for (const record of records) this.applyRecord(record);
  }

  /** Applies one live delta. Deltas are not stored and are not part of a rewind. */
  applyDelta(delta: Delta): void {
    this.live.apply(delta);
    this.liveVersion++;
  }

  /** Sets what the session is doing, from a `Subscribed` result. */
  setActivity(activity: SessionActivity): void {
    this.live.activity = activity;
    this.liveVersion++;
  }

  /** Drops the stream in progress before replaying `in_flight` deltas after a reconnect. */
  resetLive(): void {
    this.live.reset();
    this.liveVersion++;
  }

  /** Seqs of the records in effect, in order; a rewind's cut appears as its `RewindFinished` seq. */
  effectiveSeqs(): Seq[] {
    return this.entries.map((entry) => entry.seq);
  }

  /**
   * The transcript now. Cheap when nothing changed since the last call, and
   * deltas alone do not copy the stored part, so a view can call it every
   * frame.
   */
  snapshot(): Transcript {
    if (
      this.snapshotCache &&
      !this.dirty &&
      this.snapshotLiveVersion === this.liveVersion
    ) {
      return this.snapshotCache;
    }
    const previous = this.snapshotCache;
    const stored = this.dirty || !previous;
    this.snapshotCache = {
      lastSeq: this.lastApplied,
      config: this.s.config,
      items: stored ? this.items.slice() : previous.items,
      turns: stored
        ? this.turnOrder.map((turn) => this.turns.get(turn)!)
        : previous.turns,
      runningTurn: this.s.open[0],
      pendingApprovals: stored
        ? this.awaiting.map(
            (call) => this.items[this.callIndex.get(call)!] as ToolCallItem,
          )
        : previous.pendingApprovals,
      checkpoints: stored ? this.checkpoints.slice() : previous.checkpoints,
      usage: stored
        ? { total: this.s.total, spent: this.spent }
        : previous.usage,
      compactedThrough: this.s.compactedThrough,
      undoableRewind: this.undoable?.finished,
      activity: this.live.activity,
      live: this.live.reply(),
      toolProgress: this.live.toolProgress(),
    };
    this.dirty = false;
    this.snapshotLiveVersion = this.liveVersion;
    return this.snapshotCache;
  }

  // -- the log: which records are in effect ---------------------------------

  /** Puts one record (or the cut of a rewind) in effect. */
  private enter(record: SessionRecord, boundary: boolean): void {
    const undos: Undo[] = [];
    this.current = undos;
    if (boundary) this.applyBoundary(record);
    else this.applyRecordEffect(record);
    this.entries.push({ seq: record.seq, record, boundary, undos });
  }

  private takeBack(entry: Entry): void {
    for (let i = entry.undos.length - 1; i >= 0; i--) entry.undos[i]!();
  }

  private finishRewind(record: SessionRecord): void {
    if (record.type !== "rewind_finished") return;
    const to = record.to;
    // Seqs only grow along the log, so the records after `to` are a suffix.
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.entries[middle]!.seq <= to) low = middle + 1;
      else high = middle;
    }
    const removed = this.entries.splice(low);
    for (let i = removed.length - 1; i >= 0; i--) this.takeBack(removed[i]!);
    this.enter(record, true);
    this.undoable = { finished: record.seq, removed };
    this.live.reset();
    this.liveVersion++;
  }

  private undoRewind(record: SessionRecord): void {
    if (record.type !== "rewind_undone") return;
    const undoable = this.undoable;
    this.undoable = undefined;
    if (!undoable || undoable.finished !== record.rewind) return;
    this.takeBack(this.entries.pop()!);
    for (const entry of undoable.removed)
      this.enter(entry.record, entry.boundary);
    this.live.reset();
    this.liveVersion++;
  }

  // -- journaled changes: every change registers how to take it back ---------

  private journal(undo: Undo): void {
    this.current.push(undo);
  }

  private setScalars(patch: Partial<Scalars>): void {
    const before = this.s;
    this.s = { ...before, ...patch };
    this.journal(() => {
      this.s = before;
    });
  }

  private append(item: TranscriptItem): number {
    const index = this.items.push(item) - 1;
    this.journal(() => {
      this.items.pop();
    });
    return index;
  }

  private replace(index: number, item: TranscriptItem): void {
    const before = this.items[index]!;
    this.items[index] = item;
    this.journal(() => {
      this.items[index] = before;
    });
  }

  private put<K, V>(map: Map<K, V>, key: K, value: V): void {
    const had = map.has(key);
    const before = map.get(key);
    map.set(key, value);
    this.journal(() => {
      if (had) map.set(key, before as V);
      else map.delete(key);
    });
  }

  private push<T>(list: T[], value: T): void {
    list.push(value);
    this.journal(() => {
      list.pop();
    });
  }

  private removeAwaiting(call: ToolCallId): void {
    const at = this.awaiting.indexOf(call);
    if (at === -1) return;
    this.awaiting.splice(at, 1);
    this.journal(() => {
      this.awaiting.splice(at, 0, call);
    });
  }

  // -- what each record means ------------------------------------------------

  private applyRecordEffect(record: SessionRecord): void {
    const at = record.at_ms;
    const body: RecordBody = record;
    switch (body.type) {
      case "session_created":
        this.setScalars({ config: body.config });
        return;
      case "config_changed": {
        const previous = this.s.config?.model;
        const next = body.config.model;
        if (
          !previous ||
          previous.provider !== next.provider ||
          previous.model !== next.model
        ) {
          this.append({
            kind: "model_changed",
            key: String(record.seq),
            seq: record.seq,
            atMs: at,
            model: next,
            previous,
          });
        }
        this.setScalars({ config: body.config });
        return;
      }
      case "user_message":
        this.userMessage(record, body);
        return;
      case "checkpoint_created": {
        this.updateTurn(body.turn, record, (turn) => ({
          ...turn,
          checkpoint: body.checkpoint,
        }));
        const index = this.userIndex.get(body.turn);
        const user = index === undefined ? undefined : this.items[index];
        if (index !== undefined && user?.kind === "user" && user.rewind) {
          this.replace(index, {
            ...user,
            rewind: { ...user.rewind, workspace: true },
          });
          this.push(this.checkpoints, {
            turn: body.turn,
            checkpoint: body.checkpoint,
            snapshot: body.snapshot,
            userSeq: user.seq,
            to: user.rewind.to,
          });
        }
        return;
      }
      case "request_started":
        this.requestStarted(record, body);
        return;
      case "assistant_message":
        this.assistantMessage(record, body);
        return;
      case "request_failed": {
        this.live.requestClosed(body.request);
        const index = this.append({
          kind: "request_failed",
          key: String(record.seq),
          seq: record.seq,
          atMs: at,
          turn: body.turn,
          request: body.request,
          attempt:
            this.s.current?.request === body.request
              ? this.s.current.attempt
              : 1,
          error: body.error,
          retried: false,
        });
        this.setScalars({ retry: { request: body.request, index } });
        return;
      }
      case "approval_requested":
        this.updateTool(body.call, record, body.turn, (tool) => ({
          ...tool,
          approval: "requested",
        }));
        if (!this.awaiting.includes(body.call)) {
          this.push(this.awaiting, body.call);
        }
        return;
      case "approval_resolved":
        this.updateTool(body.call, record, body.turn, (tool) => ({
          ...tool,
          approval: body.decision === "approved" ? "approved" : "denied",
        }));
        this.removeAwaiting(body.call);
        return;
      case "tool_call_started":
        this.updateTool(
          body.call,
          record,
          body.turn,
          (tool) => ({
            ...tool,
            starts: tool.starts + 1,
            effect: body.effect,
            startedAtMs: tool.startedAtMs ?? at,
          }),
          body.name,
        );
        return;
      case "tool_call_finished": {
        this.updateTool(body.call, record, body.turn, (tool) =>
          // The call's single result is the first one stored.
          tool.result
            ? tool
            : {
                ...tool,
                outcome: body.outcome,
                result: body.content,
                finishedAtMs: at,
              },
        );
        this.removeAwaiting(body.call);
        this.live.toolFinished(body.call);
        return;
      }
      case "turn_ended":
        this.turnEnded(record, body);
        return;
      case "context_compacted":
        this.append({
          kind: "compaction",
          key: String(record.seq),
          seq: record.seq,
          atMs: at,
          through: body.through,
          summary: body.summary,
          usage: body.usage,
        });
        this.setScalars({
          compactedThrough: body.through,
          total: addUsage(this.s.total, body.usage),
        });
        return;
      case "context_edited":
        // Edits change what the model is shown, never what the user sees.
        return;
      case "notice":
        this.append({
          kind: "notice",
          key: String(record.seq),
          seq: record.seq,
          atMs: at,
          level: body.level,
          code: body.code,
          text: body.text,
        });
        return;
      case "contract_correction":
        // The engine told the model it may not stop yet: shown like a
        // notice, so a reader sees why the agent went on.
        this.append({
          kind: "notice",
          key: String(record.seq),
          seq: record.seq,
          atMs: at,
          level: "info",
          code: "contract_correction",
          text: body.text,
        });
        return;
      case "result_accepted":
      case "result_rejected":
        // The result call shows as completed or failed already.
        return;
      case "rewind_started":
      case "rewind_finished":
      case "rewind_undone":
        return;
    }
  }

  private spend(body: RecordBody): void {
    if (
      body.type === "assistant_message" ||
      body.type === "context_compacted"
    ) {
      this.spent = addUsage(this.spent, body.usage);
    }
  }

  private userMessage(
    record: SessionRecord,
    body: Extract<RecordBody, { type: "user_message" }>,
  ): void {
    const base = {
      key: String(record.seq),
      seq: record.seq,
      atMs: record.at_ms,
      turn: body.turn,
      blocks: body.input,
    };
    if (body.delivery === "steer") {
      const index = this.append({
        kind: "user",
        ...base,
        delivery: "steer",
        delivered: false,
        rewind: undefined,
      });
      this.setScalars({ steers: [...this.s.steers, index] });
      return;
    }
    // A repeated opening message of an open turn is not a second turn.
    if (this.s.open.includes(body.turn)) return;
    const opens = this.s.open.length === 0;
    const status: TurnStatus = opens ? "running" : "queued";
    this.put(this.turns, body.turn, {
      turn: body.turn,
      userSeq: record.seq,
      startedAtMs: record.at_ms,
      status,
      outcome: undefined,
      endedAtMs: undefined,
      checkpoint: undefined,
      requests: 0,
      usage: NO_USAGE,
    });
    if (!this.turnIndex.has(body.turn)) {
      this.put(this.turnIndex, body.turn, this.turnOrder.length);
      this.push(this.turnOrder, body.turn);
    }
    const index = this.append({
      kind: "user",
      ...base,
      delivery: "turn",
      delivered: true,
      rewind: { to: record.seq - 1, workspace: false },
    });
    this.put(this.userIndex, body.turn, index);
    this.setScalars({ open: [...this.s.open, body.turn] });
  }

  private requestStarted(
    record: SessionRecord,
    body: Extract<RecordBody, { type: "request_started" }>,
  ): void {
    this.live.requestStarted(body.request);
    const retry = this.s.retry;
    if (retry && retry.request === body.request) {
      const failed = this.items[retry.index];
      if (failed?.kind === "request_failed")
        this.replace(retry.index, { ...failed, retried: true });
    }
    // The model is given every pending steer with this request.
    for (const index of this.s.steers) {
      const steer = this.items[index];
      if (steer?.kind === "user")
        this.replace(index, { ...steer, delivered: true });
    }
    // A retry of the request in flight is the same request, not another one.
    const another = this.s.current?.request !== body.request;
    this.updateTurn(body.turn, record, (view) => ({
      ...view,
      requests: view.requests + (another ? 1 : 0),
    }));
    this.setScalars({
      current: {
        request: body.request,
        attempt: body.attempt,
        model: body.model,
      },
      retry: undefined,
      steers: [],
    });
  }

  private assistantMessage(
    record: SessionRecord,
    body: Extract<RecordBody, { type: "assistant_message" }>,
  ): void {
    this.live.requestClosed(body.request);
    const current =
      this.s.current?.request === body.request ? this.s.current : undefined;
    const visible = body.blocks.filter(isVisible);
    const message: MessageInfo = {
      seq: record.seq,
      request: body.request,
      model: current?.model,
      attempt: current?.attempt ?? 1,
      stop: body.stop,
      usage: body.usage,
      blockCount: visible.length,
    };
    body.blocks.forEach((block, index) => {
      const key = `${record.seq}:${index}`;
      const common = {
        key,
        seq: record.seq,
        atMs: record.at_ms,
        turn: body.turn,
        block: index,
      };
      switch (block.type) {
        case "text":
          this.append({ kind: "text", ...common, text: block.text, message });
          return;
        case "reasoning":
          this.append({
            kind: "reasoning",
            ...common,
            text: block.text,
            message,
          });
          return;
        case "tool_call": {
          const at = this.append({
            kind: "tool_call",
            ...common,
            call: block.call,
            name: block.name,
            input: block.input,
            state: "requested",
            approval: "none",
            effect: undefined,
            starts: 0,
            startedAtMs: undefined,
            finishedAtMs: undefined,
            outcome: undefined,
            result: undefined,
            endedWithoutResult: false,
            message,
          });
          this.put(this.callIndex, block.call, at);
          return;
        }
        case "opaque":
          return;
      }
    });
    this.setScalars({ total: addUsage(this.s.total, body.usage) });
    this.updateTurn(body.turn, record, (view) => ({
      ...view,
      usage: addUsage(view.usage, body.usage),
    }));
  }

  private turnEnded(
    record: SessionRecord,
    body: Extract<RecordBody, { type: "turn_ended" }>,
  ): void {
    const wasRunning = this.s.open[0] === body.turn;
    this.closeCalls(body.turn);
    this.updateTurn(body.turn, record, (view) => ({
      ...view,
      status: statusOf(body.outcome.status),
      outcome: body.outcome,
      endedAtMs: record.at_ms,
    }));
    const open = this.s.open.filter((turn) => turn !== body.turn);
    this.append({
      kind: "turn_ended",
      key: String(record.seq),
      seq: record.seq,
      atMs: record.at_ms,
      turn: body.turn,
      outcome: body.outcome,
    });
    // Whatever steer the turn did not get is handed to the next request.
    this.setScalars({ open, retry: undefined });
    const next = open[0];
    if (wasRunning && next !== undefined) {
      this.updateTurn(next, record, (view) => ({ ...view, status: "running" }));
    }
  }

  /** The cut of a rewind: every turn still open ends where the log was cut. */
  private applyBoundary(record: SessionRecord): void {
    if (record.type !== "rewind_finished") return;
    for (const turn of this.s.open) {
      this.closeCalls(turn);
      this.updateTurn(turn, record, (view) => ({
        ...view,
        status: "rewound",
        endedAtMs: record.at_ms,
      }));
    }
    this.append({
      kind: "rewind",
      key: String(record.seq),
      seq: record.seq,
      atMs: record.at_ms,
      to: record.to,
      workspace: record.workspace,
      unrevertedCommands: record.unreverted_commands,
    });
    this.setScalars({
      open: [],
      retry: undefined,
      steers: [],
      current: undefined,
    });
  }

  /** Calls of `turn` that never got a result: the model is told they did not complete. */
  private closeCalls(turn: TurnId): void {
    const from = this.userIndex.get(turn) ?? 0;
    for (let index = from; index < this.items.length; index++) {
      const item = this.items[index]!;
      if (item.kind === "tool_call" && item.turn === turn && !item.result) {
        this.replace(index, withState({ ...item, endedWithoutResult: true }));
        this.removeAwaiting(item.call);
      }
    }
  }

  private updateTurn(
    turn: TurnId,
    record: SessionRecord,
    change: (view: TurnView) => TurnView,
  ): void {
    let view = this.turns.get(turn);
    if (!view) {
      // The transcript starts mid-turn (a page of the log, a reconnect).
      view = {
        turn,
        userSeq: undefined,
        startedAtMs: record.at_ms,
        status: "running",
        outcome: undefined,
        endedAtMs: undefined,
        checkpoint: undefined,
        requests: 0,
        usage: NO_USAGE,
      };
      this.put(this.turnIndex, turn, this.turnOrder.length);
      this.push(this.turnOrder, turn);
    }
    this.put(this.turns, turn, change(view));
  }

  private updateTool(
    call: ToolCallId,
    record: SessionRecord,
    turn: TurnId,
    change: (tool: ToolCallItem) => ToolCallItem,
    name = "unknown",
  ): void {
    let index = this.callIndex.get(call);
    if (index === undefined) {
      // The record that carried the call is not in this transcript.
      index = this.append({
        kind: "tool_call",
        key: `${record.seq}:${call}`,
        seq: record.seq,
        atMs: record.at_ms,
        turn,
        block: 0,
        call,
        name,
        input: null,
        state: "requested",
        approval: "none",
        effect: undefined,
        starts: 0,
        startedAtMs: undefined,
        finishedAtMs: undefined,
        outcome: undefined,
        result: undefined,
        endedWithoutResult: false,
        message: undefined,
      });
      this.put(this.callIndex, call, index);
    }
    const tool = this.items[index] as ToolCallItem;
    const changed = change(tool);
    if (changed !== tool) this.replace(index, withState(changed));
  }
}

function isVisible(block: AssistantBlock): boolean {
  return block.type !== "opaque";
}

function statusOf(status: TurnOutcome["status"]): TurnStatus {
  // A turn that ran out of contract corrections did not do what it had to.
  return status === "contract_unmet" ? "failed" : status;
}

/** A tool call's state follows from what the log has said about it. */
function withState(tool: ToolCallItem): ToolCallItem {
  const state = toolState(tool);
  return state === tool.state ? tool : { ...tool, state };
}

function toolState(tool: ToolCallItem): ToolCallState {
  if (tool.outcome) return tool.outcome;
  if (tool.endedWithoutResult) return "cancelled";
  if (tool.approval === "requested") return "awaiting_approval";
  if (tool.starts > 0) return "running";
  return "requested";
}

/** Folds whole logs: the records, then the deltas that followed them. */
export function reduceTranscript(
  records: readonly SessionRecord[],
  deltas: readonly Delta[] = [],
): Transcript {
  const reducer = new TranscriptReducer();
  reducer.applyRecords(records);
  for (const delta of deltas) reducer.applyDelta(delta);
  return reducer.snapshot();
}
