import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createAgentEventCoalescer } from "./agent-event-coalescer.js";
import type { AgentEvent } from "./types.js";

function delta(
  text: string,
  type: "reasoning" | "text" = "text",
  sessionId = "session",
  iteration = 1,
): AgentEvent {
  return {
    executionId: `${sessionId}:execution`,
    payload: { iteration, phase: "started", text },
    sessionId,
    type,
  };
}

function tool(sessionId = "session"): AgentEvent {
  return {
    executionId: `${sessionId}:execution`,
    payload: {
      phase: "started",
      toolCall: { id: "call-1", name: "read_files" },
    },
    sessionId,
    type: "tool",
  };
}

function texts(events: AgentEvent[]) {
  return events.map((event) => [
    event.type,
    event.sessionId,
    (event.payload as { text?: string }).text,
  ]);
}

function coalescer() {
  mock.timers.enable({ apis: ["setTimeout"] });
  const sent: AgentEvent[] = [];
  return {
    sent,
    events: createAgentEventCoalescer((event) => sent.push(event)),
  };
}

test.afterEach(() => mock.timers.reset());

test("sends the deltas of one window as one event", () => {
  const { sent, events } = coalescer();
  events.push(delta("Je "));
  events.push(delta("vais "));
  events.push(delta("lire."));
  assert.equal(sent.length, 0);

  mock.timers.tick(33);

  assert.deepEqual(texts(sent), [["text", "session", "Je vais lire."]]);
  assert.deepEqual(sent[0]?.payload, {
    iteration: 1,
    phase: "started",
    text: "Je vais lire.",
  });
});

test("sends the pending delta before any other event, without delaying it", () => {
  const { sent, events } = coalescer();
  events.push(delta("Je lis "));
  events.push(delta("le fichier."));
  events.push(tool());
  events.push(delta("Lu."));
  mock.timers.tick(33);

  assert.deepEqual(texts(sent), [
    ["text", "session", "Je lis le fichier."],
    ["tool", "session", undefined],
    ["text", "session", "Lu."],
  ]);
});

test("keeps each session's deltas apart", () => {
  const { sent, events } = coalescer();
  events.push(delta("A1 ", "text", "a"));
  events.push(delta("B1 ", "text", "b"));
  events.push(delta("A2", "text", "a"));
  events.push(tool("b"));
  events.push(delta("B2", "text", "b"));
  mock.timers.tick(33);

  assert.deepEqual(texts(sent), [
    ["text", "b", "B1 "],
    ["tool", "b", undefined],
    ["text", "a", "A1 A2"],
    ["text", "b", "B2"],
  ]);
});

test("does not merge deltas of another kind, iteration or phase", () => {
  const { sent, events } = coalescer();
  events.push(delta("think ", "reasoning"));
  events.push(delta("answer ", "text"));
  events.push(delta("next ", "text", "session", 2));
  events.push({
    payload: { iteration: 2, phase: "finished" },
    sessionId: "session",
    type: "text",
  });
  events.push(delta("again", "text", "session", 2));
  events.flush();

  assert.deepEqual(texts(sent), [
    ["reasoning", "session", "think "],
    ["text", "session", "answer "],
    ["text", "session", "next "],
    ["text", "session", undefined],
    ["text", "session", "again"],
  ]);
});

test("keeps a blank delta apart from the words after it", () => {
  const { sent, events } = coalescer();
  events.push(delta("\n"));
  events.push(delta("\n"));
  events.push(delta("Done"));
  events.push(delta("\n\n"));
  events.flush();

  assert.deepEqual(texts(sent), [
    ["text", "session", "\n\n"],
    ["text", "session", "Done\n\n"],
  ]);
});

test("flush sends every pending delta and stops their timers", () => {
  const { sent, events } = coalescer();
  events.push(delta("a", "text", "a"));
  events.push(delta("b", "text", "b"));
  events.flush();
  mock.timers.tick(100);

  assert.deepEqual(texts(sent), [
    ["text", "a", "a"],
    ["text", "b", "b"],
  ]);
});
