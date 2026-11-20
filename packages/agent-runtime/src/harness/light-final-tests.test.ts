import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./test-client/light-workspace.js";
import { SessionJournal } from "./session-journal.js";
import type { LightCompletionNotification } from "./test-client/light-finish-service.js";

import { LightFinishService } from "./test-client/light-finish-service.js";
const suite = `const {test}=require('node:test'); const assert=require('node:assert/strict');
const {value}=require('./value.cjs');
test('alpha',()=>assert.ok(value===2||value===3));
test('beta',()=>assert.ok(value===2||value===3));\n`;
const alpha = ["--test-name-pattern=alpha", "suite.test.cjs"];
const beta = ["--test-name-pattern=beta", "suite.test.cjs"];

async function fixture(run: (root: string, workspace: LightWorkspace) => Promise<void>, extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "blame-final-tests-"));
  try {
    for (const [path, content] of Object.entries({
      "package.json": JSON.stringify({ scripts: { test: "node --test", build: "node --check value.cjs" } }),
      "value.cjs": "exports.value = 1;\n", "suite.test.cjs": suite, ...extra,
    })) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await run(root, new LightWorkspace(root, { sessionId: "refresh" }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function edit(workspace: LightWorkspace, before: number, after: number) {
  const result = await workspace.editCode({ operations: [{ kind: "patch", path: "value.cjs",
    patch: `*** Begin Patch\n*** Update File: value.cjs\n@@\n-exports.value = ${before};\n+exports.value = ${after};\n*** End Patch` }] });
  assert.equal(result.status, "ok", JSON.stringify(result));
}
async function check(workspace: LightWorkspace, args?: string[]) {
  return workspace.runTask({ kind: "project", task: "test", ...(args ? { args } : {}) }, {});
}
function finish(root: string) {
  const activities: unknown[] = [];
  const activityIds: Array<{ id: string; phase: string }> = [];
  const notifications: LightCompletionNotification[] = [];
  const service = new LightFinishService({ workspaceRoot: root, conversationId: "refresh",
    onValidationActivity: activity => {
      activityIds.push({ id: activity.toolCallId, phase: activity.phase });
      if (activity.phase === "started") activities.push(activity.input);
    },
    onComplete: notification => { notifications.push(notification); },
  });
  return { service, activities, notifications, activityIds };
}

test("final edit refreshes both exact requested test selections despite a current build", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2);
    await check(workspace, alpha); await check(workspace, beta);
    await edit(workspace, 2, 3);
    await workspace.runTask({ kind: "project", task: "build" }, {});
    const { service, activities, notifications, activityIds } = finish(root);
    await service.finish("done", {} as never);
    const starts = activityIds.filter(a => a.phase === "started");
    assert.equal(new Set(starts.map(a => a.id)).size, 2, "Automatic invocations need distinct observer identities.");
    for (const start of starts)
      assert.deepEqual(activityIds.filter(a => a.id === start.id).map(a => a.phase), ["started", "finished"]);
    assert.deepEqual(activities, [
      { kind: "project", task: "test", args: alpha },
      { kind: "project", task: "test", args: beta },
    ]);
    const snapshot = await new SessionJournal(root, "refresh").completionSnapshot();
    const tests = snapshot.validations.filter(v => v.taskKind === "test");
    assert.equal(tests.length, 2);
    for (const validation of tests) {
      assert.equal(validation.check?.outcome, "passed");
      assert.equal(validation.check?.counts?.executed, 1);
      assert.equal(validation.status, "unknown");
      assert.equal(validation.check?.selection, "unknown");
      assert.equal(validation.sourceRevisionId, snapshot.sourceRevisionId);
    }
    assert.equal(notifications[0]?.verified, true); // The build, never test coverage.
    assert.equal(notifications[0]?.memory?.validationTaskId, "build",
      "Unknown test selections must not suppress memory tied to an admitted build.");
    await service.finish("done again", {} as never);
    assert.equal(activities.length, 2, "Current unknown observations must not loop.");
  });
});

test("a current different filter cannot suppress a stale selection", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2); await check(workspace, alpha);
    await edit(workspace, 2, 3); await check(workspace, beta);
    const { service, activities, notifications } = finish(root);
    await service.finish("done", {} as never);
    assert.deepEqual(activities, [{ kind: "project", task: "test", args: alpha }]);
    assert.equal(notifications[0]?.verified, false);
  });
});

test("passing invocation is explained separately from unverified test scope", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2);
    await check(workspace, alpha);
    const { service, activities, notifications } = finish(root);
    await service.finish("done", {} as never);
    const state = await new SessionJournal(root, "refresh").completionSnapshot();
    assert.equal(state.validations[0]?.check?.outcome, "passed");
    assert.equal(state.validations[0]?.check?.counts?.executed, 1);
    assert.equal(state.validations[0]?.check?.selection, "unknown");
    assert.equal(state.validations[0]?.terminal, "unknown");
    assert.deepEqual(activities, [], "Current unknown evidence must not cause an extra test invocation.");
    assert.equal(notifications[0]?.verified, false);
    assert.equal(notifications[0]?.completion.verification, "unverified");
    assert.deepEqual(notifications[0]?.completion.satisfied_obligations, []);
    assert.match(notifications[0]?.completion.reservations.find(r => r.code === "VALIDATION_UNAVAILABLE")?.message ?? "",
      /invocation reported a passing result.*does not establish verification/u);
  });
});

