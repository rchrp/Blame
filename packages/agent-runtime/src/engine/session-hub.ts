// One follower per session for the whole app, however many windows show it.
// The host keeps what a follower delivered while it follows, so a window
// that opens the conversation later gets all of it at once; nothing is kept
// once nobody shows the session and no turn runs.

import {
  PLAN_TOOL,
  currentPlan,
  followSession,
  planProgress,
  samePlanProgress,
  type PlanProgress,
  type ClientSource,
  type Delta,
  type FollowEvent,
  type SessionActivity,
  type SessionFollower,
  type SessionId,
  type SessionRecord,
  type TurnOutcome,
} from "@blame/engine-client";
import type { EngineHostEvent } from "./protocol.js";

type Followed = {
  follower: SessionFollower;
  records: SessionRecord[];
  /** Deltas since the last record: the reply being streamed. */
  streaming: Delta[];
  activity: SessionActivity;
  subscribers: Set<string>;
  running: boolean;
  /**
   * A message was just sent: an idle activity the follower held from
   * before (its attach) must not end the turn the engine is starting.
   */
  sent: boolean;
  /** How the last turn ended, reported once the session goes idle. */
  lastOutcome: TurnOutcome | undefined;
  /** The turns its records opened and did not end yet. */
  open: Set<string>;
  /** The calls that set the agent's plan, and how far the plan is now. */
  planCalls: Set<string>;
  plan: PlanProgress | undefined;
};

// Deltas of one reply kept for a late viewer; beyond this it sees the reply
// when its record comes.
const maxStreaming = 4_000;

export class SessionHub {
  private readonly followed = new Map<SessionId, Followed>();
  private readonly subscriptions = new Map<string, SessionId>();
  private readonly source: ClientSource;
  private readonly emit: (event: EngineHostEvent) => void;

  constructor(source: ClientSource, emit: (event: EngineHostEvent) => void) {
    this.source = source;
    this.emit = emit;
  }

  /** Starts sending `subscription` everything about `session`. */
  subscribe(session: SessionId, subscription: string) {
    this.unsubscribe(subscription);
    const followed = this.follow(session);
    followed.subscribers.add(subscription);
    this.subscriptions.set(subscription, session);
    const send = (event: FollowEvent) =>
      this.emit({ type: "follow", subscription, event });
    if (followed.records.length)
      send({ type: "records", records: [...followed.records] });
    send({
      type: "attached",
      activity: followed.activity,
      inFlight: [...followed.streaming],
      head: followed.records.at(-1)?.seq ?? 0,
      resumedAfter: 0,
    });
    for (const delta of followed.streaming) send({ type: "delta", delta });
    if (followed.follower.state === "live")
      send({ type: "state", state: "live" });
  }

  unsubscribe(subscription: string) {
    const session = this.subscriptions.get(subscription);
    if (!session) return;
    this.subscriptions.delete(subscription);
    const followed = this.followed.get(session);
    followed?.subscribers.delete(subscription);
    this.release(session);
  }

  /** Follows a session while its turn runs, so its end is reported. */
  watch(session: SessionId) {
    const followed = this.follow(session);
    // Until the engine says otherwise, a message was just sent.
    followed.sent = true;
    this.setRunning(session, followed, true);
  }

  running(): SessionId[] {
    return [...this.followed]
      .filter(([, followed]) => followed.running)
      .map(([session]) => session);
  }

  async stop() {
    const followers = [...this.followed.values()].map((f) => f.follower);
    this.followed.clear();
    this.subscriptions.clear();
    await Promise.all(followers.map((follower) => follower.stop()));
  }

  private follow(session: SessionId): Followed {
    const existing = this.followed.get(session);
    if (existing) return existing;
    const followed: Followed = {
      records: [],
      streaming: [],
      activity: { state: "idle" },
      subscribers: new Set(),
      running: false,
      sent: false,
      lastOutcome: undefined,
      open: new Set(),
      planCalls: new Set(),
      plan: undefined,
      follower: undefined as unknown as SessionFollower,
    };
    this.followed.set(session, followed);
    followed.follower = followSession({
      source: this.source,
      session,
      onEvent: (event) => this.onEvent(session, followed, event),
    });
    return followed;
  }

