import assert from "node:assert/strict"
import test from "node:test"

import {
  agentOutputPriceCap,
  alternativeFloorRatio,
  chooseAutoModels,
  supportedVariant,
  type AutoModelCandidate,
} from "./auto-model-choice.ts"

function candidate(
  providerId: string,
  modelId: string,
  estimatedCost: number | null,
  smartScore: number | null | undefined,
  segment: AutoModelCandidate<string>["segment"] = "benchmarked",
  outputPrice?: number | null
): AutoModelCandidate<string> {
  return {
    ...(outputPrice === undefined ? {} : { outputPrice }),
    providerId,
    modelId,
    position: 0,
    segment,
    estimatedCost,
    ...(smartScore === undefined ? {} : { smartScore: smartScore as number }),
    model: `${providerId}/${modelId}`,
  }
}

// The scores and relative prices of the current catalog, per provider.
const claudeFable = candidate("anthropic", "fable", 0.6, 64.6)
const claudeSonnet = candidate("anthropic", "sonnet", 0.15, 54.5)
const claudeHaiku = candidate("anthropic", "haiku", 0.0075, 36.5)
const gptAstra = candidate("openai", "astra", 0.6, 62.1)
const gptLuna = candidate("openai", "luna", 0.0075, 27.9)
const gptOss = candidate("openai", "oss", 0.004, 3.8)
const geminiNeon = candidate("gemini", "neon", 0.225, 61.4)
const geminiFlash = candidate("gemini", "flash", 0.062, 30.8)
const geminiLite = candidate("gemini", "lite", 0.028, 11.7)

test("the floor is a share of the top score, set at 0.4", () => {
  assert.equal(alternativeFloorRatio, 0.4)
})

test("the agent is the smartest of the frontier", () => {
  const choice = chooseAutoModels([gptAstra, claudeSonnet, geminiNeon])
  assert.equal(choice?.agent, "openai/astra")
})

test("several providers: the frontier decides across them", () => {
  const choice = chooseAutoModels([
    claudeFable,
    claudeHaiku,
    gptAstra,
    gptLuna,
    geminiNeon,
    geminiFlash,
  ])
  // gpt-astra costs as much as the Fable and scores less: it is dominated.
  assert.equal(choice?.agent, "anthropic/fable")
  // Luna costs the same as Haiku and scores less: dominated. Haiku is the
  // cheapest model above 64.6 * 0.4.
  assert.equal(choice?.alternative, "anthropic/haiku")
  assert.equal(choice?.source, "frontier")
})

test("the alternative is the cheapest model at or above the floor", () => {
  const choice = chooseAutoModels([
    gptAstra,
    gptLuna,
    gptOss,
    candidate("openai", "terra", 0.075, 51.3),
  ])
  // Luna: 27.9 >= 62.1 * 0.4 = 24.84. gpt-oss is cheaper but far below it.
  assert.equal(choice?.agent, "openai/astra")
  assert.equal(choice?.alternative, "openai/luna")
})

test("tiny models stay under the floor", () => {
  const choice = chooseAutoModels([geminiNeon, geminiFlash, geminiLite])
  // Floor 61.4 * 0.4 = 24.56: Lite (11.7) is out, Flash (30.8) is in.
  assert.equal(choice?.alternative, "gemini/flash")
})

test("a score exactly on the floor passes", () => {
  const choice = chooseAutoModels([
    candidate("a", "top", 10, 50),
    candidate("a", "edge", 1, 20),
    candidate("a", "below", 0.5, 19.9),
  ])
  assert.equal(choice?.alternative, "a/edge")
})

test("a different floor ratio moves the floor", () => {
  const list = [gptAstra, gptLuna, candidate("openai", "terra", 0.075, 51.3)]
  assert.equal(
    chooseAutoModels(list, undefined, 0.4)?.alternative,
    "openai/luna"
  )
  assert.equal(
    chooseAutoModels(list, undefined, 0.5)?.alternative,
    "openai/terra"
  )
})

test("no model passing the floor leaves the alternative on the agent model", () => {
  // Cannot happen with a positive score and a ratio below 1; a ratio above
  // 1 stands for "nothing but the top passes", and a negative score fails it.
  const lone = chooseAutoModels([candidate("a", "only", 1, -5)])
  assert.equal(lone?.agent, "a/only")
  assert.equal(lone?.alternative, "a/only")
  const weak = chooseAutoModels(
    [candidate("a", "top", 5, 30), candidate("a", "small", 1, 29)],
    undefined,
    1.1
  )
  assert.equal(weak?.agent, "a/top")
  assert.equal(weak?.alternative, "a/top")
})

test("a single model is both roles", () => {
  const choice = chooseAutoModels([claudeSonnet])
  assert.equal(choice?.agent, "anthropic/sonnet")
  assert.equal(choice?.alternative, "anthropic/sonnet")
})

test("a dominated model is never picked, even above the floor", () => {
  const choice = chooseAutoModels([
    candidate("a", "good", 1, 40),
    // Dearer and no smarter: off the frontier.
    candidate("a", "worse", 2, 35),
    candidate("a", "top", 10, 60),
  ])
  assert.equal(choice?.alternative, "a/good")
})

