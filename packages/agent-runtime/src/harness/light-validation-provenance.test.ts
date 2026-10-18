import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { data, fixture, LightFinishService, LightWorkspace } from "./light-agent-guidance-fixture.js";
import type { LightCompletionNotification } from "./light-completion.js";
import { currentValidationReport, validationStateAfterEdit } from "./light-validation-report.js";
import type { JournalCompletionSnapshot } from "./session-journal.js";

const original = "exports.value = 1;\n";
const files = { "value.cjs": original, "suite.test.cjs": "require('node:test').test('boundary',()=>{});\n",
  "package.json": JSON.stringify({ scripts: { test: "node --test suite.test.cjs", typecheck: "node --check value.cjs" } }) };

test("post-validation edits expose earlier exact invocations, then a rerun clears only its own identity", async () => {
  await fixture(files, async (workspace, root) => {
    await workspace.runTask({ kind: "project", task: "test" }, {});
    await workspace.runTask({ kind: "project", task: "typecheck" }, {});
    const edit = data(await workspace.editCode({ operations: [{ kind: "patch", path: "value.cjs",
      patch: "*** Begin Patch\n*** Update File: value.cjs\n@@\n-exports.value = 1;\n+exports.value = 2;\n*** End Patch" }] }));
    assert.ok(edit.validationState, "A committed post-validation edit must expose invalidated invocations");
    assert.equal(edit.validationState.sourceRevisionId, edit.sourceRevisionId);
    assert.deepEqual(new Set(edit.validationState.invalidatedChecks.map((v: { task: string }) => v.task)), new Set(["test", "typecheck"]));
    assert.ok(edit.validationState.invalidatedChecks.every((v: { eligibleForCurrentSource: boolean }) => !v.eligibleForCurrentSource));
    const stale = data(await workspace.readCode({ target: "@checks" }, {}));
    assert.equal(stale.checks.length, 0); assert.equal(stale.previousTotal, 2);
    await workspace.runTask({ kind: "project", task: "test" }, {});
    const current = data(await workspace.readCode({ target: "@checks" }, {}));
    assert.equal(current.checks.length, 1); assert.equal(current.checks[0].task, "test");
    assert.equal(current.previousChecks[0].task, "typecheck"); assert.equal(current.previousTotal, 1);
    assert.equal(current.environment, "not_rechecked"); assert.equal(current.userCriteria, "not_assessed");
    const notifications: LightCompletionNotification[] = [];
    await new LightFinishService({ workspaceRoot: root, conversationId: "guidance", onComplete: n => { notifications.push(n); } }).finish("One current test; no claim about an optional compiler.", {} as never);
    assert.equal(notifications[0]?.validationReport?.previousChecks[0]?.task, "typecheck");
    assert.equal(notifications[0]?.completion.verification, "unverified");
  });
});

test("external test-only edits invalidate history after session restart without promoting previous counts", async () => {
  await fixture(files, async (workspace, root) => {
    await workspace.runTask({ kind: "project", task: "test" }, {});
    await writeFile(join(root, "suite.test.cjs"), files["suite.test.cjs"] + "// final test edit\n");
    const resumed = new LightWorkspace(root, { sessionId: "guidance" });
    const report = data(await resumed.readCode({ target: "@checks" }, {}));
    assert.ok(report.previousChecks?.length, "Resumed history must retain previous-source evidence");
    assert.equal(report.checks.length, 0); assert.equal(report.previousChecks[0].previousOutcome, "passed");
    assert.equal(report.previousChecks[0].admission, "unverified");
    assert.notEqual(report.previousChecks[0].sourceRevisionId, report.sourceRevisionId);
  });
});

test("a source-changing command presents invalidation after completion without claiming validation", async () => {
  await fixture(files, async (workspace) => {
    await workspace.runTask({ kind: "project", task: "test" }, {});
    const changed = data(await workspace.runTask({ kind: "command", command: "node -e \"require('node:fs').appendFileSync('value.cjs','// formatted\\n')\"" }, {}));
    assert.equal(changed.changed, true);
    assert.equal(changed.validationState.observation, "current_source_snapshot_after_operation");
    assert.equal(changed.validationState.invalidatedChecks[0].task, "test");
    assert.equal(changed.validationState.invalidatedChecks[0].eligibleForCurrentSource, false);
    assert.equal(data(await workspace.readCode({ target: "@checks" }, {})).checks.length, 0);
  });
});

test("a successful ordinary command is never displayed as admitted source validation", async () => {
  await fixture(files, async (workspace) => {
    await workspace.runTask({ kind: "command", command: "node -e \"console.log('not a check')\"" }, {});
    const report = data(await workspace.readCode({ target: "@checks" }, {}));
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].taskKind, null);
    assert.equal(report.checks[0].admission, "unverified");
  });
});

test("bounded history preserves cwd/argv distinctions and cannot bind a moved edit receipt", () => {
  const state: JournalCompletionSnapshot = { sourceRevisionId: "current", changedPaths: [], changes: [], files: [], symbols: [], validations: [] };
  const base = { id: "id", command: "npm test", cwd: "a", taskId: "test", taskKind: "test", args: ["alpha"],
    paths: [], status: "unknown", terminal: "passed" as const, timestamp: "recorded", sourceRevisionId: "old", check: undefined, category: undefined, recovery: undefined };
  const history = [base, { ...base, id: "other-cwd", cwd: "b" }, { ...base, id: "other-args", args: ["beta"] }];
  const report = currentValidationReport(state, history);
  assert.equal(report.previousChecks.length, 3); assert.equal(report.checks.length, 0);
  assert.equal(validationStateAfterEdit(state, history, "moved"), undefined);
  const many = Array.from({ length: 40 }, (_, i) => ({ ...base, taskId: `test:${i}`, args: ["x".repeat(1000)] }));
  const bounded = validationStateAfterEdit(state, many, "current")!;
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.invalidatedChecks)) <= 1800);
  assert.ok(bounded.invalidatedChecks.length > 0);
  assert.equal(bounded.omitted + bounded.invalidatedChecks.length, 40);
  assert.ok(bounded.invalidatedChecks.every(v => v.args[0]!.length === 1000), "An omitted selection must never become a truncated different selection");
});
