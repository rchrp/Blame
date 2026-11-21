import assert from "node:assert/strict"
import test from "node:test"

import {
  failureMessage,
  limitAllowsAutomaticRun,
  modelLimit,
  modelLimitOfError,
  modelLimitText,
} from "./model-limit.ts"

// The engine's words (crates/blame-engine-providers/src/error.rs) for the
// providers' real messages, as a task's failure reaches the app.
const claudeCode =
  "Error invoking remote method 'engine:call': Error: The title generator could not run: " +
  "Your Claude Code usage for `claude-opus-5` is used up until it resets: " +
  "\"You've hit your session limit · resets 1:10am (Europe/Bucharest)\". " +
  "Choose another model, or wait for the reset. It resets at 2026-11-20T23:10:00.000Z."
const chatgpt =
  "Your ChatGPT usage for `gpt-6-luna` is used up until it resets: " +
  "\"The usage limit has been reached (HTTP 429)\". It resets in about 1 h 30 min. " +
  "Choose another model, or wait for the reset."
const credit =
  "The security audit could not run: Anthropic has no credit or quota left for `claude-sonnet-5`: " +
  "\"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits. (HTTP 400)\". " +
  "Add credit with Anthropic, or choose another model."
const now = new Date("2026-11-20T21:28:00.000Z")

test("reads the engine's used-up and out-of-credit messages", () => {
  assert.deepEqual(modelLimit(claudeCode), {
    kind: "usage_limit",
    provider: "Claude Code",
    model: "claude-opus-5",
    said: "You've hit your session limit · resets 1:10am (Europe/Bucharest)",
    resetsAt: new Date("2026-11-20T23:10:00.000Z"),
  })
  assert.equal(modelLimit(chatgpt)?.model, "gpt-6-luna")
  assert.equal(modelLimit(chatgpt)?.resetsAt, undefined, "a relative time is not an instant")
  assert.equal(modelLimit(credit)?.kind, "billing")
  assert.equal(modelLimit(credit)?.provider, "Anthropic")
})

test("a rate limit or an unfinished task is not a model limit", () => {
  assert.equal(
    modelLimit("Claude Code is limiting requests to `claude-opus-5`: \"Rate limited\" (HTTP 429)."),
    undefined
  )
  assert.equal(
    modelLimit("The code practice analyzer did not finish: the agent never gave its result with `submit_practices`."),
    undefined
  )
  assert.equal(failureMessage("Something else broke.", "alternative"), "Something else broke.")
})

test("the message names the model, the reset and the exact setting", () => {
  const text = modelLimitText(modelLimit(claudeCode)!, "alternative", now)
  assert.match(text, /^Your Claude Code usage for `claude-opus-5` is used up\. It resets (at|tomorrow at) /)
  assert.match(text, /Claude Code said: “You've hit your session limit · resets 1:10am \(Europe\/Bucharest\)”\./)
  assert.match(text, /choose another model in Settings → Models & Providers → Alternative model\.$/)
  const chat = modelLimitText(modelLimit(chatgpt)!, "conversation", now)
  assert.match(chat, /in the message box's model menu \(the default is Settings → Models & Providers → Agent model\)/)
  assert.doesNotMatch(chat, /It resets (at|tomorrow|on)/)
  assert.match(modelLimitText(modelLimit(credit)!, "alternative", now), /^Anthropic has no credit left for `claude-sonnet-5`\. .* Add credit with Anthropic, or choose another model in Settings/)
})

test("a conversation's failure resets from when it failed", () => {
  const limit = modelLimitOfError(
    { kind: "usage_limit", message: chatgpt, retry_after_ms: 5_400_000 },
    now.getTime()
  )
  assert.equal(limit?.resetsAt?.toISOString(), "2026-11-20T22:58:00.000Z")
  assert.equal(modelLimitOfError({ kind: "rate_limited", message: chatgpt }, 0), undefined)
})

test("the app runs a task by itself again only after the reset or with another model", () => {
  const failedModel = { providerId: "claude-code", modelId: "claude-opus-5" }
  const failedAt = now.getTime()
  const same = { providerId: "claude-code", modelId: "claude-opus-5" }
  const allows = (error: string, model = same, at = failedAt + 60_000) =>
    limitAllowsAutomaticRun({ error, failedAt, failedModel, model, now: at })
  assert.equal(allows(claudeCode), false)
  assert.equal(allows(claudeCode, same, Date.parse("2026-11-20T23:10:00.000Z")), true)
  assert.equal(allows(claudeCode, { providerId: "chatgpt", modelId: "gpt-6-luna" }), true)
  assert.equal(allows(chatgpt), false, "no instant: it waits an hour")
  assert.equal(allows(chatgpt, same, failedAt + 60 * 60_000), true)
  assert.equal(allows("Something else broke."), true)
})
