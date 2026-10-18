import assert from "node:assert/strict";
import test from "node:test";
import { data, fixture, LightFinishService, LightWorkspace } from "./light-agent-guidance-fixture.js";
import { SessionJournal } from "./session-journal.js";
import { latestFailedInvocations } from "./light-check-repair.js";
import type { LightCompletionNotification } from "./light-completion.js";

const alpha = ["--test-name-pattern=alpha", "suite.test.cjs"];
const beta = ["--test-name-pattern=beta", "suite.test.cjs"];
const files = {
  "package.json": JSON.stringify({ scripts: { test: "node --test", build: "node --check value.cjs" } }),
  "value.cjs": "exports.value = 1;\n",
  "suite.test.cjs": "const {test}=require('node:test');const assert=require('node:assert/strict');const {value}=require('./value.cjs');test('alpha',()=>assert.equal(value,2));test('beta',()=>assert.ok(value<4));\n",
};
const requirements = [{ id: "build", task: "build" }, { id: "alpha", task: "test", args: alpha }, { id: "beta", task: "test", args: beta }];
async function edit(workspace: InstanceType<typeof LightWorkspace>, before: number, after: number) {
  return data(await workspace.editCode({ operations: [{ kind: "patch", path: "value.cjs",
    patch: `*** Begin Patch\n*** Update File: value.cjs\n@@\n-exports.value = ${before};\n+exports.value = ${after};\n*** End Patch` }] }));
}

test("repair advice keeps the failed literal selection after another filter passes and after a source edit", async () => {
  await fixture(files, async (_, root) => {
    const workspace = new LightWorkspace(root, { sessionId: "guidance", taskContract: { required_checks: requirements } });
    const failed = data(await workspace.runTask({ kind: "project", task: "test", args: alpha }, {}));
    assert.deepEqual(failed.validationRepair.repairFirst[0].input.args, alpha);
    const passed = data(await workspace.runTask({ kind: "project", task: "test", args: beta }, {}));
    assert.deepEqual(passed.validationRepair.repairFirst.map((v: { input: unknown }) => v.input), [{ kind: "project", task: "test", args: alpha }]);
    const result = await edit(workspace, 1, 2);
    assert.equal(result.validationRepair.repairFirst[0].freshness, "earlier_source");
    assert.equal(result.validationRepair.advisoryOnly, true);
    assert.equal(result.validationRepair.requiredAfterRepair.length, 3);
    assert.equal(data(await workspace.readCode({ target: "@checks" }, {})).checks.length, 0, "Advice does not reclassify an old failure as current");
    const repaired = data(await workspace.runTask({ kind: "project", task: "test", args: alpha }, {}));
    assert.equal(repaired.validationRepair, undefined);
    assert.equal(repaired.reporting.admission, "unverified");
  });
});

test("finish refreshes the known failure first, stops on failure, then requires every final-source invocation", async () => {
  await fixture(files, async (workspace, root) => {
    await workspace.runTask({ kind: "project", task: "test", args: alpha }, {});
    await workspace.runTask({ kind: "project", task: "test", args: beta }, {});
    await workspace.runTask({ kind: "project", task: "build" }, {});
    await edit(workspace, 1, 3);
    const started: unknown[] = [], notifications: LightCompletionNotification[] = [];
    const service = new LightFinishService({ workspaceRoot: root, conversationId: "guidance",
      taskContract: { required_checks: requirements }, onComplete: n => { notifications.push(n); },
      onValidationActivity: a => { if (a.phase === "started") started.push(a.input); } });
    await assert.rejects(service.finish("not repaired", {} as never), /still failing/u);
    assert.deepEqual(started, [{ kind: "project", task: "test", args: alpha }]);
    assert.equal(notifications.length, 0);
    await edit(workspace, 3, 2);
    started.length = 0;
    await service.finish("Final source checked; behavior acceptance is separate.", {} as never);
    assert.deepEqual(started[0], { kind: "project", task: "test", args: alpha });
    assert.equal(started.length, 3);
    const state = await new SessionJournal(root, "guidance").completionSnapshot();
    assert.equal(state.validations.length, 3);
    assert.ok(state.validations.every(v => v.sourceRevisionId === state.sourceRevisionId));
    assert.ok(notifications[0]?.completion.satisfied_obligations.includes("check:beta"));
    assert.equal(notifications[0]?.completion.verification, "verified");
  });
});

test("advisory failure identity includes cwd, argv and task, and does not suggest replaying raw commands", () => {
  const entry = { id: "x", paths: [], files: [], status: "failed", terminal: "failed" as const,
    check: undefined, category: "code" as const, command: undefined, recovery: undefined, sourceRevisionId: undefined,
    timestamp: "now", taskKind: "test", taskId: "test", cwd: "a", args: alpha };
  const latest = latestFailedInvocations([entry, { ...entry, cwd: "b", terminal: "passed", status: "passed" },
    { ...entry, args: beta, terminal: "passed", status: "passed" },
    { ...entry, taskId: undefined, command: "some mutating command" }]);
  assert.equal(latest.length, 1);
  assert.deepEqual(latest[0]?.args, alpha);
});
