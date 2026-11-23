// The orchestrator's pure rules: when the host wakes it, what still works
// or starts by itself, how a conversation's state reads, and the host's
// wake message as the screen reads it back.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  orchestratorWakeText,
  parseOrchestratorWake,
  type OrchestratorWake,
} from "../protocol.js";
import {
  epicCounts,
  epicHasWork,
  storyCanStart,
  wakeDue,
  waitsForPerson,
  wakeStory,
} from "./board.js";
import { epicSlug } from "./branch.js";
import { conversationState, type ConversationView } from "./conversation.js";
import { epicStateOf } from "./epic-state.js";

type Story = Parameters<typeof storyCanStart>[0];
const story = (id: string, fields: Partial<Story> = {}): Story => ({
  id,
  status: "ready",
  agentStatus: null,
  startsAfter: [],
  storyNumber: 1,
  title: id,
  ...fields,
});
const none = new Set<string>();

describe("the orchestrator's rules", () => {
  it("wakes it once no story works, or when a story another starts after ended", () => {
    const working = story("a", {
      status: "in-progress",
      agentStatus: "Running",
    });
    const ended = [{ storyId: "b" }];
    assert.equal(
      wakeDue([working, story("b", { status: "in-review" })], none, ended),
      false,
    );
    assert.equal(
      wakeDue([story("b", { status: "in-review" })], none, ended),
      true,
    );
    // b ended and c starts after it: woken although a still works.
    assert.equal(
      wakeDue(
        [
          working,
          story("b", { status: "in-review" }),
          story("c", { startsAfter: ["b"] }),
        ],
        none,
        ended,
      ),
      true,
    );
    // Nothing ended: nothing to tell.
    assert.equal(
      wakeDue([story("b", { status: "in-review" })], none, []),
      false,
    );
    // Being started counts as working.
    assert.equal(
      wakeDue(
        [story("a"), story("b", { status: "in-review" })],
        new Set(["a"]),
        ended,
      ),
      false,
    );
  });

  it("knows what starts by itself and what waits for a decision", () => {
    const review = story("a", { status: "in-review" });
    const after = story("b", { startsAfter: ["a"] });
    assert.equal(storyCanStart(after, [review, after], none), false);
    assert.equal(
      storyCanStart(after, [{ ...review, status: "done" }, after], none),
      true,
    );
    // Through a chain: c after b after a, a queued.
    const chain = [
      story("a"),
      story("b", { startsAfter: ["a"] }),
      story("c", { startsAfter: ["b"] }),
    ];
    assert.equal(storyCanStart(chain[2]!, chain, none), true);
    assert.equal(epicHasWork([review], none), false);
    assert.equal(epicHasWork([review, story("q")], none), true);
    // Held by its epic, or waiting for the person: it does not start by itself.
    assert.equal(
      epicHasWork([review, story("q")], none, () => true),
      false,
    );
    assert.equal(waitsForPerson({ kind: "no-model" }), true);
    assert.equal(waitsForPerson({ kind: "runtime", phase: "starting" }), false);
    assert.equal(waitsForPerson({ kind: "error", message: "busy" }), false);
  });

  it("counts the board by what is owed", () => {
    assert.deepEqual(
      epicCounts(
        [
          story("w", { status: "in-progress", agentStatus: "Running" }),
          story("q"),
          story("h", { status: "backlog" }),
          story("r", { status: "in-review" }),
          story("p", { status: "in-progress", agentStatus: "Paused" }),
          story("d", { status: "done" }),
          story("x", { status: "discarded" }),
        ],
        none,
      ),
      {
        working: 1,
        queued: 1,
        held: 1,
        inReview: 1,
        paused: 1,
        merged: 1,
        rejected: 1,
      },
    );
  });

  it("writes a wake the screen reads back, and a person's message is never one", () => {
    const wake: OrchestratorWake = {
      reason: "stories",
      stories: [
        wakeStory(
          { id: "s1", storyNumber: 4, title: "Pay", status: "in-review" },
          "session-1",
          {
            turn: "turn-1",
            outcome: {
              status: "contract_unmet",
              unmet: [{ kind: "result", tool: "finish_task" }],
              refused: { kind: "failing_checks", tasks: ["build", "test"] },
            } as never,
            reply: "Tried.\nStill failing.",
          },
        ),
      ],
      board: {
        working: 0,
        queued: 0,
        held: 0,
        inReview: 1,
        paused: 0,
        merged: 0,
        rejected: 0,
      },
    };
    const parsed = parseOrchestratorWake([
      { type: "context", text: orchestratorWakeText(wake) },
    ]);
    assert.deepEqual(parsed, wake);
    assert.equal(parsed!.stories[0]!.number, "US-004");
    assert.deepEqual(parsed!.stories[0]!.failingChecks, ["build", "test"]);
    assert.equal(parsed!.stories[0]!.verified, false);
    // The person's words: a text block, even if it quotes a wake.
    assert.equal(
      parseOrchestratorWake([
        { type: "text", text: "hello" },
        { type: "context", text: orchestratorWakeText(wake) },
      ]),
      undefined,
    );
    assert.equal(
      parseOrchestratorWake([
        { type: "text", text: orchestratorWakeText(wake) },
      ]),
      undefined,
    );
  });

  it("words a resumed wake by what cut the turn, and keeps the cause", () => {
    const board = {
      working: 0,
      queued: 0,
      held: 0,
      inReview: 0,
      paused: 0,
      merged: 0,
      rejected: 0,
    };
    const text = (cut?: "pause" | "quit") =>
      orchestratorWakeText({
        reason: "resumed",
        ...(cut ? { cut } : {}),
        stories: [],
        board,
      });
    assert.match(
      text("pause"),
      /The person paused the epic while you were working, and resumed it\./,
    );
    assert.doesNotMatch(text("pause"), /Blame stopped/);
    assert.match(
      text("quit"),
      /Blame stopped while you were working \(it quit, or its engine stopped\)\./,
    );
    // A wake written before the cause was told reads as a quit.
    assert.match(text(), /Blame stopped while you were working/);
    assert.equal(
      parseOrchestratorWake([{ type: "context", text: text("pause") }])?.cut,
      "pause",
    );
  });

  it("lists every problem of the epic's for the person, the first as its error", () => {
    const failed: ConversationView = {
      exists: true,
      running: false,
      queued: [],
      last: {
        turn: "t1",
        outcome: {
          status: "failed",
          error: { kind: "overloaded", message: "The provider is overloaded." },
        } as never,
      },
      reported: new Set(),
      wakes: new Set(),
      spentMicroUsd: 0,
      unpricedRequests: 0,
      messages: { all: {}, changes: {} },
      shown: {},
    };
    const state = (
      fields: { branchGone?: boolean; file?: string; wake?: string } = {},
      conversation: ConversationView | null = failed,
    ) =>
      epicStateOf({
        epic: {
          id: "epic-1",
          projectId: "a",
          title: "Lost",
          goal: "",
          status: "active",
          branch: "epic/lost",
          targetBranch: "main",
          engineSessionId: "orchestrator-1",
          settings: {},
          mergedAt: null,
          mergeCommit: null,
        },
        entry: {
          projectId: "a",
          session: "orchestrator-1",
          branch: "epic/lost",
          ...(fields.branchGone ? { branchGone: true } : {}),
          pending: [],
          spend: {},
          changes: {},
        },
        conversation: conversation ?? undefined,
        spend: {
          orchestratorMicroUsd: 0,
          storiesMicroUsd: 0,
          totalMicroUsd: 0,
          spent: false,
          unpricedRequests: 0,
          stories: [],
        } as never,
        unreported: 0,
        blocked: [],
        errors: {
          ...(fields.file ? { file: fields.file } : {}),
          ...(fields.wake ? { wake: fields.wake } : {}),
        },
        pause: undefined,
      });
    // A failed turn no longer hides the lost branch, nor a wake not sent.
    const both = state({
      branchGone: true,
      wake: "The orchestrator could not be woken: busy.",
    });
    assert.deepEqual(
      both.problems?.map((problem) => problem.kind),
      ["turn", "wake", "branch"],
    );
    assert.equal(both.error, "The provider is overloaded.");
    assert.match(both.problems![2]!.message, /epic\/lost is gone/);
    const unreadable = state({
      file: "The orchestrator's file cannot be read.",
    });
    assert.deepEqual(
      unreadable.problems?.map((problem) => problem.kind),
      ["kept-file", "turn"],
    );
    assert.equal(unreadable.error, "The orchestrator's file cannot be read.");
    const fine = state({}, null);
    assert.equal(fine.problems, undefined);
    assert.equal(fine.error, undefined);
  });

  it("reads the conversation's state from its last turn", () => {
    const view = (fields: Partial<ConversationView>): ConversationView => ({
      exists: true,
      running: false,
      queued: [],
      reported: new Set(),
      wakes: new Set(),
      spentMicroUsd: 0,
      unpricedRequests: 0,
      messages: { all: {}, changes: {} },
      shown: {},
      ...fields,
    });
    const last = (outcome: object, endTurn?: object) =>
      view({
        last: {
          turn: "t",
          outcome: outcome as never,
          ...(endTurn ? { endTurn: endTurn as never } : {}),
        },
      });
    assert.equal(conversationState(undefined, false).state, "idle");
    assert.equal(
      conversationState(view({ running: true }), false).state,
      "working",
    );
    assert.equal(
      conversationState(view({ queued: ["t2"] }), false).state,
      "working",
    );
    assert.equal(
      conversationState(
        last({ status: "completed" }, { action: "wait" }),
        false,
      ).state,
      "waiting",
    );
    assert.equal(
      conversationState(last({ status: "completed" }, { action: "ask" }), false)
        .state,
      "asking",
    );
    assert.equal(
      conversationState(
        last({ status: "completed" }, { action: "reply" }),
        false,
      ).state,
      "replied",
    );
    assert.equal(
      conversationState(
        last({ status: "completed" }, { action: "finish" }),
        false,
      ).state,
      "finished",
    );
    assert.equal(
      conversationState(last({ status: "interrupted" }), true).state,
      "stopped",
    );
    assert.deepEqual(
      conversationState(last({ status: "interrupted" }), false),
      {
        state: "failed",
        error: "Blame stopped while it was working.",
      },
    );
    assert.match(
      conversationState(
        last({
          status: "failed",
          error: { kind: "provider", message: "Overloaded" },
        }),
        false,
      ).error!,
      /Overloaded/,
    );
  });

  it("names an epic's branch from its title", () => {
    assert.equal(
      epicSlug("Checkout flow: pay & ship!", "0193abcd"),
      "checkout-flow-pay-ship",
    );
    assert.equal(epicSlug("Épopée", "0193abcd"), "epopee");
    assert.equal(epicSlug("???", "0193ABCD-1"), "epic-0193abcd");
  });
});
