import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClineAgentPayload } from "./cline-runtime-events.js";

function usage(sessionId: string, payload: Record<string, unknown>) {
  const event = normalizeClineAgentPayload({ type: "usage", ...payload }, sessionId, payload);
  return (event.payload as { usage: Record<string, unknown> }).usage;
}

test("thinking tokens count as output per turn and in the running totals", () => {
  const first = usage("reasoning-totals", { outputTokens: 200, reasoningTokenCount: 11_800, totalOutputTokens: 200 });
  assert.equal(first.outputTokens, 12_000);
  assert.equal(first.reasoningTokens, 11_800);
  assert.equal(first.totalOutputTokens, 12_000);
  const second = usage("reasoning-totals", { outputTokens: 150, reasoningTokenCount: 50, totalOutputTokens: 350 });
  assert.equal(second.outputTokens, 200);
  assert.equal(second.totalOutputTokens, 12_200);
  assert.equal(second.totalReasoningTokens, 11_850);

  const updated = normalizeClineAgentPayload(
    { type: "usage-updated", usage: { outputTokens: 150, totalOutputTokens: 350 } }, "reasoning-totals", {});
  assert.equal((updated.payload as { usage: Record<string, unknown> }).usage.totalOutputTokens, 12_200);
  const done = normalizeClineAgentPayload(
    { type: "done", status: "done", usage: { totalOutputTokens: 350, totalInputTokens: 1 } }, "reasoning-totals", {});
  assert.equal((done.payload as { usage: Record<string, unknown> }).usage.totalOutputTokens, 12_200);
});

test("a new run whose totals start over does not inherit earlier reasoning", () => {
  usage("reasoning-restart", { outputTokens: 100, reasoningTokenCount: 900, totalOutputTokens: 5_000 });
  const restarted = usage("reasoning-restart", { outputTokens: 40, reasoningTokenCount: 60, totalOutputTokens: 40 });
  assert.equal(restarted.totalOutputTokens, 100);
});

test("usage without reasoning is unchanged", () => {
  assert.deepEqual(usage("reasoning-none", { outputTokens: 30, totalOutputTokens: 30 }), {
    type: "usage", outputTokens: 30, totalOutputTokens: 30,
  });
});
