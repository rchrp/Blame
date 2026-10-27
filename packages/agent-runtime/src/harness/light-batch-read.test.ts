import assert from "node:assert/strict";
import test from "node:test";
import { data, fixture } from "./light-agent-guidance-fixture.js";
import { lightSemanticHarnessTools } from "./light-tools.js";
import { batchRead } from "./light-batch-read.js";

test("independent reads keep ordinary aliases, statuses and edit coverage", async () => {
  await fixture({ "a.ts": "export function first() { return 1; }\n", "b.ts": "export function second() { return 2; }\n" }, async workspace => {
    const result = data(await workspace.readCode({ reads: [{ target: "a.ts#first" }, { target: "missing.ts" }, { target: "b.ts#second", view: "signature" }] }, {}));
    assert.equal(result.view, "batch"); assert.equal(result.complete, true);
    assert.deepEqual(result.results.map((r: { result: { status: string } }) => r.result.status), ["ok", "blocked", "ok"]);
    assert.equal((await workspace.editCode({ operations: [{ kind: "symbol", target: "a.ts#first", action: "replace_body", content: "return 3;" }] })).status, "ok");
    assert.equal((await workspace.editCode({ operations: [{ kind: "symbol", target: "b.ts#second", action: "replace_body", content: "return 4;" }] })).status, "blocked", "A signature is not a body read");
  });
});

test("aggregate budget omits a large read and rolls back all its observation state", async () => {
  await fixture({ "a.ts": "export function first() { return 1; }\n", "large.ts": "export function large() {\n" + "  void 1;\n".repeat(1800) + "return 2;\n}\n" }, async workspace => {
    const result = data(await workspace.readCode({ reads: [{ target: "a.ts#first" }, { target: "large.ts", view: "raw" }] }, {}));
    assert.equal(result.complete, false); assert.equal(result.results.length, 1);
    assert.deepEqual(result.remainingReads, [{ target: "large.ts", view: "raw" }]);
    assert.ok(JSON.stringify(result).length <= 6_000);
    assert.equal((await workspace.editCode({ operations: [{ kind: "symbol", target: "large.ts#large", action: "replace_body", content: "return 5;" }] })).status, "blocked");
    assert.equal((await workspace.editCode({ operations: [{ kind: "symbol", target: "a.ts#first", action: "replace_body", content: "return 6;" }] })).status, "ok");
  });
});

test("source changes and cancellation roll back a group rather than claiming unseen coverage", async () => {
  for (const cancelled of [false, true]) {
    let observed = 0, revision = "before", restored = false;
    const controller = new AbortController();
    await assert.rejects(batchRead([{ target: "a.ts" }, { target: "b.ts" }], {
      checkpoint: () => observed,
      restore: async state => { observed = state; restored = true; },
      revision: async () => revision,
      read: async () => { observed++; revision = "after"; if (cancelled) controller.abort(); return { status: "ok", data: {} }; },
      observed: async () => {}, signal: controller.signal,
    }));
    assert.equal(observed, 0); assert.equal(restored, true);
  }
});

test("the model schema only exposes grouping when explicitly enabled", async () => {
  const previous = process.env.BLAME_AGENT_BATCH_READS;
  await fixture({ "a.ts": "export const first=1;", "b.ts": "export const second=2;" }, async (_, root) => {
    const input = { reads: [{ target: "a.ts" }, { target: "b.ts" }] };
    process.env.BLAME_AGENT_BATCH_READS = "false";
    assert.equal((await lightSemanticHarnessTools(root).find(t => t.name === "read_code")!.execute(input, {} as never) as { status: string }).status, "blocked");
    process.env.BLAME_AGENT_BATCH_READS = "true";
    assert.equal((await lightSemanticHarnessTools(root).find(t => t.name === "read_code")!.execute(input, {} as never) as { status: string }).status, "ok");
  }).finally(() => { if (previous === undefined) delete process.env.BLAME_AGENT_BATCH_READS; else process.env.BLAME_AGENT_BATCH_READS = previous; });
});
