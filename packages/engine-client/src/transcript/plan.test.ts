import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanStep } from "../protocol.js";
import { Log, call, text } from "./fixtures.js";
import {
  currentPlan,
  parsePlan,
  planChange,
  planProgress,
  samePlanProgress,
} from "./plan.js";
import { TranscriptReducer, reduceTranscript } from "./reducer.js";

const input = (...steps: Array<[string, string, string?]>) => ({
  plan: steps.map(([step, status, reason]) => ({
    step,
    status,
    ...(reason ? { reason } : {}),
  })),
});

const steps = (...list: Array<[string, PlanStep["status"], string?]>) =>
  list.map(([step, status, reason]) =>
    reason ? { step, status, reason } : { step, status },
  );

/** One turn that calls `update_plan` and gets `outcome` back. */
function updateTurn(
  log: Log,
  turn: string,
  id: string,
  plan: unknown,
  outcome: "completed" | "failed" = "completed",
): void {
  log.user(turn, "work");
  log.request(turn, `${turn}-r1`);
  log.reply(turn, `${turn}-r1`, [call(id, "update_plan", plan)], "tool_use");
  log.finished(turn, id, outcome, "Plan updated.");
  log.request(turn, `${turn}-r2`);
  log.reply(turn, `${turn}-r2`, [text("Going on.")]);
  log.ended(turn);
}

describe("reading a plan", () => {
  it("trims the steps and keeps a reason only on an abandoned step", () => {
    assert.deepEqual(
      parsePlan({
        plan: [
          { step: "  Add the\nendpoint ", status: "completed", reason: "x" },
          {
            step: "Support SSO",
            status: "abandoned",
            reason: " Out of scope ",
          },
          { step: "Test it", status: "pending", reason: "" },
        ],
      }),
      steps(
        ["Add the endpoint", "completed"],
        ["Support SSO", "abandoned", "Out of scope"],
        ["Test it", "pending"],
      ),
    );
  });

  it("refuses what is not a plan", () => {
    for (const bad of [
      null,
      [],
      {},
      { plan: [] },
      { plan: ["step"] },
      { plan: [{ step: "", status: "pending" }] },
      { plan: [{ step: "a", status: "later" }] },
    ])
      assert.equal(parsePlan(bad as never), undefined, JSON.stringify(bad));
  });
});

describe("what an update changed", () => {
  const before = steps(
    ["Add it", "completed"],
    ["Wire it", "in_progress"],
    ["Test it", "pending"],
  );

  it("is a first plan when there was none", () => {
    assert.deepEqual(planChange(undefined, before), {
      kind: "created",
      total: 3,
    });
  });

  it("is progress when the same steps move on", () => {
    assert.deepEqual(
      planChange(
        before,
        steps(
          ["Add it", "completed"],
          ["Wire it", "completed"],
          ["Test it", "in_progress"],
        ),
      ),
      {
        kind: "progress",
        completed: [2],
        abandoned: [],
        started: 3,
        done: 2,
        total: 3,
      },
    );
    assert.deepEqual(
      planChange(
        before,
        steps(
          ["Add it", "completed"],
          ["Wire it", "in_progress"],
          ["Test it", "abandoned", "Not needed"],
        ),
      ),
      {
        kind: "progress",
        completed: [],
        abandoned: [3],
        started: undefined,
        done: 1,
        total: 3,
      },
    );
  });

  it("is a finished plan once no step is open", () => {
    assert.deepEqual(
      planChange(
        before,
        steps(
          ["Add it", "completed"],
          ["Wire it", "completed"],
          ["Test it", "completed"],
        ),
      ),
      { kind: "finished", completed: [2, 3], done: 3, abandoned: 0, total: 3 },
    );
  });

  it("is a first plan again when the steps replace a finished plan's", () => {
    assert.deepEqual(
      planChange(
        steps(["Add it", "completed"], ["Drop it", "abandoned", "No"]),
        steps(["Ship it", "in_progress"]),
      ),
      { kind: "created", total: 1 },
    );
  });

  it("is a revision when the steps themselves changed or a closed step reopened", () => {
    assert.deepEqual(
      planChange(
        before,
        steps(["Add it", "completed"], ["Ship it", "pending"]),
      ),
      { kind: "revised", total: 2 },
    );
    assert.deepEqual(
      planChange(
        before,
        steps(
          ["Add it", "pending"],
          ["Wire it", "in_progress"],
          ["Test it", "pending"],
        ),
      ),
      { kind: "revised", total: 3 },
    );
  });

  it("is nothing when nothing the person sees changed", () => {
    assert.deepEqual(planChange(before, before), { kind: "same" });
  });
});

