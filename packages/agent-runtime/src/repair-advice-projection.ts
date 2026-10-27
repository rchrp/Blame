import { createHash } from "node:crypto";
import type { ContentBlock, Message } from "@cline/sdk";
import { unwrapFeedbackEnvelope } from "./tool-result-envelope.js";

/** Pure presentation: reference only a full plan still in this transcript. */
export function compactRepairAdvice(messages: Message[]) {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const visible = new Map<string, string>();
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map((block: ContentBlock): ContentBlock => {
      if (block.type === "tool_use" && message.role === "assistant") {
        calls.set(block.id, { name: block.name, input: record(block.input) ?? {} });
        return block;
      }
      if (block.type !== "tool_result") return block;
      const call = calls.get(block.tool_use_id);
      if (!call || !["run_task", "edit_code", "read_code"].includes(call.name)) return block;
      let parsed: unknown;
      try { parsed = typeof block.content === "string" ? JSON.parse(block.content) : block.content; } catch { return block; }
      const result = record(unwrapFeedbackEnvelope(parsed));
      if (!result || !["ok", "blocked"].includes(String(result.status))) return block;
      const located = repairPlan(result);
      if (!located || !validPlan(located.plan)) return block;
      const serialized = JSON.stringify(located.plan);
      const key = createHash("sha256").update(serialized).digest("hex");
      const previous = visible.get(key);
      const forced = (call.name === "read_code" && call.input.target === "@checks") ||
        (call.name === "run_task" && (block.is_error || failed(result)));
      const reference = {
        kind: "repair_plan_reference", sourceRevisionId: located.plan.sourceRevisionId,
        advisoryOnly: true, fullPlanToolCallId: previous,
        instruction: "Same visible repair plan. Rerun the failed selection before green checks; retain every required final-source check. No verification is admitted. read_code @checks returns the full plan.",
      };
      if (!previous || forced || JSON.stringify(reference).length >= serialized.length) {
        visible.set(key, block.tool_use_id);
        return block;
      }
      return { ...block, content: JSON.stringify(located.replace(reference)) };
    });
    return { ...message, content };
  });
}

function validPlan(plan: Record<string, unknown>) {
  return plan.advisoryOnly === true && typeof plan.sourceRevisionId === "string" &&
    Array.isArray(plan.repairFirst) && plan.repairFirst.length > 0 &&
    Array.isArray(plan.requiredAfterRepair) && plan.repairFirst.every(value => {
      const input = record(record(value)?.input);
      return input?.kind === "project" ? typeof input.task === "string" :
        input?.kind === "command" && typeof input.command === "string";
    });
}

function repairPlan(result: Record<string, unknown>) {
  const data = record(result.data), plan = record(data?.validationRepair);
  if (result.status === "ok" && data && plan)
    return { plan, replace: (value: unknown) => ({ ...result, data: { ...data, validationRepair: value } }) };
  if (result.status !== "blocked" || typeof result.recovery !== "string") return;
  const recovery = result.recovery;
  const newline = recovery.lastIndexOf("\n");
  try {
    const tail = record(JSON.parse(recovery.slice(newline + 1)));
    const plan = record(tail?.validationRepair);
    if (!tail || !plan) return;
    return { plan, replace: (value: unknown) => ({ ...result,
      recovery: recovery.slice(0, newline + 1) + JSON.stringify({ ...tail, validationRepair: value }),
    }) };
  } catch { return; }
}

function failed(result: Record<string, unknown>): boolean {
  if (result.status === "blocked") return true;
  const data = record(result.data), check = record(data?.check);
  return check?.outcome === "failed" || (typeof data?.exitCode === "number" && data.exitCode !== 0) ||
    (!!record(data?.completed) && failed(record(data?.completed)!));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
