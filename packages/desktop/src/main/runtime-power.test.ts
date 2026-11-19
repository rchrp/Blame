import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimePower,
  RuntimeStoppedError,
  runtimeBackground,
  runtimeIdleStopMs,
  type RuntimeAvailability,
  type RuntimePowerEvent,
} from "./runtime-power.ts";

function fakeRuntime(initial: RuntimeAvailability = "stopped") {
  const events: RuntimePowerEvent["state"][] = [];
  const calls: string[] = [];
  let availability = initial;
  let clock = 0;
  let startGate: Promise<void> | undefined;
  let failStart: Error | undefined;
  const busy = new Set<() => boolean>();
  const started = new Set<() => void>();
  const power = new RuntimePower(
    {
      availability: async () => {
        calls.push("availability");
        return availability;
      },
      start: async (onProgress) => {
        calls.push("start");
        onProgress({ phase: "starting" });
        await startGate;
        if (failStart) throw failStart;
        availability = "running";
      },
      stop: async () => {
        calls.push("stop");
        availability = "stopped";
      },
      notify: (event) => events.push(event.state),
      now: () => clock,
    },
    busy,
    started,
  );
  return {
    busy,
    calls,
    events,
    power,
    started,
    advance(ms: number) {
      clock += ms;
    },
    holdStart() {
      let release = () => undefined as void;
      startGate = new Promise((resolve) => (release = resolve));
      return () => {
        startGate = undefined;
        release();
      };
    },
    failStartWith(error?: Error) {
      failStart = error;
    },
  };
}

test("starts a stopped runtime once for every request waiting on it", async () => {
  const runtime = fakeRuntime();
  let starts = 0;
  runtime.started.add(() => (starts += 1));
  const release = runtime.holdStart();
  const requests = [
    runtime.power.ensureRunning(),
    runtime.power.ensureRunning(),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all(requests);
  await runtime.power.ensureRunning();
  assert.deepEqual(runtime.calls, ["availability", "start"]);
  assert.deepEqual(runtime.events, ["starting", "starting", "running"]);
  assert.equal(starts, 1);
});

test("adopts a runtime already running without a start", async () => {
  const runtime = fakeRuntime("running");
  await runtime.power.ensureRunning();
  assert.deepEqual(runtime.calls, ["availability"]);
  assert.deepEqual(runtime.events, ["running"]);
});

test("never installs a missing runtime on its own", async () => {
  const runtime = fakeRuntime("unavailable");
  await assert.rejects(runtime.power.ensureRunning(), /not installed/);
  assert.deepEqual(runtime.calls, ["availability"]);
});

test("background work neither starts the runtime nor counts as use", async () => {
  const runtime = fakeRuntime();
  await assert.rejects(
    runtimeBackground(() => runtime.power.ensureRunning()),
    RuntimeStoppedError,
  );
  assert.deepEqual(runtime.calls, ["availability"]);
  assert.equal(runtime.power.current(), "stopped");

  await runtime.power.ensureRunning();
  runtime.advance(runtimeIdleStopMs - 1);
  const release = runtimeBackground(() => runtime.power.hold());
  runtime.advance(1);
  release();
  assert.equal(await runtime.power.stopIfIdle(), true);
});

test("background work rides along a start already under way", async () => {
  const runtime = fakeRuntime();
  const release = runtime.holdStart();
  const request = runtime.power.ensureRunning();
  await new Promise((resolve) => setImmediate(resolve));
  const look = runtimeBackground(() => runtime.power.ensureRunning());
  release();
  await Promise.all([request, look]);
  assert.deepEqual(runtime.calls, ["availability", "start"]);
});

test("stops once nothing used it for the idle delay", async () => {
  const runtime = fakeRuntime();
  await runtime.power.ensureRunning();
  runtime.advance(runtimeIdleStopMs - 1);
  assert.equal(await runtime.power.stopIfIdle(), false);
  runtime.advance(1);
  assert.equal(await runtime.power.stopIfIdle(), true);
  assert.equal(runtime.power.current(), "stopped");
  assert.deepEqual(runtime.events.slice(-2), ["stopping", "stopped"]);
});

test("a request or a stream in progress keeps it running", async () => {
  const runtime = fakeRuntime();
  await runtime.power.ensureRunning();
  const release = runtime.power.hold();
  runtime.advance(2 * runtimeIdleStopMs);
  assert.equal(await runtime.power.stopIfIdle(), false);
  release();
  assert.equal(await runtime.power.stopIfIdle(), false);
  runtime.advance(runtimeIdleStopMs);
  assert.equal(await runtime.power.stopIfIdle(), true);
});

test("an agent at work or an awake preview counts as use", async () => {
  const runtime = fakeRuntime();
  let working = true;
  runtime.busy.add(() => working);
  await runtime.power.ensureRunning();
  runtime.advance(3 * runtimeIdleStopMs);
  assert.equal(await runtime.power.stopIfIdle(), false);
  working = false;
  runtime.advance(runtimeIdleStopMs - 1);
  assert.equal(await runtime.power.stopIfIdle(), false);
  runtime.advance(1);
  assert.equal(await runtime.power.stopIfIdle(), true);
});

test("never stops during an install, update or repair", async () => {
  const runtime = fakeRuntime("running");
  await runtime.power.ensureRunning();
  runtime.advance(runtimeIdleStopMs);
  let finish = () => undefined as void;
  const operation = runtime.power.operation(
    () =>
      new Promise<{ status: string }>((resolve) => {
        finish = () => resolve({ status: "ready" });
      }),
  );
  assert.equal(await runtime.power.stopIfIdle(), false);
  finish();
  await operation;
  assert.equal(await runtime.power.stopIfIdle(), false);
  runtime.advance(runtimeIdleStopMs);
  assert.equal(await runtime.power.stopIfIdle(), true);
});

test("a request after a stop starts it again", async () => {
  const runtime = fakeRuntime();
  await runtime.power.ensureRunning();
  runtime.advance(runtimeIdleStopMs);
  await runtime.power.stopIfIdle();
  await runtime.power.ensureRunning();
  assert.deepEqual(runtime.calls, [
    "availability",
    "start",
    "stop",
    "availability",
    "start",
  ]);
  assert.equal(runtime.power.current(), "running");
});

test("reports a failed start and tries again on the next request", async () => {
  const runtime = fakeRuntime();
  runtime.failStartWith(new Error("Docker did not start"));
  await assert.rejects(runtime.power.ensureRunning(), /Docker did not start/);
  assert.deepEqual(runtime.events, ["starting", "starting", "stopped"]);
  runtime.failStartWith(undefined);
  await runtime.power.ensureRunning();
  assert.equal(runtime.power.current(), "running");
});

test("looks again after its connection to the runtime was lost", async () => {
  const runtime = fakeRuntime();
  await runtime.power.ensureRunning();
  runtime.power.connectionLost();
  await runtime.power.ensureRunning();
  assert.deepEqual(runtime.calls, ["availability", "start", "availability"]);
});
