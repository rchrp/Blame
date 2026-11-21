// When the session hub says a session's run ended: on the engine's idle
// activity, and, for a turn the engine ended before it ever turned busy (an
// interrupt at once), on that turn's own end in the records. Never on an
// older turn's end met while a long log is read back in pages, since the
// engine reports no activity between accepting a message and the turn's
// first request.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fixedClient,
  type EngineClient,
  type EngineNotification,
  type SessionRecord,
} from "@blame/engine-client";
import type { EngineHostEvent } from "./protocol.js";
import { SessionHub } from "./session-hub.js";

const session = "session-1";

/** Enough of an engine client for a follower: open, subscribe, pages of records, pushes. */
function fakeClient(records: SessionRecord[]) {
  const listeners = new Set<(notification: EngineNotification) => void>();
  const client = {
    isClosed: false,
    closed: new Promise<void>(() => undefined),
    onNotification(listener: (notification: EngineNotification) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async openSession() {
      return { session, head: records.length, activity: { state: "idle" } };
    },
    async subscribe() {
      return {
        head: records.length,
        activity: { state: "idle" },
        in_flight: [],
      };
    },
    async unsubscribe() {
      return null;
    },
    async readRecords(input: { after: number; limit: number }) {
      return {
        records: records
          .filter((record) => record.seq > input.after)
          .slice(0, input.limit),
        head: records.length,
      };
    },
  };
  return {
    client: client as unknown as EngineClient,
    push(record: SessionRecord) {
      records.push(record);
      for (const listener of listeners)
        listener({
          method: "session/record",
          params: { session, record },
        } as unknown as EngineNotification);
    },
    activity(state: string) {
      for (const listener of listeners)
        listener({
          method: "session/delta",
          params: { session, delta: { type: "activity", activity: { state } } },
        } as unknown as EngineNotification);
    },
  };
}

const at = (seq: number) => ({ seq, at_ms: seq });
const opened = (seq: number, turn: string) =>
  ({
    ...at(seq),
    type: "user_message",
    turn,
    input: [{ type: "text", text: turn }],
    delivery: "turn",
  }) as unknown as SessionRecord;
const ended = (seq: number, turn: string, status = "completed") =>
  ({
    ...at(seq),
    type: "turn_ended",
    turn,
    outcome: { status },
  }) as unknown as SessionRecord;

/** A log of `turns` finished turns, two records each. */
function history(turns: number) {
  const records: SessionRecord[] = [];
  for (let index = 0; index < turns; index += 1) {
    records.push(opened(records.length + 1, `old-${index}`));
    records.push(ended(records.length + 1, `old-${index}`));
  }
  return records;
}

async function settle(until: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200 && !until(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(until(), `waited for ${what}`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the session hub", () => {
  it("keeps a just-sent turn running while a long log is read back in pages", async () => {
    // 250 finished turns: the follower's first page (500 records) ends
    // exactly on an older turn's end, while the engine says idle.
    const records = history(250);
    records.push(opened(501, "new"));
    const engine = fakeClient(records);
    const events: EngineHostEvent[] = [];
    const hub = new SessionHub(fixedClient(engine.client), (event) =>
      events.push(event),
    );
    hub.watch(session, "new");
    await pause(100);
    const activity = events.filter((event) => event.type === "activity");
    assert.deepEqual(
      activity.map((event) => (event as { running: boolean }).running),
      [true],
      "no end reported for the turn that was just sent",
    );
    assert.deepEqual(hub.running(), [session]);
    await hub.stop();
  });

  it("ends the run when the very turn sent ends before the engine ever turned busy", async () => {
    const records = history(3);
    records.push(opened(7, "new"));
    const engine = fakeClient(records);
    const events: EngineHostEvent[] = [];
    const hub = new SessionHub(fixedClient(engine.client), (event) =>
      events.push(event),
    );
    hub.watch(session, "new");
    await pause(50);
    // An interrupt at once: the engine ends it, its activity stays idle.
    engine.push(ended(8, "new", "interrupted"));
    await settle(() => hub.running().length === 0, "the run to end");
    const last = events.filter((event) => event.type === "activity").at(-1);
    assert.deepEqual(last, {
      type: "activity",
      session,
      running: false,
      outcome: { status: "interrupted" },
    });
    await hub.stop();
  });

  it("ends the run when the turn sent already ended in what was followed before the send returned", async () => {
    const engine = fakeClient([opened(1, "first"), ended(2, "first")]);
    const hub = new SessionHub(fixedClient(engine.client), () => undefined);
    // A window shows the conversation: the hub keeps following it.
    hub.subscribe(session, "window");
    hub.watch(session, "first");
    await settle(() => hub.running().length === 0, "the first run to end");
    // The next message is cut at once: its records come before the send's answer.
    engine.push(opened(3, "next"));
    engine.push(ended(4, "next", "interrupted"));
    await pause(20);
    hub.watch(session, "next");
    await settle(() => hub.running().length === 0, "the run to end");
    await hub.stop();
  });

  it("still ends a run on the engine's idle activity, once", async () => {
    const engine = fakeClient([opened(1, "new")]);
    const events: EngineHostEvent[] = [];
    const hub = new SessionHub(fixedClient(engine.client), (event) =>
      events.push(event),
    );
    hub.watch(session, "new");
    await pause(50);
    engine.activity("waiting");
    engine.push(ended(2, "new"));
    engine.activity("idle");
    await settle(() => hub.running().length === 0, "the run to end");
    await pause(50);
    const runs = events
      .filter((event) => event.type === "activity")
      .map((event) => (event as { running: boolean }).running);
    assert.deepEqual(runs, [true, false]);
    await hub.stop();
  });
});
