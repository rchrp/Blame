import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { LightCompletionNotification } from "./test-client/light-finish-service.js";
import { data, fixture, LightFinishService, localLightWorkspaceExecutor, observeCheck } from "./light-agent-guidance-fixture.js";

test("Mocha reports pending separately and leaves unreported skipped unknown", () => {
  const observation = observeCheck("node node_modules/mocha/bin/mocha spec.js", { all: "  3245 passing (3s)\n  8 pending\n", exitCode: 0, failed: false }, ".", false);
  assert.deepEqual(observation.reportedCounts, { passed: 3245, failed: null, pending: 8, skipped: null });
  assert.equal(observation.selection, "unknown");
  assert.equal(observation.freshness, "unknown");
  assert.equal(observation.evidenceOrigin, "runner_output");
});
test("interrupted or duplicated Mocha summaries cannot establish passing tests", () => {
  const output = "  2 passing (1ms)\n  1 pending\n";
  const interrupted = observeCheck("mocha spec.js", { all: output, exitCode: 0, failed: false, interruption: "cancelled" }, ".", false);
  assert.equal(interrupted.outcome, "unknown");
  const duplicated = observeCheck("mocha spec.js", { all: output.repeat(2), exitCode: 0, failed: false }, ".", false);
  assert.equal(duplicated.reportedCounts, undefined);
  assert.equal(duplicated.outcome, "unknown");
});
test("current check report distinguishes observed counts, admission and source revisions", async () => {
  await fixture({ "suite.test.cjs": "require('node:test').test('case',()=>{});\n", "package.json": JSON.stringify({ scripts: { test: "node --test suite.test.cjs" } }) }, async (workspace, root) => {
    const result = data(await workspace.runTask({ kind: "project", task: "test" }, {}));
    assert.equal(result.reporting.counts.passed, 1);
    assert.equal(result.reporting.admission, "unverified");
    const report = data(await workspace.readCode({ target: "@checks" }, {}));
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].reporting.counts.passed, 1);
    assert.equal(report.checks[0].reporting.admission, "unverified");
    assert.equal(report.checks[0].sourceRevisionId, report.sourceRevisionId);
    const notifications: LightCompletionNotification[] = [];
    await new LightFinishService({ workspaceRoot: root, conversationId: "guidance", onComplete: n => { notifications.push(n); } }).finish("A case passed; acceptance remains separate.", {} as never);
    assert.equal(notifications[0]?.validationReport?.checks.length, 1);
    assert.equal(notifications[0]?.verified, false);
    await writeFile(join(root, "suite.test.cjs"), "// changed after testing\n");
    assert.equal(data(await workspace.readCode({ target: "@checks" }, {})).checks.length, 0);
  });
});
test("raw Mocha commands expose nullable counters without admitting validation", async () => {
  await fixture({ "mocha": "console.log('  3245 passing (3s)\\n  8 pending');\n" }, async workspace => {
    const result = data(await workspace.runTask({ kind: "command", command: "node mocha" }, {}));
    assert.equal(result.reporting.counts.passed, 3245);
    assert.equal(result.reporting.counts.pending, 8);
    assert.equal(result.reporting.counts.skipped, null);
    assert.equal(result.reporting.admission, "unverified");
    const report = data(await workspace.readCode({ target: "@checks" }, {}));
    assert.equal(report.checks[0].reporting.counts.skipped, null);
  });
});

test("silent, malformed and failing Mocha invocations preserve uncertainty and failure", () => {
  for (const all of ["", "  9007199254740993 passing (1ms)\n", "2 passing\n2 passing\n"]) {
    const observation = observeCheck("mocha spec.js", { all, exitCode: 0, failed: false }, ".", false);
    assert.equal(observation.reportedCounts, undefined);
    assert.equal(observation.outcome, "unknown");
  }
  const failure = observeCheck("mocha spec.js", { all: "2 passing (1ms)\n1 failing\n", exitCode: 1, failed: true }, ".", false);
  assert.equal(failure.reportedCounts?.failed, 1);
  assert.equal(failure.reportedCounts?.skipped, null);
  assert.equal(failure.outcome, "failed");
  const misleadingExit = observeCheck("mocha spec.js", { all: "2 passing (1ms)\n1 failing\n", exitCode: 0, failed: false }, ".", false);
  assert.equal(misleadingExit.outcome, "failed", "A successful process cannot erase reported failures.");
});

test("Mocha source changes are identified and cannot supply a current check", async () => {
  await fixture({ "value.txt": "before", "mocha": "require('node:fs').writeFileSync('value.txt','after');console.log('2 passing (1ms)');\n" }, async workspace => {
    const result = data(await workspace.runTask({ kind: "command", command: "node mocha" }, {}));
    assert.notEqual(result.reporting.invocationSourceRevisionId, result.reporting.completedSourceRevisionId);
    assert.equal(result.reporting.freshness, "stale");
    assert.equal(result.reporting.admission, "unverified");
    assert.equal(data(await workspace.readCode({ target: "@checks" }, {})).checks.length, 0);
  });
});

test("executor preserves the same check report through remote-shaped calls and completion", async () => {
  await fixture({ "mocha": "console.log('2 passing (1ms)\\n1 pending');\n" }, async (_, root) => {
    const taskContract = { session_id: "guidance" };
    const execute = localLightWorkspaceExecutor(root, taskContract);
    const context = { workspaceRoot: root, toolContext: { sessionId: "guidance" }, taskContract };
    const run = data(await execute({ ...context, tool: "run_task", input: { kind: "command", command: "node mocha" } }));
    assert.equal(run.reporting.counts.skipped, null);
    const checks = data(await execute({ ...context, tool: "read_code", input: { target: "@checks" } }));
    assert.equal(checks.checks[0].reporting.counts.pending, 1);
    const finish = data(await execute({ ...context, tool: "finish_task", input: { summary: "Two passing reported, one pending; skipped unknown." } }));
    assert.equal(finish.notification.validationReport.checks[0].reporting.counts.skipped, null);
  });
});
