import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { EngineClient } from "./client.js";
import { EngineRpcError } from "./errors.js";
import {
  followSession,
  type FollowEvent,
  type SessionFollower,
} from "./follow.js";
import type { Delta, SessionRecord } from "./protocol.js";
import { EngineSupervisor, fixedClient } from "./supervisor.js";
import {
  TranscriptReducer,
  applyFollowEvent,
  reduceTranscript,
} from "./transcript/index.js";
import {
  fakeEngine,
  scratchDirectory,
  sessionConfig,
  userText,
  waitFor,
  type FakeOptions,
} from "./test-support.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const clientOptions = {
  clientName: "test",
  clientVersion: "0",
  shutdownTimeoutMs: 500,
};

function supervisor(options: FakeOptions = {}) {
  const engine = new EngineSupervisor(() =>
    EngineClient.start(fakeEngine(options), clientOptions),
  );
  cleanups.push(() => engine.stop());
  return engine;
}

function collect(follower: { events: FollowEvent[] }) {
  const records = () =>
    follower.events.flatMap((e) => (e.type === "records" ? e.records : []));
  return { records, seqs: () => records().map((r) => r.seq) };
}

function follow(
  source: EngineSupervisor,
  session = "s",
  extra: Partial<Parameters<typeof followSession>[0]> = {},
) {
  const events: FollowEvent[] = [];
  const follower: SessionFollower = followSession({
    source,
    session,
    onEvent: (event) => events.push(event),
    retryDelayMs: () => 10,
    ...extra,
  });
  cleanups.push(() => follower.stop());
  return { follower, events, ...collect({ events }) };
}

const contiguous = (seqs: number[]) => seqs.every((seq, i) => seq === i + 1);

