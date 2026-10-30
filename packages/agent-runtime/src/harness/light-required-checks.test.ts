import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./light-workspace.js";
import { SessionJournal } from "./session-journal.js";
import type { LightCompletionNotification } from "./light-completion.js";
import { lightRequiredChecksSchema, type RequiredProjectCheck } from "./light-contracts.js";
import { createInitialTaskBriefing } from "./initial-task-briefing.js";
import { executeLocalFinishTask } from "./light-finish-service.js";
import { completionAwareTerminalState } from "./run-lifecycle.js";

const { LightFinishService } = await import(
  process.env.BLAME_REQUIRED_CHECKS_MODULE ?? "./light-finish-service.js"
) as typeof import("./light-finish-service.js");
const alpha = ["--test-name-pattern=alpha", "suite.test.cjs"];
const beta = ["--test-name-pattern=beta", "suite.test.cjs"];
const suite = `const {test}=require('node:test'); const assert=require('node:assert/strict');
const {value}=require('./value.cjs');
test('alpha',()=>assert.equal(value,2)); test('beta',()=>assert.equal(value,2));\n`;

async function fixture(run: (root: string, workspace: LightWorkspace) => Promise<void>, extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "blame-required-checks-"));
  try {
    for (const [path, content] of Object.entries({
      "package.json": JSON.stringify({ scripts: { test: "node --test", build: "node --check value.cjs", dev: "node value.cjs" } }),
      "value.cjs": "exports.value = 1;\n", "suite.test.cjs": suite, ...extra,
    })) {
      await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content);
    }
    await run(root, new LightWorkspace(root, { sessionId: "required" }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function edit(workspace: LightWorkspace, after = 2) {
  const result = await workspace.editCode({ operations: [{ kind: "patch", path: "value.cjs",
    patch: `*** Begin Patch\n*** Update File: value.cjs\n@@\n-exports.value = 1;\n+exports.value = ${after};\n*** End Patch` }] });
  assert.equal(result.status, "ok", JSON.stringify(result));
}
async function build(workspace: LightWorkspace) {
  assert.equal((await workspace.runTask({ kind: "project", task: "build" }, {})).status, "ok");
}
function finish(root: string, required_checks?: RequiredProjectCheck[]) {
  const activities: unknown[] = [], notifications: LightCompletionNotification[] = [];
  const service = new LightFinishService({ workspaceRoot: root, conversationId: "required",
    taskContract: { required_checks }, onComplete: n => { notifications.push(n); },
    onValidationActivity: a => { if (a.phase === "started") activities.push(a.input); },
  });
  return { service, activities, notifications };
}

test("never-attempted failing required test blocks completion despite an admitted build", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 3); await build(workspace);
    const { service, activities, notifications } = finish(root, [{ id: "alpha", task: "test", args: alpha }]);
    await assert.rejects(service.finish("done", {} as never), /still failing/u);
    assert.deepEqual(activities, [{ kind: "project", task: "test", args: alpha }]);
    assert.equal(notifications.length, 0);
    const state = await new SessionJournal(root, "required").completionSnapshot();
    assert.ok(state.validations.some(v => v.check?.outcome === "failed" && v.sourceRevisionId === state.sourceRevisionId));
  });
});

test("two never-attempted literal selections run once and keep scope admission separate", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const { service, activities, notifications } = finish(root, [
      { id: "alpha", task: "test", args: alpha }, { id: "beta", task: "test", args: beta },
    ]);
    await service.finish("done", {} as never); await service.finish("done again", {} as never);
    assert.deepEqual(activities, [alpha, beta].map(args => ({ kind: "project", task: "test", args })));
    assert.equal(notifications[0]?.verified, true); // The build supplies scope, not these tests.
    assert.deepEqual(notifications[0]?.completion.satisfied_obligations, ["validation", "check:alpha", "check:beta"]);
    const state = await new SessionJournal(root, "required").completionSnapshot();
    for (const v of state.validations.filter(v => v.taskKind === "test")) {
      assert.equal(v.check?.counts?.executed, 1); assert.equal(v.status, "unknown");
      assert.equal(v.check?.selection, "unknown"); assert.equal(v.check?.freshness, "unknown");
      assert.equal(v.sourceRevisionId, state.sourceRevisionId);
    }
    assert.equal(notifications[0]?.memory?.validationTaskId, "build");
  });
});