test("stale failing selection is exposed instead of being replaced by a broader task", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2); await check(workspace, alpha);
    await edit(workspace, 2, 3);
    await workspace.runTask({ kind: "project", task: "build" }, {});
    const { service, activities, notifications } = finish(root);
    await assert.rejects(service.finish("done", {} as never), /still failing/u);
    assert.deepEqual(activities, [{ kind: "project", task: "test", args: alpha }]);
    assert.equal(notifications.length, 0);
    const snapshot = await new SessionJournal(root, "refresh").completionSnapshot();
    assert.ok(snapshot.validations.some(v => v.args?.[0] === alpha[0] && v.terminal === "failed"));
  }, { "suite.test.cjs": suite.replace("value===2||value===3", "value===2") });
});

test("zero selected tests stay unknown and are not rerun repeatedly", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2);
    const args = ["suite.test.cjs"];
    await check(workspace, args); await edit(workspace, 2, 3);
    const { service, notifications, activities } = finish(root);
    await service.finish("done", {} as never);
    const snapshot = await new SessionJournal(root, "refresh").completionSnapshot();
    assert.equal(snapshot.validations[0]?.check?.execution, "zero_tests");
    assert.equal(snapshot.validations[0]?.terminal, "unknown");
    assert.equal(notifications[0]?.verified, false);
    await service.finish("done", {} as never);
    assert.equal(activities.length, 1);
    assert.equal(notifications[0]?.completion.reservations.find(r => r.code === "VALIDATION_UNAVAILABLE")?.message,
      "No current project validation was available.");
  }, { "suite.test.cjs": "require('node:test').test('skipped', {skip:true}, ()=>{});\n" });
});

test("unmatched shell tests are observed but not guessed as project selections", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2);
    await workspace.runTask({ kind: "command", command: "node --test --test-name-pattern=alpha suite.test.cjs" }, {});
    await edit(workspace, 2, 3);
    const { service, activities, notifications } = finish(root);
    await service.finish("done", {} as never);
    assert.deepEqual(activities, []);
    assert.equal(notifications[0]?.verified, false);
    assert.equal(notifications[0]?.completion.reservations.find(r => r.code === "VALIDATION_UNAVAILABLE")?.message,
      "No current project validation was available.");
  });
});

test("a test in an unrelated child package is not automatically broadened", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2);
    await workspace.runTask({ kind: "project", task: "child:test" }, {});
    await edit(workspace, 2, 3);
    const { service, activities, notifications } = finish(root);
    await service.finish("done", {} as never);
    assert.deepEqual(activities, []);
    assert.equal(notifications[0]?.verified, false);
  }, { "child/package.json": JSON.stringify({ name: "child", scripts: { test: "node --test child.test.cjs" } }),
    "child/child.test.cjs": "require('node:test').test('child',()=>{});\n" });
});

test("external source changes also refresh literal test argv", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2); await check(workspace, alpha);
    await writeFile(join(root, "suite.test.cjs"), (await readFile(join(root, "suite.test.cjs"), "utf8")).replace("'alpha'", "'alpha renamed'"));
    const { service, activities, notifications } = finish(root);
    await service.finish("done", {} as never);
    assert.deepEqual(activities, [{ kind: "project", task: "test", args: alpha }]);
    assert.equal(notifications[0]?.verified, false);
  });
});

test("automatic refresh is bounded and missing checks are not silently discarded", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2);
    for (let n = 0; n < 17; n++) await check(workspace, [`--test-name-pattern=absent${n}`, "suite.test.cjs"]);
    await edit(workspace, 2, 3);
    const { service, activities, notifications } = finish(root);
    await assert.rejects(service.finish("done", {} as never), /16.*test.*Refresh/u);
    assert.deepEqual(activities, []);
    assert.deepEqual(notifications, []);
  });
});


test("stale environment failure is retried once with its selection and remains unavailable", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2); await check(workspace, alpha);
    await edit(workspace, 2, 3);
    const { service, activities, notifications } = finish(root);
    await service.finish("Environment unavailable", {} as never);
    assert.deepEqual(activities, [{ kind: "project", task: "test", args: alpha }]);
    const snapshot = await new SessionJournal(root, "refresh").completionSnapshot();
    assert.equal(snapshot.validations[0]?.category, "environment");
    assert.equal(snapshot.validations[0]?.terminal, "failed");
    assert.equal(notifications[0]?.verified, false);
    await service.finish("Still unavailable", {} as never);
    assert.equal(activities.length, 1);
  }, { "suite.test.cjs": "throw new Error('Missing environment variable: BLAME_REFRESH_CONTROL_SETTING');\n" });
});

test("finish waits for a refreshed test beyond the initial command window", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2);
    const journal = new SessionJournal(root, "refresh");
    const snapshot = await journal.completionSnapshot();
    await journal.recordValidation({ status: "unknown", taskId: "test", taskKind: "test", cwd: ".",
      args: ["long.test.cjs"], sourceRevisionId: snapshot.sourceRevisionId, command: "npm run test -- long.test.cjs" });
    await edit(workspace, 2, 3);
    const { service, notifications } = finish(root);
    await service.finish("done", {} as never);
    const final = await new SessionJournal(root, "refresh").completionSnapshot();
    assert.equal(final.validations[0]?.check?.outcome, "passed");
    assert.equal(final.validations[0]?.check?.process, "exited");
    assert.equal(notifications[0]?.verified, false);
  }, { "long.test.cjs": "require('node:test').test('slow',async()=>{await new Promise(r=>setTimeout(r,16000));});\n" });
});


test("cancelled final refresh cannot publish completion", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 1, 2); await check(workspace, alpha);
    await edit(workspace, 2, 3);
    const { service, notifications } = finish(root);
    await assert.rejects(service.finish("done", { signal: AbortSignal.abort(new Error("Refresh cancelled")) } as never), /Refresh cancelled/u);
    assert.deepEqual(notifications, []);
  });
});