test("unscored models are never picked", () => {
  const choice = chooseAutoModels([
    candidate("a", "fresh", 0.001, undefined, "unbenchmarked"),
    candidate("a", "null-score", 0.001, null),
    candidate("a", "no-cost", null, 40),
    candidate("a", "slow", 1, 30),
    candidate("a", "top", 5, 50),
  ])
  assert.equal(choice?.agent, "a/top")
  assert.equal(choice?.alternative, "a/slow")
})

test("a benchmarked entry flagged unbenchmarked is not scored either", () => {
  const choice = chooseAutoModels([
    candidate("a", "odd", 1, 99, "unbenchmarked"),
    candidate("a", "real", 2, 20),
  ])
  assert.equal(choice?.agent, "a/real")
})

test("only unscored models: the fallback stands in for both", () => {
  const choice = chooseAutoModels(
    [candidate("compat", "custom", null, undefined, "unbenchmarked")],
    "compat/custom"
  )
  assert.deepEqual(choice, {
    agent: "compat/custom",
    alternative: "compat/custom",
    agentVariant: undefined,
    alternativeVariant: undefined,
    source: "fallback",
  })
})

test("no recommendations: the fallback, or no choice without one", () => {
  assert.equal(chooseAutoModels([], "anthropic/default")?.source, "fallback")
  assert.equal(chooseAutoModels([]), undefined)
  assert.equal(
    chooseAutoModels([candidate("a", "fresh", 1, undefined, "unbenchmarked")]),
    undefined
  )
})

test("the fallback is not used while something is scored", () => {
  const choice = chooseAutoModels([claudeSonnet], "compat/custom")
  assert.equal(choice?.agent, "anthropic/sonnet")
})

test("ties: the same list gives the same choice in any order", () => {
  const twins = [
    candidate("b", "twin", 1, 40),
    candidate("a", "twin", 1, 40),
    candidate("c", "top", 9, 60),
  ]
  const forward = chooseAutoModels(twins)
  const backward = chooseAutoModels([...twins].reverse())
  assert.equal(forward?.alternative, "a/twin")
  assert.deepEqual(forward, backward)
})

test("equal scores: the cheaper one is the agent, the smarter wins an equal price", () => {
  const equalScore = chooseAutoModels([
    candidate("a", "dear", 5, 50),
    candidate("a", "cheap", 2, 50),
  ])
  // Same score: the dearer is dominated.
  assert.equal(equalScore?.agent, "a/cheap")
  const equalCost = chooseAutoModels([
    candidate("a", "plain", 2, 40),
    candidate("a", "sharp", 2, 45),
  ])
  assert.equal(equalCost?.agent, "a/sharp")
})

test("both models keep their own reasoning default", () => {
  const choice = chooseAutoModels([claudeFable, claudeHaiku])
  assert.equal(choice?.agentVariant, undefined)
  assert.equal(choice?.alternativeVariant, undefined)
  const same = chooseAutoModels([claudeSonnet])
  assert.equal(same?.alternativeVariant, undefined)
})

test("the output price cap sits between Opus and Fable", () => {
  assert.equal(agentOutputPriceCap, 30)
})

test("the agent is the smartest model within the output price cap", () => {
  const fable = candidate("anthropic", "fable", 0.6, 64.6, "benchmarked", 50)
  const opus = candidate("anthropic", "opus", 0.3, 60, "benchmarked", 25)
  const sonnet = candidate("anthropic", "sonnet", 0.15, 54.5, "benchmarked", 15)
  const haiku = candidate("anthropic", "haiku", 0.0075, 36.5, "benchmarked", 5)
  const choice = chooseAutoModels([fable, opus, sonnet, haiku])
  assert.equal(choice?.agent, "anthropic/opus")
  // The floor follows the agent: 60 * 0.4 = 24.
  assert.equal(choice?.alternative, "anthropic/haiku")
  // A price exactly on the cap passes.
  const edge = candidate("a", "edge", 1, 50, "benchmarked", 30)
  assert.equal(
    chooseAutoModels([edge, candidate("a", "dear", 2, 60, "benchmarked", 31)])
      ?.agent,
    "a/edge"
  )
})

test("a model without a known output price is not excluded by the cap", () => {
  const choice = chooseAutoModels([
    candidate("a", "unknown", 2, 60, "benchmarked", null),
    candidate("a", "priced", 1, 50, "benchmarked", 10),
  ])
  assert.equal(choice?.agent, "a/unknown")
})

test("every model above the cap: the cheapest of the frontier is the agent", () => {
  const choice = chooseAutoModels([
    candidate("a", "top", 2, 60, "benchmarked", 80),
    candidate("a", "less", 1, 55, "benchmarked", 40),
  ])
  assert.equal(choice?.agent, "a/less")
  assert.equal(choice?.alternative, "a/less")
})

test("a variant is saved only when the model offers it", () => {
  assert.equal(supportedVariant({ low: {}, high: {} }, "low"), "low")
  assert.equal(supportedVariant({ high: {} }, "low"), null)
  assert.equal(supportedVariant({}, undefined), null)
  assert.equal(supportedVariant(undefined, "low"), null)
})