describe("the plan in a transcript", () => {
  const first = input(["Add it", "in_progress"], ["Test it", "pending"]);
  const second = input(["Add it", "completed"], ["Test it", "in_progress"]);

  it("is the latest update that completed", () => {
    const log = new Log();
    updateTurn(log, "t1", "c1", first);
    // Refused: the plan stays as it was.
    updateTurn(
      log,
      "t2",
      "c2",
      input(["A", "in_progress"], ["B", "in_progress"]),
      "failed",
    );
    const transcript = reduceTranscript(log.records);
    assert.deepEqual(transcript.plan?.steps, parsePlan(first));
    assert.equal(transcript.plan?.turn, "t1");
    assert.equal(transcript.plan?.call, "c1");

    updateTurn(log, "t3", "c3", second);
    const later = reduceTranscript(log.records);
    assert.deepEqual(later.plan?.steps, parsePlan(second));
    assert.deepEqual(later.planChanges.get("c1"), {
      kind: "created",
      total: 2,
    });
    assert.equal(later.planChanges.get("c2"), undefined);
    assert.equal(later.planChanges.get("c3")?.kind, "progress");
  });

  it("is none before a call completed and when the answer was cut", () => {
    const log = new Log();
    log.user("t1", "work");
    log.request("t1", "r1");
    log.reply("t1", "r1", [call("c1", "update_plan", first)], "tool_use");
    assert.equal(reduceTranscript(log.records).plan, undefined);
  });

  it("goes back with a rewind, comes back with its undo, and a fork holds what it was cut at", () => {
    const log = new Log();
    updateTurn(log, "t1", "c1", first);
    const afterOne = log.head;
    updateTurn(log, "t2", "c2", second);
    const reducer = new TranscriptReducer();
    reducer.applyRecords(log.records);
    assert.deepEqual(reducer.snapshot().plan?.steps, parsePlan(second));

    const { finished } = log.rewind(afterOne);
    reducer.applyRecords(log.records.slice(-2));
    assert.deepEqual(reducer.snapshot().plan?.steps, parsePlan(first));
    assert.equal(reducer.snapshot().planChanges.has("c2"), false);

    log.undo(finished);
    reducer.applyRecords(log.records.slice(-1));
    assert.deepEqual(reducer.snapshot().plan?.steps, parsePlan(second));
    assert.equal(reducer.snapshot().planChanges.has("c2"), true);

    // A client that only ever saw the log up to the cut agrees.
    const forked = reduceTranscript(log.records.slice(0, afterOne));
    assert.deepEqual(forked.plan?.steps, parsePlan(first));
  });

  it("follows the order of the calls in a reply, whichever answered first", () => {
    const log = new Log();
    log.user("t1", "work");
    log.request("t1", "r1");
    log.reply(
      "t1",
      "r1",
      [
        call("a", "update_plan", input(["First", "pending"])),
        call("b", "update_plan", input(["Second", "pending"])),
      ],
      "tool_use",
    );
    log.finished("t1", "b", "completed", "Plan updated.");
    log.finished("t1", "a", "completed", "Plan updated.");
    assert.deepEqual(
      reduceTranscript(log.records).plan?.steps,
      steps(["Second", "pending"]),
    );
  });
});

describe("the plan of a whole log", () => {
  const first = input(["Add it", "in_progress"], ["Test it", "pending"]);
  const second = input(["Add it", "completed"], ["Test it", "in_progress"]);

  it("is what the reducer says, through rewinds and their undo", () => {
    const log = new Log();
    updateTurn(log, "t1", "c1", first);
    const afterOne = log.head;
    updateTurn(log, "t2", "c2", second);
    const { finished } = log.rewind(afterOne);
    const states = [log.records.slice(0, afterOne + 6), log.records];
    log.undo(finished);
    states.push(log.records);
    for (const records of states) {
      const reducer = new TranscriptReducer();
      reducer.applyRecords(records);
      assert.deepEqual(currentPlan(records), reducer.snapshot().plan);
    }
    assert.deepEqual(currentPlan(log.records)?.steps, parsePlan(second));
  });

  it("says how far it is, and when nothing moved", () => {
    const steps = parsePlan(second)!;
    assert.deepEqual(planProgress({ steps }), {
      done: 1,
      abandoned: 0,
      total: 2,
      current: "Test it",
    });
    assert.equal(planProgress(undefined), undefined);
    assert.ok(
      samePlanProgress(planProgress({ steps }), planProgress({ steps })),
    );
    assert.ok(
      !samePlanProgress(
        planProgress({ steps }),
        planProgress({ steps: parsePlan(first)! }),
      ),
    );
  });
});
