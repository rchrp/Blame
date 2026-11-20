import * as React from "react"
import { Maximize2Icon, Minimize2Icon } from "lucide-react"
import type { Transcript } from "@blame/engine-client/transcript"

import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import type { StoryContextCompaction } from "@/components/backlog/drawer/story-context-compaction"
import {
  StoryStatsIsland,
  type AgentStatsSource,
} from "@/components/backlog/drawer/user-story-drawer-sidebar"
import type { AgentConversationRun } from "@/components/chat/agent-conversation"
import { turnChanges } from "@/components/chat/tool-calls/turn-changes"
import { Button } from "@/components/ui/button"

// The chat's agent at a glance, under the header at the top right, like the
// story drawer's panel. It folds into a pill with the chat's one toggle.
export function QuickChatStats({
  chatId,
  compaction,
  expanded,
  onExpandedChange,
  running,
  runs,
  transcript,
}: {
  chatId: string
  compaction: StoryContextCompaction
  expanded: boolean
  onExpandedChange(expanded: boolean): void
  running: boolean
  runs: AgentConversationRun[]
  transcript: Transcript
}) {
  const changes = useQuickChatChanges(runs)
  const source = React.useMemo(
    () => statsSource(chatId, running, runs, transcript),
    [chatId, running, runs, transcript]
  )
  return (
    <>
      <StoryStatsIsland
        buttons={1}
        className="top-[calc(var(--header-height)+0.25rem)]"
        compaction={compaction}
        diffStats={changes}
        expanded={expanded}
        source={source}
        // The next message uses the model picked in the composer.
        useEditorModel
        onExpand={() => onExpandedChange(true)}
      />
      <Button
        type="button"
        className="absolute top-[calc(var(--header-height)+0.75rem)] right-6 z-30 border bg-background/90 shadow-sm"
        size="icon-sm"
        variant="outline"
        onClick={() => onExpandedChange(!expanded)}
        aria-label={expanded ? "Minimize agent stats" : "Show agent stats"}
        title={expanded ? "Minimize" : "Expand"}
      >
        {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
      </Button>
    </>
  )
}

// The island reads a story's agent fields; a chat's come from its records.
// The context gauge uses the last reply's input, the totals what was spent.
function statsSource(
  chatId: string,
  running: boolean,
  runs: AgentConversationRun[],
  transcript: Transcript
): AgentStatsSource {
  const last = transcript.items.findLast(
    (item) => item.kind === "text" || item.kind === "tool_call"
  )
  const lastUsage = last && "message" in last ? last.message?.usage : undefined
  const spent = transcript.usage.spent
  const lastRun = runs.at(-1)
  return {
    agentModelId: lastRun?.modelId ?? null,
    agentProviderId: lastRun?.providerId ?? null,
    agentRuns: runs,
    agentStatus: running ? "Running" : null,
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
    clineSessionId: null,
    id: chatId,
  }
}

// What the agent changed over the whole chat, from each turn's own tool
// calls: the chat works in the project folder, where git also holds the
// person's own edits.
function useQuickChatChanges(
  runs: AgentConversationRun[]
): UserStoryDiffStats | undefined {
  return React.useMemo(() => {
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
    return runs.length ? { additions, deletions, files: files.size } : undefined
  }, [runs])
}
