import assert from "node:assert/strict"
import test from "node:test"

import { saveStoryModelChoice, storyModelChoice } from "./story-model-choice.ts"

const run = (createdAt: string, modelId: string, reasoningEffort: string | null) => ({
  createdAt,
  id: createdAt,
  kind: "change-request" as const,
  modelId,
  providerId: "openai",
  reasoningEffort,
  status: "completed" as const,
  userStoryId: "s1",
})

test("a story keeps the model of its last turn", () => {
  const choice = storyModelChoice({
    agentModelId: "gpt-6-astra",
    agentProviderId: "openai",
    agentRuns: [
      run("2026-10-02T10:00:00.000Z", "gpt-6.1-sol", "high"),
      run("2026-10-01T10:00:00.000Z", "gpt-6-astra", null),
    ],
    id: "s1",
  })
  assert.equal(choice?.modelId, "gpt-6.1-sol")
  assert.equal(choice?.reasoningEffort, "high")
})

test("falls back to the story's model, then nothing", () => {
  assert.equal(
    storyModelChoice({ agentModelId: "gpt-6-astra", agentProviderId: "openai", id: "s2" })
      ?.modelId,
    "gpt-6-astra"
  )
  assert.equal(storyModelChoice({ id: "s3" }), undefined)
})

test("a model picked for the story wins over its history", () => {
  saveStoryModelChoice("s4", {
    credentialLabel: null,
    modelId: "gpt-6.1-sol",
    providerId: "openai",
    reasoningEffort: "medium",
  })
  const choice = storyModelChoice({
    agentModelId: "gpt-6-astra",
    agentProviderId: "openai",
    agentRuns: [run("2026-10-01T10:00:00.000Z", "gpt-6-astra", null)],
    id: "s4",
  })
  assert.equal(choice?.modelId, "gpt-6.1-sol")
  assert.equal(choice?.reasoningEffort, "medium")
})
