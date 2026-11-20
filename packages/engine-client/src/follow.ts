import type { EngineClient } from "./client.js";
import { EngineRpcError } from "./errors.js";
import type {
  Delta,
  EngineNotification,
  Seq,
  SessionActivity,
  SessionId,
  SessionRecord,
} from "./protocol.js";
import type { ClientSource } from "./supervisor.js";

export type FollowState =
  | "connecting"
  | "live"
  /** The link dropped or the engine went away; the follower is getting it back. */
  | "reconnecting"
  /** Over: stopped on purpose, or it cannot continue (see the error). */
  | "stopped";

export type FollowEvent =
  | { type: "state"; state: FollowState; error?: unknown }
  /** New records, in seq order, each delivered exactly once over the follower's life. */
  | { type: "records"; records: SessionRecord[] }
  /** A live delta. Deltas may be lost (a drop, a restart) but never reordered. */
  | { type: "delta"; delta: Delta }
  /**
   * Each time the follower (re)subscribes: what the session is doing and the
   * deltas of the reply being streamed. A view should drop its live state and
   * start from these.
   */
  | {
      type: "attached";
      activity: SessionActivity;
      inFlight: Delta[];
      head: Seq;
      resumedAfter: Seq;
    };

export interface FollowOptions {
  /** Where clients come from. After the engine restarts it must yield the new one. */
  source: ClientSource;
  session: SessionId;
  /** Seq of the last record already held (for instance, from a cached transcript). Default 0. */
  after?: Seq;
  onEvent: (event: FollowEvent) => void;
  /** Load the session into the engine before subscribing (needed after a restart). Default true. */
  open?: boolean;
  /** Records asked per `session/read` while catching up. Default 500. */
  pageSize?: number;
  /** Failures in a row before the follower gives up. Default 8. */
  maxAttempts?: number;
  /** How long to wait after the nth failure in a row. Default 250 ms doubling up to 5 s. */
  retryDelayMs?: (attempt: number) => number;
}

export interface SessionFollower {
  /** Seq of the last record received, which is the last delivered once the current event is out. */
  readonly lastSeq: Seq;
  readonly state: FollowState;
  /** Resolves, never rejects, once the follower has stopped. */
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

const defaultDelay = (attempt: number) =>
  Math.min(250 * 2 ** (attempt - 1), 5_000);

/**
 * Follows one session: every record exactly once and in order, deltas as they
 * come, and the same again after the engine restarts or the link drops. It
 * remembers the last seq it delivered and resubscribes after it, so a
 * restart loses no record and repeats none.
 *
 * Records can reach the follower twice (the backlog of a subscription and a
 * page it read, a restarted engine replaying) or with a gap (a lagging
 * subscriber): it delivers each seq once and reads what is missing.
 */
export function followSession(options: FollowOptions): SessionFollower {
  return new Follower(options);
}

class Follower implements SessionFollower {
  lastSeq: Seq;
  state: FollowState = "connecting";
  readonly done: Promise<void>;

  private readonly stopController = new AbortController();
  /** Records that arrived ahead of a missing one. */
  private readonly ahead = new Map<Seq, SessionRecord>();
  private batch: SessionRecord[] = [];
  private flushing = false;
  private client: EngineClient | undefined;
  private resyncing = false;

  constructor(private readonly options: FollowOptions) {
    this.lastSeq = options.after ?? 0;
    this.done = this.run();
  }

