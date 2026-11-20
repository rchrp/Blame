import assert from "node:assert/strict"
import test from "node:test"

import { saveStoryModelChoice, storyModelChoice } from "./story-model-choice.ts"

test("a story keeps the model of its last turn", () => {
  const choice = storyModelChoice({
    agentModels: [
      { modelId: "gpt-6-astra", providerId: "openai", reasoningEffort: null },
      { modelId: "gpt-6.1-sol", providerId: "openai", reasoningEffort: "high" },
    ],
    id: "s1",
  })
  assert.equal(choice?.modelId, "gpt-6.1-sol")
  assert.equal(choice?.reasoningEffort, "high")
})

test("a story no model worked on has no choice", () => {
  assert.equal(storyModelChoice({ id: "s3" }), undefined)
  assert.equal(storyModelChoice({ agentModels: [], id: "s3" }), undefined)
})

test("a model picked for the story wins over its history", () => {
  saveStoryModelChoice("s4", {
    credentialLabel: null,
    modelId: "gpt-6.1-sol",
    providerId: "openai",
    reasoningEffort: "medium",
  })
  const choice = storyModelChoice({
    agentModels: [{ modelId: "gpt-6-astra", providerId: "openai" }],
    id: "s4",
  })
  assert.equal(choice?.modelId, "gpt-6.1-sol")
  assert.equal(choice?.reasoningEffort, "medium")
})
