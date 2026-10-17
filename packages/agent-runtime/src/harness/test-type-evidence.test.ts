import assert from "node:assert/strict";
import test from "node:test";
import { observeCheck } from "./check-observation.js";
import { checkReporting } from "./light-validation-report.js";

// The pinned real Vitest 3.2.4 control executes a test containing TS2322 while
// emitting this successful summary. A separate compiler invocation rejects it.
const output = " RUN  v3.2.4 /project\n ✓ src/delivered.test.ts (1 test) 2ms\n Test Files  1 passed (1)\n Tests  1 passed (1)\nType Errors  no errors\n";
const command = "node node_modules/vitest/vitest.mjs run src/delivered.test.ts --typecheck.enabled --typecheck.ignoreSourceErrors";
const observe = (cmd = command, text = output, sourceChanged = false, interruption?: "cancelled" | "timed_out") =>
  observeCheck(cmd, { all: text, exitCode: 0, failed: false, ...(interruption ? { interruption } : {}) }, ".", sourceChanged);

test("runtime success and a no-errors heading do not establish delivered-test typechecking", () => {
  const check = observe();
  assert.equal(check.outcome, "passed");
  assert.equal(check.counts?.executed, 1);
  assert.deepEqual(check.typechecking && { ...check.typechecking, note: undefined }, {
    runner: "vitest", requested: true, sourceErrorsIgnored: true,
    reportedErrors: "none", testFileSelection: "unknown", note: undefined,
  });
  assert.match(check.typechecking!.note, /establish no delivered-test typecheck coverage/u);
  assert.equal(check.selection, "unknown");
  const reporting = checkReporting(check);
  assert.equal(reporting.admission, "unverified");
  assert.deepEqual(reporting.typechecking, check.typechecking);
});

test("configuration can enable typechecking without an explicit CLI request", () => {
  const evidence = observe("vitest run --config custom.config.ts").typechecking!;
  assert.equal(evidence.requested, null);
  assert.equal(evidence.sourceErrorsIgnored, null);
  assert.equal(evidence.reportedErrors, "none");
  assert.equal(evidence.testFileSelection, "unknown");
});

test("explicit config and include arguments never establish resolved file selection", () => {
  const evidence = observe("vitest run --config custom.config.ts --typecheck.enabled --typecheck.include src/delivered.test.ts").typechecking!;
  assert.equal(evidence.requested, true);
  assert.equal(evidence.testFileSelection, "unknown");
});

test("an explicit typecheck request without a summary reports no result", () => {
  const evidence = observe(command, output.replace("Type Errors  no errors\n", "")).typechecking!;
  assert.equal(evidence.requested, true);
  assert.equal(evidence.reportedErrors, "unknown");
});

test("ordinary Vitest checks carry no additional typecheck object", () => {
  assert.equal(observe("vitest run", output.replace("Type Errors  no errors\n", "")).typechecking, undefined);
});

test("CLI false values and contradictory flags remain explicit or unknown", () => {
  assert.equal(observe("vitest run --typecheck.enabled=false").typechecking?.requested, false);
  assert.equal(observe("vitest run --typecheck.enabled false").typechecking?.requested, false);
  assert.equal(observe("vitest run --typecheck.enabled --no-typecheck").typechecking?.requested, null);
  assert.equal(observe("vitest run --typecheck.only").typechecking?.requested, true);
  assert.equal(observe("vitest run --typecheck.ignoreSourceErrors=false").typechecking?.sourceErrorsIgnored, false);
});

const unknown: Array<[string, string, string, "cancelled" | "timed_out" | undefined]> = [
  ["unsupported runner version", command, output.replace("v3.2.4", "v4.0.0"), undefined],
  ["unobserved runner version", command, output.replace(" RUN  v3.2.4 /project\n", ""), undefined],
  ["two runner invocations", command, output + " RUN  v3.2.4 /other\n", undefined],
  ["masked preceding failure", "node failed.cjs; " + command, output, undefined],
  ["pipeline", command + " | cat", output, undefined],
  ["unknown wrapper", "custom-vitest-wrapper --typecheck.enabled", output, undefined],
  ["cancelled", command, output, "cancelled"],
  ["timed out", command, output, "timed_out"],
];
for (const [name, cmd, text, interruption] of unknown) test(`${name} retains unknown typechecking`, () => {
  const evidence = observe(cmd, text, false, interruption).typechecking!;
  assert.equal(evidence.requested, null);
  assert.equal(evidence.sourceErrorsIgnored, null);
  assert.equal(evidence.reportedErrors, "unknown");
  assert.equal(evidence.testFileSelection, "unknown");
});

test("duplicate or unrecognized type-error summaries cannot establish a report", () => {
  assert.equal(observe(command, output + "Type Errors  1 failed\n").typechecking?.reportedErrors, "unknown");
  assert.equal(observe(command, output.replace("no errors", "0 failed")).typechecking?.reportedErrors, "unknown");
  assert.equal(observe(command, output.replace("no errors", "unavailable")).typechecking?.reportedErrors, "unknown");
  assert.equal(observe(command, output + "TypeCheckError: Type 'string' is not assignable to type 'number'.\n").typechecking?.reportedErrors, "unknown");
  assert.equal(observe(command, output + "src/delivered.test.ts(1,39): error TS2322: invalid type\n").typechecking?.reportedErrors, "unknown");
});

test("malformed or mixed runner counts do not borrow type-summary admission", () => {
  for (const text of [output.replace(" Tests  1 passed (1)", " Tests  1 passed (2)"), output + "Tests: 2 passed, 2 total\n"]) {
    const check = observe(command, text);
    assert.equal(check.counts, undefined);
    assert.equal(check.outcome, "unknown");
    // This remains only the literal heading's report, with no file selection.
    assert.equal(check.typechecking?.reportedErrors, "none");
    assert.equal(checkReporting(check).admission, "unverified");
  }
});

test("a reported type failure stays distinct from runtime or compiler coverage", () => {
  const evidence = observe(command, output.replace("no errors", "2 failed")).typechecking!;
  assert.equal(evidence.reportedErrors, "present");
  assert.equal(evidence.testFileSelection, "unknown");
});

test("ANSI presentation is stripped while stale source retains no verification", () => {
  const check = observe(command, output.replace("Type Errors", "\x1b[1mType Errors\x1b[0m"), true);
  assert.equal(check.typechecking?.reportedErrors, "none");
  const reporting = checkReporting(check);
  assert.equal(reporting.freshness, "stale");
  assert.equal(reporting.admission, "unverified");
});
