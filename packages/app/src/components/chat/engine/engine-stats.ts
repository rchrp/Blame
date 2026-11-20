import type { Transcript } from "@blame/engine-client/transcript"

import type { UserStoryAgentModel } from "@/components/backlog/data/backlog-data"
import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import type { AgentStatsSource } from "@/components/backlog/drawer/user-story-drawer-sidebar"
import type { AgentConversationRun } from "@/components/chat/agent-conversation"
import { turnChanges } from "@/components/chat/tool-calls/turn-changes"

/**
 * What the stats island shows of a conversation, from its records: the
 * last turn's model, the context the last reply used, and what was spent
 * (rewound turns included: they were paid for).
 */
export function engineStatsSource(input: {
  id: string
  running: boolean
  runs: readonly AgentConversationRun[]
  transcript: Transcript
  agentModels?: UserStoryAgentModel[] | null
}): AgentStatsSource {
  const last = input.transcript.items.findLast(
    (item) => item.kind === "text" || item.kind === "tool_call"
  )
  const lastUsage = last && "message" in last ? last.message?.usage : undefined
  const spent = input.transcript.usage.spent
  const lastRun = input.runs.at(-1)
  const model =
    lastRun?.providerId && lastRun.modelId
      ? {
          providerId: lastRun.providerId,
          modelId: lastRun.modelId,
          reasoningEffort: lastRun.reasoningEffort ?? null,
        }
      : undefined
  return {
    agentModels: input.agentModels ?? (model ? [model] : []),
    agentStatus: input.running ? "Running" : null,
    agentUsage: {
      cacheReadTokens: lastUsage?.cache_read_tokens ?? 0,
      cacheWriteTokens: lastUsage?.cache_write_tokens ?? 0,
      inputTokens: lastUsage?.input_tokens ?? 0,
      outputTokens: lastUsage?.output_tokens ?? 0,
      totalCacheReadTokens: spent.cacheReadTokens,
      totalCacheWriteTokens: spent.cacheWriteTokens,
      totalCost: spent.costMicroUsd / 1_000_000,
      totalInputTokens: spent.inputTokens,
      totalOutputTokens: spent.outputTokens,
    },
    id: input.id,
    model,
  }
}

/** What the agent changed over the whole conversation, from each turn's own tool calls. */
export function conversationChanges(
  runs: readonly AgentConversationRun[]
): UserStoryDiffStats | undefined {
  if (!runs.length) return undefined
  const files = new Set<string>()
  let additions = 0
  let deletions = 0
  for (const run of runs) {
    if (!run.activities?.length) continue
    const changes = turnChanges(run.activities)
    additions += changes.additions
    deletions += changes.deletions
    for (const file of changes.files) files.add(file.path)
  }
  return { additions, deletions, files: files.size }
}
