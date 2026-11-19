import assert from "node:assert/strict";
import test from "node:test";
import { createHeavyWorkQueue } from "./runtime-heavy-work.ts";

const gib = 1024 * 1024 * 1024;
const estimates = {
  cold: 3 * gib,
  seeded: 1.5 * gib,
  build: 2 * gib,
  check: 2 * gib,
};

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a start alone compiles at once without reading memory", async () => {
  let reads = 0;
  const queue = createHeavyWorkQueue({
    estimates,
    availableMemory: async () => {
      reads += 1;
      return 0;
    },
  });
  const leave = await queue.enter("cold");
  assert.equal(reads, 0);
  assert.deepEqual(queue.state, { running: 1, waiting: 0 });
  leave();
  leave();
  assert.deepEqual(queue.state, { running: 0, waiting: 0 });
});

test("a cold start waits for the one compiling and says so", async () => {
  const events: string[] = [];
  const queue = createHeavyWorkQueue({
    estimates,
    availableMemory: async () => 4 * gib,
  });
  const leaveFirst = await queue.enter("cold");
  const second = queue
    .enter("cold", { onWait: () => events.push("second waits") })
    .then((leave) => {
      events.push("second compiles");
      return leave;
    });
  await tick();
  await tick();
  assert.deepEqual(events, ["second waits"]);
  leaveFirst();
  (await second)();
  assert.deepEqual(events, ["second waits", "second compiles"]);
  assert.deepEqual(queue.state, { running: 0, waiting: 0 });
});

test("seeded starts share the turn while memory covers every estimate", async () => {
  let available = 3.2 * gib;
  const waits: string[] = [];
  const queue = createHeavyWorkQueue({
    estimates,
    availableMemory: async () => available,
    recheckMs: 5,
  });
  const first = await queue.enter("seeded");
  const second = await queue.enter("seeded", {
    onWait: () => waits.push("second"),
  });
  assert.deepEqual(queue.state, { running: 2, waiting: 0 });
  // A third one needs 4.5 GiB of estimates: it waits until memory frees.
  let thirdIn = false;
  const third = queue
    .enter("seeded", { onWait: () => waits.push("third") })
    .then((leave) => {
      thirdIn = true;
      return leave;
    });
  await tick();
  await tick();
  assert.equal(thirdIn, false);
  available = 8 * gib;
  const leaveThird = await third;
  assert.equal(thirdIn, true);
  assert.deepEqual(waits, ["third"]);
  for (const leave of [first, second, leaveThird]) leave();
});

test("waiting starts keep their order, so seeded ones do not pass a cold one", async () => {
  const order: string[] = [];
  const queue = createHeavyWorkQueue({
    estimates,
    availableMemory: async () => 5 * gib,
  });
  const running = await queue.enter("seeded");
  const cold = queue.enter("cold").then((leave) => {
    order.push("cold");
    return leave;
  });
  const seeded = queue.enter("seeded").then((leave) => {
    order.push("seeded");
    return leave;
  });
  await tick();
  await tick();
  // 1.5 + 3 GiB fit in 5 GiB: the cold one joins, the seeded one waits.
  assert.deepEqual(order, ["cold"]);
  running();
  (await cold)();
  (await seeded)();
  assert.deepEqual(order, ["cold", "seeded"]);
});

test("a start waits while the memory cannot be read", async () => {
  const queue = createHeavyWorkQueue({
    estimates,
    availableMemory: async () => {
      throw new Error("runtime unreachable");
    },
  });
  const first = await queue.enter("seeded");
  let secondIn = false;
  const second = queue.enter("seeded").then((leave) => {
    secondIn = true;
    return leave;
  });
  await tick();
  assert.equal(secondIn, false);
  first();
  (await second)();
  assert.equal(secondIn, true);
});

test("an agent's check never waits for previews or review builds", async () => {
  const queue = createHeavyWorkQueue({
    estimates,
    availableMemory: async () => 0,
  });
  const cold = await queue.enter("cold");
  const build = queue.enter("build");
  const check = await queue.enter("check", { owner: "session-a" });
  assert.deepEqual(queue.state, { running: 2, waiting: 1 });
  cold();
  check();
  (await build)();
});

test("a check waits for another agent's check and says why", async () => {
  const reasons: string[] = [];
  const queue = createHeavyWorkQueue({
    estimates,
    availableMemory: async () => 3 * gib,
  });
  const first = await queue.enter("check", { owner: "session-a" });
  // The session's own next check takes its turn in the harness instead.
  const own = await queue.enter("check", { owner: "session-a" });
  let secondIn = false;
  const second = queue
    .enter("check", {
      owner: "session-b",
      onWait: (reason) => reasons.push(reason),
    })
    .then((leave) => {
      secondIn = true;
      return leave;
    });
  await tick();
  await tick();
  assert.equal(secondIn, false);
  assert.deepEqual(reasons, ["another agent's build or tests"]);
  first();
  own();
  (await second)();
  assert.deepEqual(queue.state, { running: 0, waiting: 0 });
});

test("work that gives up waiting leaves the queue", async () => {
  const queue = createHeavyWorkQueue({
    estimates,
    availableMemory: async () => 0,
  });
  const running = await queue.enter("seeded");
  const controller = new AbortController();
  const waiting = queue.enter("build", { signal: controller.signal });
  await tick();
  controller.abort(new Error("stopped"));
  await assert.rejects(waiting, /stopped/);
  assert.deepEqual(queue.state, { running: 1, waiting: 0 });
  running();
});