  async stop(): Promise<void> {
    if (this.stopController.signal.aborted) return this.done;
    this.stopController.abort();
    const client = this.client;
    if (client && !client.isClosed) {
      // Stop the engine sending, but never wait long for a goodbye.
      await Promise.race([
        client
          .unsubscribe({ session: this.options.session })
          .catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 500).unref()),
      ]);
    }
    await this.done;
  }

  private get stopped(): boolean {
    return this.stopController.signal.aborted;
  }

  private emit(event: FollowEvent): void {
    if (this.stopped && event.type !== "state") return;
    try {
      this.options.onEvent(event);
    } catch {
      // A broken consumer must not stop the session from being followed.
    }
  }

  private setState(state: FollowState, error?: unknown): void {
    this.state = state;
    this.emit(
      error === undefined
        ? { type: "state", state }
        : { type: "state", state, error },
    );
  }

  private async run(): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? 8;
    const delay = this.options.retryDelayMs ?? defaultDelay;
    let failures = 0;
    while (!this.stopped) {
      try {
        const client = await this.options.source.client(
          this.stopController.signal,
        );
        this.client = client;
        await this.attach(client);
        failures = 0;
        this.setState("live");
        await Promise.race([client.closed, this.aborted()]);
        this.detach();
        if (this.stopped) break;
        this.setState("reconnecting");
      } catch (error) {
        this.detach();
        if (this.stopped) break;
        // The engine said no (no such session, protocol error): trying again changes nothing.
        if (error instanceof EngineRpcError || ++failures >= maxAttempts) {
          this.setState("stopped", error);
          return;
        }
        this.setState("reconnecting", error);
        await this.sleep(delay(failures));
      }
    }
    this.state = "stopped";
    this.emit({ type: "state", state: "stopped" });
  }

  private unlisten: (() => void) | undefined;

  private detach(): void {
    this.unlisten?.();
    this.unlisten = undefined;
    this.client = undefined;
    this.ahead.clear();
  }

  private aborted(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      this.stopController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.stopController.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async attach(client: EngineClient): Promise<void> {
    const { session } = this.options;
    const signal = this.stopController.signal;
    // Listen first: records pushed while the subscription is being answered
    // must not be lost to the gap between the result and the listener.
    this.unlisten = client.onNotification((notification) =>
      this.onNotification(client, notification),
    );
    if (this.options.open !== false)
      await client.openSession({ session }, { signal });
    const resumedAfter = this.lastSeq;
    const subscribed = await client.subscribe(
      { session, after: this.lastSeq },
      { signal },
    );
    // Records pushed while the answer was on its way may already be past its head.
    if (subscribed.head < resumedAfter) {
      throw new EngineRpcError(
        -32000,
        `Session ${session} is behind what was already shown (engine head ${subscribed.head}, shown ${resumedAfter})`,
      );
    }
    this.emit({
      type: "attached",
      activity: subscribed.activity,
      inFlight: subscribed.in_flight,
      head: subscribed.head,
      resumedAfter,
    });
    for (const delta of subscribed.in_flight)
      this.emit({ type: "delta", delta });
    await this.catchUp(client, subscribed.head);
  }

  /** Reads whatever the subscription has not pushed (yet, or ever). */
  private async catchUp(client: EngineClient, head: Seq): Promise<void> {
    const { session } = this.options;
    const signal = this.stopController.signal;
    const pageSize = this.options.pageSize ?? 500;
    while (this.lastSeq < head || this.ahead.size > 0) {
      // Pushed records may already have filled the gap while we waited.
      if (this.lastSeq >= head && this.ahead.size === 0) break;
      const page = await client.readRecords(
        { session, after: this.lastSeq, limit: pageSize },
        { signal },
      );
      if (page.records.length === 0) break;
      for (const record of page.records) this.ingest(record);
      this.flush();
    }
    // What is still ahead of a gap that the engine cannot fill is not trustworthy.
    this.ahead.clear();
  }

  private onNotification(
    client: EngineClient,
    notification: EngineNotification,
  ): void {
    if (client !== this.client || this.stopped) return;
    if (notification.params.session !== this.options.session) return;
    if (notification.method === "session/delta") {
      const { delta } = notification.params;
      this.emit({ type: "delta", delta });
      // A session going quiet is when a lost last record would otherwise go
      // unnoticed (nothing later reveals the gap), so check what it holds.
      if (
        delta.type === "activity" &&
        delta.activity.state === "idle" &&
        this.state === "live"
      ) {
        void this.resync(client, Number.POSITIVE_INFINITY);
      }
      return;
    }
    this.ingest(notification.params.record);
    this.scheduleFlush();
    if (this.ahead.size > 0 && this.state === "live")
      void this.resync(client, Math.min(...this.ahead.keys()));
  }

  /** Accepts a record if it is the next one, holds it if it is ahead, drops it if seen. */
  private ingest(record: SessionRecord): void {
    if (record.seq <= this.lastSeq) return;
    if (record.seq !== this.lastSeq + 1) {
      this.ahead.set(record.seq, record);
      return;
    }
    this.batch.push(record);
    this.lastSeq = record.seq;
    // The record may be the one a held-back run was waiting for.
    for (
      let next = this.ahead.get(this.lastSeq + 1);
      next;
      next = this.ahead.get(this.lastSeq + 1)
    ) {
      this.ahead.delete(next.seq);
      this.batch.push(next);
      this.lastSeq = next.seq;
    }
    for (const seq of this.ahead.keys())
      if (seq <= this.lastSeq) this.ahead.delete(seq);
  }

  private scheduleFlush(): void {
    if (this.flushing) return;
    this.flushing = true;
    // Everything one chunk of output carried goes out as one event.
    queueMicrotask(() => {
      this.flushing = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.batch.length === 0) return;
    const records = this.batch;
    this.batch = [];
    this.emit({ type: "records", records });
  }

  /** A record arrived with a gap before it: ask the engine for what is missing. */
  private async resync(client: EngineClient, upTo: Seq): Promise<void> {
    if (this.resyncing) return;
    this.resyncing = true;
    try {
      await this.catchUp(client, upTo);
    } catch {
      // A dead link is handled by the loop that is waiting on `client.closed`.
    } finally {
      this.resyncing = false;
    }
  }
}
