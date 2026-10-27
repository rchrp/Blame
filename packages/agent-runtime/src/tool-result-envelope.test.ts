import assert from "node:assert/strict";
import test from "node:test";
import { feedbackEnvelope, unwrapFeedbackEnvelope } from "./tool-result-envelope.js";

test("large diagnostics round-trip while source-bound metadata stays in a separate SDK part", () => {
  const result = { status: "ok", data: { output: "diagnostic\n".repeat(1_600),
    reporting: { outcome: "failed", admission: "unverified", invocationSourceRevisionId: "src_a" },
    testValidationScope: { kind: "runtime_test_scope", testCompilation: "not_established" },
    diagnostics: [{ content: "const example = 'quoted';\n".repeat(100) }] } };
  const before = structuredClone(result), encoded = feedbackEnvelope(result) as Array<{ type: string; text: string }>;
  assert.deepEqual(unwrapFeedbackEnvelope(encoded), result);
  assert.deepEqual(result, before);
  assert.ok(encoded[0]!.text.length < 8_000);
  const clipped = encoded.map(part => ({ ...part, text: part.text.slice(0, 8_000) }));
  const decoded = unwrapFeedbackEnvelope(clipped) as typeof result;
  assert.deepEqual(decoded.data.reporting, result.data.reporting);
  assert.deepEqual(decoded.data.testValidationScope, result.data.testValidationScope);
  assert.notEqual(decoded.data.output, result.data.output);
});

test("small results retain the existing contract and source JSON is never recursively parsed", () => {
  const result = { status: "ok", data: { output: "done" } };
  assert.equal(feedbackEnvelope(result), result);
  assert.equal(unwrapFeedbackEnvelope(result), result);
  assert.equal(feedbackEnvelope(undefined), undefined);
  const source = [{ type: "text", text: JSON.stringify(result) }];
  assert.equal(unwrapFeedbackEnvelope(source), source);
});

test("malformed metadata, mismatched parts and unsafe paths fail closed", () => {
  for (const value of [
    [{ type: "text", text: '{"format":"blame_tool_result_v1"' }],
    [{ type: "text", text: JSON.stringify({ format: "blame_tool_result_v1", result: {}, textFields: [["missing"]] }) }],
    [{ type: "text", text: JSON.stringify({ format: "blame_tool_result_v1", result: {}, textFields: [["__proto__", "polluted"]] }) }, { type: "text", text: "x" }],
  ]) assert.equal(unwrapFeedbackEnvelope(value), value);
  assert.equal(Object.hasOwn({}, "polluted"), false);
});
