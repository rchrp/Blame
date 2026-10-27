import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@cline/sdk";
import { compactRepairAdvice } from "./repair-advice-projection.js";
import { presentToolResults } from "./tool-result-presentation.js";
import { feedbackEnvelope } from "./tool-result-envelope.js";

const plan = { sourceRevisionId: "src_one", advisoryOnly: true,
  repairFirst: [{ input: { kind: "project", task: "types" }, category: "code", freshness: "current" }],
  requiredAfterRepair: [{ id: "tests", input: { kind: "project", task: "tests" } }],
  instruction: "Preserve the failed selection and every final-source requirement. ".repeat(12) };
function pair(id: string, options: { plan?: unknown; blocked?: boolean; checks?: boolean; envelope?: boolean } = {}): Message[] {
  const value = options.plan ?? plan;
  const result = options.blocked ? { status: "blocked", category: "code", message: "Compiler error", recovery: "Inspect the diagnostic.\n" + JSON.stringify({ validationRepair: value }) }
    : { status: "ok", data: { output: "inspection", exitCode: 0, validationRepair: value, reporting: { admission: "unverified" } } };
  return [{ role: "assistant", content: [{ type: "tool_use", id, name: options.checks ? "read_code" : "run_task", input: options.checks ? { target: "@checks" } : { kind: "command", command: "pwd" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(options.envelope ? feedbackEnvelope({ ...result, data: { ...("data" in result ? result.data : {}), output: "diagnostic\n".repeat(1000) } }) : result) }] }];
}
function result(messages: Message[], index = -1) {
  const block = messages.at(index)!.content[0]!;
  assert.equal(block.type, "tool_result");
  return JSON.parse((block as { content: string }).content);
}

test("only identical visible advisory plans compact; source and verification facts survive", () => {
  const messages = [...pair("first"), ...pair("inspection")], before = structuredClone(messages);
  const projected = compactRepairAdvice(messages);
  assert.deepEqual(messages, before);
  assert.deepEqual(result(projected, 1).data.validationRepair, plan);
  const repeated = result(projected);
  assert.equal(repeated.data.validationRepair.kind, "repair_plan_reference");
  assert.equal(repeated.data.validationRepair.fullPlanToolCallId, "first");
  assert.deepEqual(repeated.data.reporting, { admission: "unverified" });
  assert.equal(repeated.data.exitCode, 0);
  assert.ok(JSON.stringify(projected).length < JSON.stringify(messages).length);
});

test("new failures, revisions, requirements and explicit check reads keep full advice", () => {
  for (const options of [{ blocked: true }, { checks: true }, { plan: { ...plan, sourceRevisionId: "src_two" } },
    { plan: { ...plan, requiredAfterRepair: [] } }]) {
    const projected = compactRepairAdvice([...pair("first"), ...pair("next", options)]);
    const data = result(projected);
    const nextPlan = options.blocked ? JSON.parse(data.recovery.split("\n").at(-1)).validationRepair : data.data.validationRepair;
    assert.equal(nextPlan.kind, undefined);
    assert.deepEqual(nextPlan, "plan" in options ? options.plan : plan);
  }
});

test("compaction and independent consumers re-expose advice; appends preserve the previous prefix", () => {
  const prefix = [...pair("first"), ...pair("second")];
  const before = compactRepairAdvice(prefix);
  const appended = compactRepairAdvice([...prefix, ...pair("failure", { blocked: true }), ...pair("third")]);
  assert.deepEqual(appended.slice(0, before.length), before);
  assert.equal(result(appended).data.validationRepair.fullPlanToolCallId, "failure");
  const reset = compactRepairAdvice([{ role: "user", content: "Compacted summary: prior details omitted." }, ...pair("fresh")]);
  assert.deepEqual(result(reset).data.validationRepair, plan);
  assert.deepEqual(result(compactRepairAdvice(pair("another-consumer"))).data.validationRepair, plan);
});

test("only trusted tool metadata compacts; unknown calls and printed/source JSON do not", () => {
  const invalid = { ...plan, advisoryOnly: false };
  assert.deepEqual(compactRepairAdvice([...pair("first", { plan: invalid }), ...pair("next", { plan: invalid })]), [...pair("first", { plan: invalid }), ...pair("next", { plan: invalid })]);
  const unknown: Message[] = [pair("first")[1]!, ...pair("next")];
  assert.deepEqual(result(compactRepairAdvice(unknown)).data.validationRepair, plan);
  const user: Message[] = [{ role: "user", content: JSON.stringify(plan) }, ...pair("next")];
  assert.deepEqual(result(compactRepairAdvice(user)).data.validationRepair, plan);
  const enveloped = compactRepairAdvice([...pair("first"), ...pair("large", { envelope: true })]);
  assert.equal(result(enveloped).data.validationRepair.kind, "repair_plan_reference");
  assert.ok(result(enveloped).data.output.length > 6000);
});

test("the reference flag preserves presentation without advice compaction", () => {
  const previous = process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION;
  try {
    const messages = [...pair("first"), ...pair("next")];
    process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION = "false";
    assert.deepEqual(result(presentToolResults(messages)).data.validationRepair, plan);
    process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION = "true";
    assert.equal(result(presentToolResults(messages)).data.validationRepair.kind, "repair_plan_reference");
  } finally { if (previous === undefined) delete process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION; else process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION = previous; }
});