test("required passing test execution alone does not establish scope coverage", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace);
    const { service, notifications } = finish(root, [{ id: "alpha", task: "test", args: alpha }]);
    await service.finish("done", {} as never);
    assert.equal(notifications[0]?.verified, false);
    assert.deepEqual(notifications[0]?.completion.satisfied_obligations, ["check:alpha"]);
    assert.deepEqual(notifications[0]?.completion.missing_obligations, []);
  });
});

test("a different current filter cannot satisfy the required invocation", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    await workspace.runTask({ kind: "project", task: "test", args: beta }, {});
    const { service, activities } = finish(root, [{ id: "alpha", task: "test", args: alpha }]);
    await service.finish("done", {} as never);
    assert.deepEqual(activities, [{ kind: "project", task: "test", args: alpha }]);
  });
});

test("legacy generic success without test observations cannot satisfy an execution obligation", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const journal = new SessionJournal(root, "required");
    const state = await journal.completionSnapshot();
    await journal.recordValidation({ taskId: "test", cwd: ".", args: alpha,
      sourceRevisionId: state.sourceRevisionId, status: "passed" });
    const { service, notifications, activities } = finish(root, [{ id: "alpha", task: "test", args: alpha }]);
    await service.finish("done", {} as never);
    assert.deepEqual(activities, [{ kind: "project", task: "test", args: alpha }]);
    assert.equal(notifications[0]?.verified, true);
    assert.ok(notifications[0]?.completion.satisfied_obligations.includes("check:alpha"));
  });
});

test("explicit child-package checks run even when only root source changed", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const { service, activities, notifications } = finish(root, [{ id: "child", task: "child:test" }]);
    await assert.rejects(service.finish("done", {} as never), /still failing/u);
    assert.deepEqual(activities, [{ kind: "project", task: "child:test", args: [] }]);
    assert.equal(notifications.length, 0);
  }, { "child/package.json": JSON.stringify({ scripts: { test: "node --test suite.test.cjs" } }),
    "child/suite.test.cjs": "require('node:test').test('dependency',()=>{throw Error('broken dependency')});\n" });
});

for (const [name, script, source, execution] of [
  ["zero tests", "node --test", "require('node:test').test('skip',{skip:true},()=>{});\n", "zero_tests"],
  ["no observed report", "node -e 'process.exit(0)'", suite, "not_observed"],
] as const) test(`${name} cannot satisfy a required test or loop at finish`, async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const { service, activities, notifications } = finish(root, [{ id: "required", task: "test" }]);
    await service.finish("done", {} as never); await service.finish("again", {} as never);
    assert.equal(activities.length, 1); assert.equal(notifications[0]?.verified, false);
    assert.deepEqual(notifications[0]?.completion.missing_obligations, ["check:required"]);
    const state = await new SessionJournal(root, "required").completionSnapshot();
    assert.equal(state.validations.find(v => v.taskId === "test")?.check?.execution, execution);
  }, { "package.json": JSON.stringify({ scripts: { test: script, build: "node --check value.cjs" } }), "suite.test.cjs": source });
});

test("required unavailable check downgrades build admission without repeated automatic retries", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const { service, activities, notifications } = finish(root, [{ id: "required", task: "test" }]);
    await service.finish("done", {} as never); await service.finish("again", {} as never);
    assert.equal(activities.length, 1); assert.equal(notifications[0]?.verified, false);
    assert.deepEqual(notifications[0]?.completion.missing_obligations, ["check:required"]);
    assert.ok(notifications[0]?.completion.reservations.some(r => r.code === "REQUIRED_CHECK_UNCONFIRMED"));
  }, { "package.json": JSON.stringify({ scripts: { test: "node environment.cjs", build: "node --check value.cjs" } }),
    "environment.cjs": "if(!process.env.BLAME_REQUIRED_CONTROL_URL){console.error('Missing environment variable: BLAME_REQUIRED_CONTROL_URL');process.exit(1)}\n" });
});

