import assert from "node:assert/strict";
import test from "node:test";
import { createCompileQueue } from "./local-preview-compile-queue.ts";

const gib = 1024 * 1024 * 1024;
const estimates = { cold: 3 * gib, seeded: 1.5 * gib };

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a start alone compiles at once without reading memory", async () => {
  let reads = 0;
  const queue = createCompileQueue({
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
  const queue = createCompileQueue({
    estimates,
    availableMemory: async () => 4 * gib,
  });
  const leaveFirst = await queue.enter("cold");
  const second = queue
    .enter("cold", () => events.push("second waits"))
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
  const queue = createCompileQueue({
    estimates,
    availableMemory: async () => available,
    recheckMs: 5,
  });
  const first = await queue.enter("seeded");
  const second = await queue.enter("seeded", () => waits.push("second"));
  assert.deepEqual(queue.state, { running: 2, waiting: 0 });
  // A third one needs 4.5 GiB of estimates: it waits until memory frees.
  let thirdIn = false;
  const third = queue
    .enter("seeded", () => waits.push("third"))
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
  const queue = createCompileQueue({
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
  const queue = createCompileQueue({
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
