import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observeCheck } from "./test-client/units.js";
import { LightWorkspace } from "./test-client/light-workspace.js";
import { LightFinishService } from "./test-client/light-finish-service.js";
import { SessionJournal } from "./session-journal.js";
import type { LightCompletionNotification } from "./test-client/light-finish-service.js";
// A command result as the runner observes it.
type WorkspaceCommandResult = { all: string; failed: boolean; exitCode?: number; interruption?: string };

const missing = " RUN  v3.2.4 /project/pkg\n\nNo test files found, exiting with code 1\nfilter: pkg/absent.test.ts\ninclude: **/*.test.ts\n";
const failed = { all: missing, failed: true, exitCode: 1 };

test("Vitest discovery failure stays failed, uncounted and unverified", () => {
  const result = observeCheck("tsc --noEmit && vitest --run pkg/absent.test.ts",
    { ...failed, all: missing.replace("RUN", "\x1b[1mRUN\x1b[0m") }, "pkg", false);
  assert.equal(result.selectionFailure, "no_test_files");
  assert.equal(result.outcome, "failed");
  assert.equal(result.execution, "not_observed");
  assert.equal(result.counts, undefined);
  assert.equal(result.selection, "unknown");
  assert.equal(result.scope, "pkg");
});

const negative: Array<[string, string, Partial<WorkspaceCommandResult>]> = [
  ["unknown runner", "node reporter.cjs", {}],
  ["prior masked failure", "node fail.cjs; vitest run", {}],
  ["error fallback", "tsc || vitest run", {}],
  ["piped output", "vitest run | cat", {}],
  ["unsupported version", "vitest run", { all: missing.replace("v3.2.4", "v4.0.0") }],
  ["success", "vitest run", { failed: false, exitCode: 0 }],
  ["timeout", "vitest run", { interruption: "timed_out" }],
  ["cancellation", "vitest run", { interruption: "cancelled" }],
  ["two runners", "vitest run", { all: missing + " RUN  v3.2.4 /other\n" }],
  ["duplicate discovery", "vitest run", { all: missing + "No test files found, exiting with code 1\n" }],
  ["failed case", "vitest run", { all: missing + " Tests  1 failed (1)\n" }],
  ["suite failure", "vitest run", { all: missing + " FAIL  suite.test.ts\n" }],
  ["setup error", "vitest run", { all: missing + "Error: setup failed\n" }],
  ["compiler error", "tsc; vitest run", { all: "x.ts(1,1): error TS2322: bad type\n" + missing }],
];
for (const [name, command, override] of negative) test(`discovery classification rejects ${name}`, () => {
  assert.equal(observeCheck(command, { ...failed, ...override }, ".", false).selectionFailure, undefined);
});

// Process integration with a deterministic runner-output fixture. The research
// replay separately executes pinned real Vitest on the unchanged Remeda patch.
async function fixture(run: (root: string, workspace: LightWorkspace) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-selection-"));
  try {
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg/package.json"), JSON.stringify({ name: "pkg", scripts: { test: "node vitest.cjs" } }));
    await writeFile(join(root, "pkg/value.js"), "exports.value = 1;\n");
    await writeFile(join(root, "pkg/vitest.cjs"), `const mode=process.argv[2];
if(mode==='missing'){console.log(${JSON.stringify(missing)});process.exit(1)}
if(mode==='failure'){console.log(' RUN  v3.2.4 /project/pkg\\n Tests  1 failed (1)');process.exit(1)}
console.log(' RUN  v3.2.4 /project/pkg\\n Tests  1 passed (1)');\n`);
    const workspace = new LightWorkspace(root, { sessionId: "selection" });
    assert.equal((await workspace.editCode({ operations: [{ kind: "patch", path: "pkg/value.js",
      patch: "*** Begin Patch\n*** Update File: pkg/value.js\n@@\n-exports.value = 1;\n+exports.value = 2;\n*** End Patch" }] })).status, "ok");
    await run(root, workspace);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const required of [false, true]) test(`unavailable selection is retained without retry; required=${required}`, async () => {
  await fixture(async (root, workspace) => {
    const bad = await workspace.runTask({ kind: "project", task: "pkg:test", args: ["missing"] }, {});
    assert.equal(bad.status, "ok");
    const data = (bad as { data: { failure: { category: string; recovery: string } } }).data;
    assert.equal(data.failure.category, "command");
    assert.match(data.failure.recovery, /from pkg\./u);
    await workspace.runTask({ kind: "project", task: "pkg:test", args: ["passing"] }, {});
    const notifications: LightCompletionNotification[] = [], activities: unknown[] = [];
    const service = new LightFinishService({ workspaceRoot: root, conversationId: "selection",
      taskContract: required ? { required_checks: [{ id: "selected", task: "pkg:test", args: ["missing"] }] } : {},
      onComplete: n => { notifications.push(n); }, onValidationActivity: a => { activities.push(a); } });
    await service.finish("The missing selection ran no cases; another selection passed.", {} as never);
    await service.finish("Same evidence.", {} as never);
    assert.deepEqual(activities, []);
    assert.equal(notifications[0]?.verified, false);
    assert.equal(notifications[0]?.completion.verification, "unverified");
    assert.deepEqual(notifications[0]?.completion.missing_obligations, required ? ["check:selected"] : []);
    const snapshot = await new SessionJournal(root, "selection").completionSnapshot();
    assert.equal(snapshot.validations.length, 2);
    const retained = snapshot.validations.find(v => v.args?.[0] === "missing");
    assert.equal(retained?.terminal, "failed");
    assert.equal(retained?.check?.selectionFailure, "no_test_files");
  });
});

test("a genuine failed test still blocks after a different selection passes", async () => {
  await fixture(async (root, workspace) => {
    await workspace.runTask({ kind: "project", task: "pkg:test", args: ["failure"] }, {});
    await workspace.runTask({ kind: "project", task: "pkg:test", args: ["passing"] }, {});
    const service = new LightFinishService({ workspaceRoot: root, conversationId: "selection" });
    await assert.rejects(service.finish("done", {} as never), /still failing/u);
  });
});

test("a changed source refreshes an unavailable required selection once", async () => {
  await fixture(async (root, workspace) => {
    await workspace.runTask({ kind: "project", task: "pkg:test", args: ["missing"] }, {});
    await writeFile(join(root, "pkg/value.js"), "exports.value = 3;\n");
    const activities: Array<{ phase: string }> = [], notifications: LightCompletionNotification[] = [];
    const service = new LightFinishService({ workspaceRoot: root, conversationId: "selection",
      taskContract: { required_checks: [{ id: "selected", task: "pkg:test", args: ["missing"] }] },
      onValidationActivity: a => { activities.push(a); }, onComplete: n => { notifications.push(n); } });
    await service.finish("Selection unavailable.", {} as never);
    await service.finish("Same source.", {} as never);
    assert.equal(activities.filter(a => a.phase === "started").length, 1);
    assert.deepEqual(notifications.at(-1)?.completion.missing_obligations, ["check:selected"]);
  });
});
