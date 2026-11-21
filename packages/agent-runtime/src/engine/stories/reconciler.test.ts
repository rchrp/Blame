import assert from "node:assert/strict";
import test from "node:test";

import { ReconcileScheduler } from "./reconciler.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a story has one reconcile pending, however often it is asked, and retries back off", async () => {
  let runs = 0;
  const scheduler = new ReconcileScheduler(
    async () => {
      runs += 1;
      throw new Error("the API does not answer");
    },
    (failures) => 40 * 2 ** (failures - 1),
  );
  try {
    for (let index = 0; index < 50; index += 1) scheduler.ask("story");
    await pause(20);
    assert.equal(runs, 1, "asked fifty times, run once");
    for (let index = 0; index < 50; index += 1) scheduler.ask("story");
    // Retries at 40, 120, 280 ms after the first failure: no more than that.
    await pause(330);
    assert.ok(runs >= 3 && runs <= 4, `${runs} runs`);
  } finally {
    scheduler.stop();
  }
});

test("a story asked again while its reconcile runs is reconciled once more after it", async () => {
  let runs = 0;
  let release!: () => void;
  const scheduler = new ReconcileScheduler(async () => {
    runs += 1;
    if (runs === 1) await new Promise<void>((resolve) => (release = resolve));
  });
  try {
    scheduler.ask("story");
    await pause(5);
    scheduler.ask("story");
    scheduler.ask("story");
    release();
    await pause(20);
    assert.equal(runs, 2);
  } finally {
    scheduler.stop();
  }
});