for (const required of [false, true]) test(`missing POSIX lint executable stays unavailable (${required ? "required" : "optional"})`, async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace);
    const result = await workspace.runTask({ kind: "project", task: "lint_src" }, {});
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.category, "environment", JSON.stringify(result));
    assert.match(result.message, /blame_absent_lint_7284.*not found/u);
    const { service, activities, notifications } = finish(root, required ? [{ id: "lint", task: "lint_src" }] : []);
    await service.finish("Source changed; lint could not run because its executable is missing.", {} as never);
    await service.finish("The missing-tool limitation remains.", {} as never);
    assert.equal(activities.length, 0);
    assert.equal(notifications[0]?.verified, false);
    assert.equal(notifications[0]?.completion.verification, "unverified");
    assert.deepEqual(notifications[0]?.completion.missing_obligations, required ? ["check:lint"] : []);
    const state = await new SessionJournal(root, "required").completionSnapshot();
    assert.ok(state.validations.some(v => v.taskId === "lint_src" && v.category === "environment" && v.terminal === "failed"));
    assert.ok(!state.validations.some(v => v.taskId === "lint_src" && v.status === "passed"));
  }, { "package.json": JSON.stringify({ scripts: { lint_src: "sh -c 'blame_absent_lint_7284 --version'" } }) });
});

for (const diagnostic of ["Error: symbol not found", "sh: 1: example: not found"]) test(`exit-one lint still blocks completion: ${diagnostic}`, async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace);
    const result = await workspace.runTask({ kind: "project", task: "lint_src" }, {});
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.category, "code");
    const { service, notifications } = finish(root);
    await assert.rejects(service.finish("done", {} as never), /still failing/u);
    assert.equal(notifications.length, 0);
  }, { "package.json": JSON.stringify({ scripts: { lint_src: "node lint.cjs" } }),
    "lint.cjs": `console.error(${JSON.stringify(diagnostic)}); process.exit(1);\n` });
});

test("missing POSIX test runner leaves the required test unconfirmed", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace);
    const result = await workspace.runTask({ kind: "project", task: "test", args: [] }, {});
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal((result.data as { failure: { category: string } }).failure.category, "environment");
    const { service, activities, notifications } = finish(root, [{ id: "tests", task: "test" }]);
    await service.finish("Source changed; the test runner is missing, so tests did not pass.", {} as never);
    await service.finish("Tests remain unavailable.", {} as never);
    assert.equal(activities.length, 0);
    assert.equal(notifications[0]?.completion.verification, "unverified");
    assert.deepEqual(notifications[0]?.completion.missing_obligations, ["check:tests"]);
    assert.deepEqual(notifications[0]?.completion.satisfied_obligations, []);
    const state = await new SessionJournal(root, "required").completionSnapshot();
    assert.ok(state.validations.some(v => v.taskId === "test" && v.category === "environment" && v.check?.outcome === "failed"));
  }, { "package.json": JSON.stringify({ scripts: { test: "sh -c 'blame_absent_test_7284 --version'" } }) });
});

test("nonmutating requests still execute explicit required checks", async () => {
  await fixture(async root => {
    const { service, activities, notifications } = finish(root, [{ id: "required", task: "test" }]);
    await service.finish("checked", {} as never);
    assert.equal(activities.length, 1); assert.equal(notifications[0]?.completion.verification, "unverified");
    assert.deepEqual(notifications[0]?.completion.satisfied_obligations, ["check:required"]);
  }, { "suite.test.cjs": "require('node:test').test('one',()=>{});\n" });
});

test("a nonmutating admitted build executes once rather than looping", async () => {
  await fixture(async root => {
    const { service, activities, notifications } = finish(root, [{ id: "build", task: "build" }]);
    await service.finish("checked", {} as never); await service.finish("again", {} as never);
    assert.equal(activities.length, 1); assert.equal(notifications[0]?.verified, true);
  });
});

