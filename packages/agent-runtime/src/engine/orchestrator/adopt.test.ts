// An epic's entry built again from its conversation's records when the
// kept file was lost: what the records allow, nothing guessed.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { EngineClient } from "@blame/engine-client";
import type { EngineSessionStatus, Epic } from "../protocol.js";
import type { HostStory } from "../stories/story.js";
import { rebuildEntry } from "./adopt.js";
import { ConversationReader } from "./conversation.js";
import { OrchestratorState } from "./state.js";

const session = "orchestrator-1";
const epic = {
  id: "epic-1",
  projectId: "a",
  title: "Found",
  goal: "Find it.",
  status: "active",
  branch: "epic/found",
  targetBranch: "main",
  engineSessionId: session,
  settings: {},
  mergedAt: null,
  mergeCommit: null,
} as Epic;

const config = {
  purpose: "orchestrator",
  workspace_root: "/a",
  model: { provider: "anthropic", model: "claude" },
  system_prompt:
    "<epic>\nbranch: epic/found (stories merge here, never into main)\n</epic>",
  engine_tools: [],
  client_tools: [],
  tool_options: {},
  limits: {},
  checkpoints: true,
};

// One turn of the orchestrator's: each tool call with the JSON the host answered.
function records(
  calls: Array<{ name: string; input: object; result: object }>,
  outcome: "completed" | "interrupted" = "completed",
) {
  const bodies: Array<Record<string, unknown>> = [
    { type: "session_created", config },
    {
      type: "user_message",
      turn: "t1",
      input: [{ type: "text", text: "Go." }],
      delivery: "turn",
    },
    {
      type: "request_started",
      turn: "t1",
      request: "r1",
      model: config.model,
      attempt: 1,
      prefix_digest: "sha256:0",
    },
    {
      type: "assistant_message",
      turn: "t1",
      request: "r1",
      blocks: calls.map((call, index) => ({
        type: "tool_call",
        call: `c${index}`,
        name: call.name,
        input: call.input,
      })),
      stop: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    ...calls.flatMap((call, index) => [
      {
        type: "tool_call_started",
        turn: "t1",
        call: `c${index}`,
        name: call.name,
        effect: "read_only",
      },
      {
        type: "tool_call_finished",
        turn: "t1",
        call: `c${index}`,
        outcome: "completed",
        content: [{ type: "text", text: JSON.stringify(call.result) }],
      },
    ]),
    { type: "turn_ended", turn: "t1", outcome: { status: outcome } },
  ];
  return bodies.map((body, index) => ({
    seq: index + 1,
    at_ms: 1_000 + index,
    ...body,
  }));
}

const story = (id: string, storyNumber: number, fields: object = {}) =>
  ({
    id,
    storyNumber,
    projectId: "a",
    epicId: epic.id,
    title: id,
    status: "in-progress",
    engineSessionId: `session-${id}`,
    ...fields,
  }) as unknown as HostStory;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function rebuild(
  kept: ReturnType<typeof records>,
  statuses: Record<string, Partial<EngineSessionStatus>>,
) {
  const directory = await mkdtemp(join(tmpdir(), "adopt-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const state = new OrchestratorState(join(directory, "epics.json"));
  const client = {
    listSessions: async () => ({ sessions: [{ session }] }),
    readRecords: async ({ after = 0 }: { after?: number }) => ({
      records: kept.filter((record) => record.seq > after),
      head: kept.length,
    }),
  } as unknown as EngineClient;
  const adopted = await rebuildEntry({
    epic,
    apiUrl: "http://api.localhost",
    client,
    conversations: new ConversationReader(),
    state,
    stories: [story("s1", 1, { status: "done" }), story("s2", 2)],
    status: async (storyId) =>
      statuses[storyId] as EngineSessionStatus | undefined,
  });
  assert.equal(adopted, true);
  return (await state.get(epic.id))!;
}

describe("an epic found again from its records", () => {
  it("rebuilds the counts, the turns its tools showed and a merged story's spend", async () => {
    const entry = await rebuild(
      records([
        {
          name: "epic_board",
          input: {},
          result: {
            stories: [
              {
                id: "s1",
                lastTurn: { turn: "a1", outcome: "completed" },
                costMicroUsd: 500,
              },
              {
                id: "s2",
                lastTurn: { turn: "b1", outcome: "completed" },
                costMicroUsd: 300,
              },
            ],
          },
        },
        // To a story in review: a request for changes whatever its kind.
        {
          name: "message_story",
          input: { storyId: "s1", kind: "answer", message: "Fix it." },
          result: { sent: true, changesRequested: 1, left: 2 },
        },
        // Named by its number; an answer while it works is not one.
        {
          name: "message_story",
          input: { storyId: "US-002", kind: "answer", message: "Yes." },
          result: { sent: true, messagesLeft: 5 },
        },
        {
          name: "story_report",
          input: { storyId: "s2" },
          result: { id: "s2", turn: "b2", costMicroUsd: 400 },
        },
      ]),
      {
        // s1 was merged: its session is gone.
        s1: { session: "session-s1", exists: false },
        s2: {
          session: "session-s2",
          exists: true,
          endedTurns: [
            { turn: "b1", outcome: { status: "completed" } },
            { turn: "b2", outcome: { status: "completed" } },
          ],
        },
      },
    );
    assert.deepEqual(entry.messages, { s1: 1, s2: 1 });
    assert.deepEqual(entry.changes, { s1: 1 });
    assert.deepEqual(entry.heard, {
      "session-s2\nb1": "s2",
      "session-s2\nb2": "s2",
    });
    // A live session's spend is read from it; a gone one's, from the records.
    assert.deepEqual(entry.spend, {
      s1: { "session-s1": { microUsd: 500, unpriced: 0 } },
    });
    assert.equal(entry.stopped, undefined);
    assert.equal(entry.branch, "epic/found");
  });

  it("leaves a conversation whose last turn was cut to the person", async () => {
    const entry = await rebuild(records([], "interrupted"), {});
    assert.equal(entry.stopped, true);
  });
});