describe("following a session", () => {
  it("delivers every record once, in order, then deltas as they come", async () => {
    const engine = supervisor();
    const client = await engine.client();
    await client.createSession({ session: "s", config: sessionConfig });
    const { events, seqs } = follow(engine);
    await waitFor(() => seqs().length >= 1, "the first record");
    await client.sendMessage({
      session: "s",
      input: userText("hello"),
      delivery: "turn",
    });
    await waitFor(() => seqs().length >= 5, "the turn");
    assert.deepEqual(seqs(), [1, 2, 3, 4, 5]);
    const deltas = events
      .filter((e) => e.type === "delta")
      .map((e) => (e as { delta: Delta }).delta);
    assert.deepEqual(
      deltas.flatMap((d) => (d.type === "text" ? [d.text] : [])),
      ["Hel", "lo"],
    );
    assert.deepEqual(
      events
        .filter((e) => e.type === "state")
        .map((e) => e.type === "state" && e.state),
      ["live"],
    );
  });

  it("starts after the seq it is given", async () => {
    const engine = supervisor();
    const client = await engine.client();
    await client.createSession({ session: "s", config: sessionConfig });
    await client.sendMessage({
      session: "s",
      input: userText("hello"),
      delivery: "turn",
    });
    const { seqs } = follow(engine, "s", { after: 3 });
    await waitFor(() => seqs().length >= 2, "the rest of the log");
    assert.deepEqual(seqs(), [4, 5]);
  });

  for (const flags of [
    ["duplicate-backlog"],
    ["backlog-after"],
    ["drop-live-3"],
  ]) {
    it(`copes with an engine that pushes records ${flags[0]!.replace(/-/g, " ")}`, async () => {
      const engine = supervisor({ flags });
      const client = await engine.client();
      await client.createSession({ session: "s", config: sessionConfig });
      await client.sendMessage({
        session: "s",
        input: userText("one"),
        delivery: "turn",
      });
      const { seqs } = follow(engine);
      await waitFor(() => seqs().length >= 5, "the backlog");
      await client.sendMessage({
        session: "s",
        input: userText("two"),
        delivery: "turn",
      });
      await waitFor(() => seqs().length >= 9, "the second turn");
      assert.ok(contiguous(seqs()), `seqs ${seqs().join(",")}`);
      assert.equal(seqs().length, 9);
    });
  }

  it("stops reporting when stopped, and says so", async () => {
    const engine = supervisor();
    const client = await engine.client();
    await client.createSession({ session: "s", config: sessionConfig });
    const { follower, events, seqs } = follow(engine);
    await waitFor(() => seqs().length === 1, "the first record");
    await follower.stop();
    const seen = events.length;
    await client.sendMessage({
      session: "s",
      input: userText("quiet"),
      delivery: "turn",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(events.length, seen);
    assert.equal(follower.state, "stopped");
  });

  it("gives up with the engine's error when the session does not exist", async () => {
    const engine = supervisor();
    const { follower, events } = follow(engine, "ghost");
    await follower.done;
    const last = events.at(-1);
    assert.ok(
      last?.type === "state" &&
        last.state === "stopped" &&
        last.error instanceof EngineRpcError,
    );
  });

  it("gives up after repeated failures to get an engine", async () => {
    const source = {
      client: async () => {
        throw new Error("no engine");
      },
    };
    const events: FollowEvent[] = [];
    const follower = followSession({
      source,
      session: "s",
      onEvent: (e) => events.push(e),
      retryDelayMs: () => 1,
      maxAttempts: 3,
    });
    await follower.done;
    assert.equal(
      events.filter((e) => e.type === "state" && e.state === "reconnecting")
        .length,
      2,
    );
    const last = events.at(-1);
    assert.ok(
      last?.type === "state" &&
        last.state === "stopped" &&
        last.error instanceof Error,
    );
  });

  it("works on a fixed client, and ends when that client does", async () => {
    const client = await EngineClient.start(fakeEngine(), clientOptions);
    await client.createSession({ session: "s", config: sessionConfig });
    const events: FollowEvent[] = [];
    const follower = followSession({
      source: fixedClient(client),
      session: "s",
      onEvent: (e) => events.push(e),
      retryDelayMs: () => 1,
      maxAttempts: 2,
    });
    await waitFor(
      () => events.some((e) => e.type === "records"),
      "the first record",
    );
    client.kill();
    await follower.done;
    const last = events.at(-1);
    assert.ok(last?.type === "state" && last.state === "stopped" && last.error);
  });
});

describe("after the engine restarts", () => {
  it("resumes from the last seq: no record lost, none repeated", async () => {
    const directory = scratchDirectory();
    cleanups.push(() => directory.remove());
    const engine = supervisor({ store: `${directory.path}/store.json` });
    const first = await engine.client();
    await first.createSession({ session: "s", config: sessionConfig });
    const { events, seqs } = follow(engine);
    await first.sendMessage({
      session: "s",
      input: userText("before"),
      delivery: "turn",
    });
    await waitFor(() => seqs().length >= 5, "the first turn");

    // The engine dies in the middle of a request, after storing the user message.
    await assert.rejects(
      first.sendMessage({
        session: "s",
        input: userText("crash"),
        delivery: "turn",
      }),
    );
    await waitFor(
      () => seqs().length >= 6,
      "the record stored before the crash",
    );
    await waitFor(
      () => events.filter((e) => e.type === "attached").length >= 2,
      "the follower to reattach",
    );

    const second = await engine.client();
    assert.notEqual(second, first);
    await second.sendMessage({
      session: "s",
      input: userText("after"),
      delivery: "turn",
    });
    await waitFor(() => seqs().length >= 10, "the turn after the restart");

    assert.ok(contiguous(seqs()), `seqs ${seqs().join(",")}`);
    assert.equal(seqs().length, 10);
    const states = events
      .filter((e) => e.type === "state")
      .map((e) => e.type === "state" && e.state);
    assert.deepEqual(states.slice(0, 3), ["live", "reconnecting", "live"]);
    const resumed = events.filter((e) => e.type === "attached");
    assert.equal(resumed[1]?.type === "attached" && resumed[1].resumedAfter, 6);
  });

  it("keeps a transcript equal to the one built from the whole log", async () => {
    const directory = scratchDirectory();
    cleanups.push(() => directory.remove());
    const engine = supervisor({ store: `${directory.path}/store.json` });
    const client = await engine.client();
    await client.createSession({ session: "s", config: sessionConfig });
    const reducer = new TranscriptReducer();
    const { events, seqs } = follow(engine, "s", {
      onEvent: (event) => applyFollowEvent(reducer, event),
    });
    void events;
    await client.sendMessage({
      session: "s",
      input: userText("tools"),
      delivery: "turn",
    });
    await waitFor(() => reducer.lastSeq >= 11, "the tool turn");
    await assert.rejects(
      client.sendMessage({
        session: "s",
        input: userText("crash"),
        delivery: "turn",
      }),
    );
    const second = await engine.client();
    await second.sendMessage({
      session: "s",
      input: userText("again"),
      delivery: "turn",
    });
    await waitFor(() => reducer.lastSeq >= 16, "the turn after the restart");
    void seqs;

    const log: SessionRecord[] = (
      await second.readRecords({ session: "s", after: 0, limit: 1000 })
    ).records;
    assert.deepEqual(reducer.snapshot().items, reduceTranscript(log).items);
    assert.equal(reducer.snapshot().turns.at(-1)?.status, "completed");
  });
});
