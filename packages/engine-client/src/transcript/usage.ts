import type { Usage } from "../protocol.js"
import type { UsageTotals } from "./model.js"

export const NO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costMicroUsd: 0,
  requests: 0,
  unpricedRequests: 0,
}

/** Adds one request's usage to a running total, returning a new total. */
export function addUsage(total: UsageTotals, usage: Usage): UsageTotals {
  return {
    inputTokens: total.inputTokens + (usage.input_tokens ?? 0),
    outputTokens: total.outputTokens + (usage.output_tokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (usage.cache_read_tokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (usage.cache_write_tokens ?? 0),
    reasoningTokens: total.reasoningTokens + (usage.reasoning_tokens ?? 0),
    costMicroUsd: total.costMicroUsd + (usage.cost_micro_usd ?? 0),
    requests: total.requests + 1,
    unpricedRequests: total.unpricedRequests + (usage.cost_micro_usd === undefined ? 1 : 0),
  }
}
