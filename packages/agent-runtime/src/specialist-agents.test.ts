import assert from "node:assert/strict";
import test from "node:test";

import {
  blameSpecialistAgent,
  blameSpecialistAgentIds,
  blameSpecialistAgentNames,
  blameSpecialistRoutingSystemPrompt,
} from "./specialist-agents.js";
import { createConsultSpecialistTool } from "./specialist-consult-tool.js";

test("defines stable ids for the initial Blame specialist team", () => {
  assert.deepEqual(blameSpecialistAgentIds, [
    "codebase_analyst",
    "story_analyst",
    "frontend_design",
    "test_verification",
    "risk_review",
  ]);
  assert.deepEqual(blameSpecialistAgentNames, [
    "Codebase Analyst",
    "Story Analyst",
    "Frontend Design Specialist",
    "Test & Verification Analyst",
    "Risk & Review Analyst",
  ]);
});

test("keeps full specialist prompts out of lead routing guidance", () => {
  const prompt = blameSpecialistRoutingSystemPrompt();

  assert.match(prompt, /consult_specialist/);
  assert.match(prompt, /private, read-only advisers/);
  assert.match(prompt, /retain implementation and verification/);
  assert.ok(Buffer.byteLength(prompt) < 600);
  assert.doesNotMatch(prompt, /<system_prompt/);
  assert.doesNotMatch(prompt, /## Specialist knowledge/);
  assert.doesNotMatch(prompt, /Jobs To Be Done/);
  assert.doesNotMatch(prompt, /Gestalt grouping/);
});

test("all specialist prompts enforce advisory read-only work", () => {
  for (const id of blameSpecialistAgentIds) {
    const specialist = blameSpecialistAgent(id);
    assert.ok(specialist);
    assert.match(specialist.systemPrompt, /not the implementer/i);
    assert.match(specialist.systemPrompt, /read-only inspection tools/i);
    assert.match(specialist.systemPrompt, /Do not modify files/i);
  }
});

test("consult_specialist resolves the private system prompt server-side", async () => {
  let delegatedInput: unknown;
  const spawnTool = {
    name: "spawn_agent",
    description: "test",
    inputSchema: { type: "object" },
    async execute(input: unknown) {
      delegatedInput = input;
      return { text: "advice" };
    },
  };
  const tool = createConsultSpecialistTool({
    capsule: async () => "<change_request_capsule>{}</change_request_capsule>",
    objective: "Improve the settings screen",
    spawnTool,
    storyId: "story-42",
  });

  const result = await tool.execute(
    {
      specialist: "frontend_design",
      task: "Review the hierarchy and responsive risks.",
      context: "The existing product uses compact operational UI.",
    },
    { runId: "request-1" } as never,
  );

  assert.deepEqual(result, {
    outcome: "completed",
    fatal: false,
    reason: "SPECIALIST_CONSULTATION_COMPLETED",
    recommendation: "Apply the useful advice and continue as the lead agent.",
    text: "advice",
    isError: false,
  });
  const delegated = delegatedInput as {
    systemPrompt: string;
    task: string;
  };
  assert.match(delegated.systemPrompt, /Frontend Design Specialist/);
  assert.match(delegated.systemPrompt, /You are not the implementer/);
  assert.match(delegated.task, /Improve the settings screen/);
  assert.match(delegated.task, /story-42/);
  assert.match(delegated.task, /change_request_capsule/);
  assert.match(delegated.task, /Review the hierarchy/);
  assert.match(delegated.task, /compact operational UI/);

  const publicSchema = JSON.stringify(tool.inputSchema);
  assert.doesNotMatch(publicSchema, /Frontend Design Specialist, an internal/);
  assert.doesNotMatch(publicSchema, /visual_system_protocol/);
  assert.match(tool.description, /frontend_design/);
  assert.match(tool.description, /risk_review/);

  const otherSpecialist = await tool.execute(
    {
      specialist: "risk_review",
      task: "Review the remaining risk.",
    },
    { runId: "request-1" } as never,
  );
  assert.equal((otherSpecialist as { outcome?: string }).outcome, "completed");

  const repeatedAfterCompaction = await tool.execute(
    {
      specialist: "risk_review",
      task: "Review the next change request.",
    },
    { runId: "request-2" } as never,
  );
  assert.equal(
    (repeatedAfterCompaction as { outcome?: string }).outcome,
    "completed",
  );

  const identicalAfterCompaction = await tool.execute(
    {
      specialist: "risk_review",
      task: "Review the next change request.",
    },
    { runId: "request-3" } as never,
  );
  assert.equal(
    (identicalAfterCompaction as { outcome?: string }).outcome,
    "skipped",
  );
  assert.equal(
    (identicalAfterCompaction as { isError?: boolean }).isError,
    false,
  );
  assert.match(JSON.stringify(identicalAfterCompaction), /previous_receipt/);
});

test("consult_specialist relays the specialist's steps as updates of its call", async () => {
  const updates: unknown[] = [];
  const spawnTool = {
    async execute() {
      return { text: "unused" };
    },
  };
  const tool = createConsultSpecialistTool({
    spawnTool,
    createSpawnTool: (onSubAgentEvent) => ({
      async execute() {
        onSubAgentEvent({ type: "content_start", contentType: "text", text: "Lo" });
        onSubAgentEvent({
          type: "content_start",
          contentType: "tool",
          toolCallId: "t1",
          toolName: "read_files",
          input: { paths: ["src/app.tsx"] },
        });
        onSubAgentEvent({
          type: "content_end",
          contentType: "tool",
          toolCallId: "t1",
          toolName: "read_files",
          output: "x".repeat(9_000),
        });
        onSubAgentEvent({ type: "content_end", contentType: "text", text: "Looks good." });
        return { text: "advice" };
      },
    }),
  });

  await tool.execute(
    { specialist: "codebase_analyst", task: "Map the settings screen." },
    { runId: "request-2", emitUpdate: (update: unknown) => updates.push(update) } as never,
  );

  assert.deepEqual(
    updates.map((update) => {
      const step = (update as { step: Record<string, unknown> }).step;
      return [step.kind, step.phase ?? step.text];
    }),
    [
      ["tool", "started"],
      ["tool", "finished"],
      ["message", "Looks good."],
    ],
  );
  const finished = (updates[1] as { step: { output: { truncated: boolean } } }).step;
  assert.equal(finished.output.truncated, true);
});
