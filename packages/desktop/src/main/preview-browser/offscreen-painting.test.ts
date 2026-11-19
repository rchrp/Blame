import assert from "node:assert/strict";
import test from "node:test";
import { paintOnDemand } from "./offscreen-painting.ts";

function fakeContents() {
  const calls: string[] = [];
  let painting = true;
  return {
    calls,
    contents: {
      invalidate: () => calls.push("invalidate"),
      isDestroyed: () => false,
      isPainting: () => painting,
      setFrameRate: (rate: number) => calls.push(`rate ${rate}`),
      startPainting: () => {
        painting = true;
        calls.push("start");
      },
      stopPainting: () => {
        painting = false;
        calls.push("stop");
      },
    },
  };
}

test("an offscreen page idles until used, then repaints a fresh frame", () => {
  const { calls, contents } = fakeContents();
  const painting = paintOnDemand(contents, { frameRate: 30, graceMs: 0 });
  assert.deepEqual(calls, ["rate 1", "stop"]);
  calls.length = 0;
  const done = painting.begin();
  assert.deepEqual(calls, ["rate 30", "start", "invalidate"]);
  calls.length = 0;
  done();
  done();
  assert.deepEqual(calls, ["rate 1", "stop"]);
});

test("overlapping uses keep painting until the last one ends and the grace passes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, contents } = fakeContents();
  const painting = paintOnDemand(contents, { frameRate: 30, graceMs: 3_000 });
  calls.length = 0;
  const first = painting.begin();
  const second = painting.begin();
  assert.deepEqual(calls, ["rate 30", "start", "invalidate"]);
  first();
  t.mock.timers.tick(5_000);
  assert.deepEqual(calls.slice(3), []);
  second();
  t.mock.timers.tick(2_999);
  assert.deepEqual(calls.slice(3), []);
  // A use within the grace cancels the pending stop.
  const third = painting.begin();
  t.mock.timers.tick(10_000);
  assert.deepEqual(calls.slice(3), []);
  third();
  t.mock.timers.tick(3_000);
  assert.deepEqual(calls.slice(3), ["rate 1", "stop"]);
  painting.dispose();
});