test("a source change during a required check runs the check again on the new source", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const { service, activities, notifications } = finish(root, [{ id: "source-writer", task: "test" }]);
    await service.finish("checked", {} as never);
    assert.deepEqual(activities, [{ kind: "project", task: "test", args: [] }, { kind: "project", task: "test", args: [] }]);
    assert.ok(notifications[0]?.completion.satisfied_obligations.includes("check:source-writer"));
    assert.deepEqual(notifications[0]?.completion.missing_obligations, []);
  }, { "suite.test.cjs": "require('node:test').test('writer',()=>{require('node:fs').writeFileSync('value.cjs','exports.value = 3;\\n')});\n" });
});

test("a check that keeps rewriting the source finishes unverified instead of failing", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const { service, activities, notifications } = finish(root, [{ id: "source-writer", task: "test" }]);
    await service.finish("checked", {} as never);
    assert.equal(activities.length, 2);
    const completion = notifications[0]?.completion;
    assert.equal(completion?.verification, "unverified");
    assert.deepEqual(completion?.missing_obligations, ["check:source-writer"]);
    assert.ok(completion?.reservations.some(({ code, message }) =>
      code === "VALIDATION_UNAVAILABLE" && /changed while the final checks ran/u.test(message)));
    // The run then ends as succeeded, so the agent's reply is shown.
    assert.equal(completionAwareTerminalState("succeeded", completion), "succeeded");
  }, { "suite.test.cjs": "require('node:test').test('writer',()=>{require('node:fs').writeFileSync('value.cjs','exports.value = '+Math.random()+';\\n')});\n" });
});

test("multiple obligation IDs share one literal invocation", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const { service, activities, notifications } = finish(root, [
      { id: "first", task: "test", args: alpha }, { id: "second", task: "test", args: alpha },
    ]);
    await service.finish("done", {} as never);
    assert.equal(activities.length, 1);
    assert.deepEqual(notifications[0]?.completion.satisfied_obligations, ["validation", "check:first", "check:second"]);
  });
});

test("invalid or unsupported requirements fail before any automatic invocation", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    for (const checks of [[{ id: "missing", task: "absent" }], [{ id: "service", task: "dev" }],
      [{ id: "argv", task: "build", args: ["--surprise"] }],
      [{ id: "duplicate", task: "test" }, { id: "duplicate", task: "test" }],
      Array.from({ length: 17 }, (_, n) => ({ id: String(n), task: "test" }))]) {
      const { service, activities, notifications } = finish(root, checks);
      await assert.rejects(service.finish("done", {} as never));
      assert.equal(activities.length, 0); assert.equal(notifications.length, 0);
    }
    assert.equal(lightRequiredChecksSchema.safeParse([{ id: "raw", task: "test", command: "echo bypass" }]).success, false);
  });
});

test("cancellation of an automatic required check cannot notify completion", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const { service, notifications } = finish(root, [{ id: "slow", task: "test" }]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("required-check cancellation")), 150);
    try { await assert.rejects(service.finish("done", { signal: controller.signal } as never), /cancellation/u); }
    finally { clearTimeout(timer); }
    assert.equal(notifications.length, 0);
  }, { "suite.test.cjs": "require('node:test').test('slow',async()=>{await new Promise(r=>setTimeout(r,5000));});\n" });
});

test("absent contract preserves build-only compatibility", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace, 3); await build(workspace);
    const { service, activities, notifications } = finish(root);
    await service.finish("done", {} as never);
    assert.equal(activities.length, 0); assert.equal(notifications[0]?.verified, true);
  });
});

test("local briefing exposes exact required argv and managed finish preserves obligations", async () => {
  await fixture(async (root, workspace) => {
    await edit(workspace); await build(workspace);
    const taskContract = { session_id: "required", required_checks: [{ id: "alpha", task: "test", args: alpha }] };
    const briefing = await createInitialTaskBriefing({ workspaceRoot: root, taskContract });
    assert.ok(briefing?.includes(JSON.stringify(taskContract.required_checks)));
    const result = await executeLocalFinishTask({ workspaceRoot: root, taskContract, input: { summary: "done" }, context: {} as never });
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      const data = result.data as { notification: LightCompletionNotification; validationActivities: unknown[] };
      assert.ok(data.notification.completion.satisfied_obligations.includes("check:alpha"));
      assert.equal(data.validationActivities.length, 2);
    }
  });
});