  private onEvent(session: SessionId, followed: Followed, event: FollowEvent) {
    if (this.followed.get(session) !== followed) return;
    switch (event.type) {
      case "records": {
        followed.records.push(...event.records);
        followed.streaming = [];
        let ended = false;
        for (const record of event.records)
          if (record.type === "user_message" && record.delivery === "turn")
            followed.open.add(record.turn);
          else if (record.type === "turn_ended") {
            followed.open.delete(record.turn);
            followed.lastOutcome = record.outcome;
            ended = true;
          }
        this.trackPlan(session, followed, event.records);
        // A turn the engine ended before its driver ran (an interrupt at
        // once) never makes the activity busy, so no idle delta comes: the
        // records saying every turn ended is the end.
        if (ended && !followed.open.size && followed.running)
          queueMicrotask(() => {
            if (followed.open.size || followed.activity.state !== "idle")
              return;
            followed.sent = false;
            this.setRunning(session, followed, false);
          });
        break;
      }
      case "delta":
        if (event.delta.type === "activity") {
          followed.activity = event.delta.activity;
          followed.sent = false;
          if (event.delta.activity.state !== "idle")
            this.setRunning(session, followed, true);
          // The follower hands records over a microtask later than deltas:
          // let the turn's end arrive before the session is called idle.
          else
            queueMicrotask(() => {
              if (followed.activity.state === "idle")
                this.setRunning(session, followed, false);
            });
        } else if (followed.streaming.length < maxStreaming) {
          followed.streaming.push(event.delta);
        }
        break;
      case "attached":
        followed.activity = event.activity;
        followed.streaming = [...event.inFlight];
        // Idle is decided once the records are in ("live"), so the end of a
        // turn that finished before the follower attached carries its outcome.
        if (event.activity.state !== "idle") {
          followed.sent = false;
          this.setRunning(session, followed, true);
        }
        break;
      case "state":
        if (event.state === "live" && !followed.sent)
          this.setRunning(
            session,
            followed,
            followed.activity.state !== "idle",
          );
        // A follower that gave up cannot report the end of a turn.
        if (event.state === "stopped")
          this.setRunning(session, followed, false);
        break;
    }
    for (const subscription of followed.subscribers)
      this.emit({ type: "follow", subscription, event });
    if (event.type === "state" && event.state === "stopped") {
      this.followed.delete(session);
      for (const subscription of followed.subscribers)
        this.subscriptions.delete(subscription);
    }
  }

  /**
   * Tells the renderers how far the plan is when it moves: an update that
   * completed, or a rewind. Windows that show no list (a card) need no more.
   */
  private trackPlan(
    session: SessionId,
    followed: Followed,
    records: readonly SessionRecord[],
  ) {
    let moved = false;
    for (const record of records) {
      if (record.type === "assistant_message") {
        for (const block of record.blocks)
          if (block.type === "tool_call" && block.name === PLAN_TOOL)
            followed.planCalls.add(block.call);
      } else if (record.type === "tool_call_finished") {
        moved ||= followed.planCalls.has(record.call);
      } else if (
        record.type === "rewind_finished" ||
        record.type === "rewind_undone"
      ) {
        moved = true;
      }
    }
    if (!moved) return;
    const plan = planProgress(currentPlan(followed.records));
    if (samePlanProgress(plan, followed.plan)) return;
    followed.plan = plan;
    this.emit({ type: "plan", session, plan });
  }

  private setRunning(session: SessionId, followed: Followed, running: boolean) {
    if (followed.running === running) return;
    followed.running = running;
    if (running) followed.lastOutcome = undefined;
    this.emit({
      type: "activity",
      session,
      running,
      ...(!running && followed.lastOutcome
        ? { outcome: followed.lastOutcome }
        : {}),
    });
    if (!running) this.release(session);
  }

  /** Stops following a session nobody shows and that is not working. */
  private release(session: SessionId) {
    const followed = this.followed.get(session);
    if (!followed || followed.subscribers.size || followed.running) return;
    this.followed.delete(session);
    void followed.follower.stop();
  }
}
