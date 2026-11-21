import assert from "node:assert/strict"
import test from "node:test"
import type { ModelRecommendation } from "@blame/agent-runtime"

import {
  intentModels,
  modelsInRange,
  rankedEpicModels,
} from "./epic-model-range.ts"

function model(
  providerId: string,
  modelId: string,
  estimatedCost: number,
  smartScore: number,
  segment: ModelRecommendation["segment"] = "benchmarked"
): ModelRecommendation {
  return {
    estimatedCost,
    modelId,
    position: 0,
    providerId,
    segment,
    smartScore,
  }
}

const a1 = model("a", "a-small", 1, 10)
const a2 = model("a", "a-large", 5, 30)
const b1 = model("b", "b-mid", 3, 20)
const b2 = model("b", "b-worse", 6, 15)
const fresh = model("a", "a-new", 2, 0, "unbenchmarked")
const recommendations = {
  all: [a1, fresh, b1, a2],
  byProvider: { a: [a1, fresh, a2], b: [b1, b2] },
}

test("all providers rank the benchmarked models cheapest first, evenly", () => {
  const ranked = rankedEpicModels({ recommendations })
  assert.deepEqual(
    ranked.map((item) => [item.modelId, item.rank]),
    [
      ["a-small", 0],
      ["b-mid", 0.5],
      ["a-large", 1],
    ]
  )
})

test("hidden models leave the ranking", () => {
  const ranked = rankedEpicModels({
    recommendations,
    hidden: [{ providerId: "b", modelId: "b-mid" }],
  })
  assert.deepEqual(
    ranked.map((item) => item.modelId),
    ["a-small", "a-large"]
  )
})

test("one provider uses its own list; several drop the dominated again", () => {
  assert.deepEqual(
    rankedEpicModels({ recommendations, providers: ["b"] }).map(
      (item) => item.modelId
    ),
    ["b-mid", "b-worse"]
  )
  assert.deepEqual(
    rankedEpicModels({ recommendations, providers: ["a", "b"] }).map(
      (item) => item.modelId
    ),
    ["a-small", "b-mid", "a-large"]
  )
})

test("a single model sits in the middle", () => {
  const ranked = rankedEpicModels({
    recommendations,
    providers: ["a"],
    hidden: [a2],
  })
  assert.deepEqual(
    ranked.map((item) => item.rank),
    [0.5]
  )
})

test("the intents pick the ends and the middle of the range", () => {
  const ranked = rankedEpicModels({ recommendations })
  const whole = intentModels(ranked, { min: 0, max: 1 })!
  assert.equal(whole.cheaper.modelId, "a-small")
  assert.equal(whole.balanced.modelId, "b-mid")
  assert.equal(whole.smarter.modelId, "a-large")
  const top = intentModels(ranked, { min: 0.5, max: 1 })!
  assert.equal(top.cheaper.modelId, "b-mid")
  assert.equal(top.balanced.modelId, "b-mid")
  assert.equal(top.smarter.modelId, "a-large")
})

test("a range between notches still gets the nearest model", () => {
  const ranked = rankedEpicModels({ recommendations })
  assert.deepEqual(
    modelsInRange(ranked, { min: 0.6, max: 0.7 }).map((item) => item.modelId),
    ["b-mid"]
  )
  assert.equal(intentModels([], { min: 0, max: 1 }), undefined)
})
