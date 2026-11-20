import * as React from "react"
import { Maximize2Icon, Minimize2Icon } from "lucide-react"
import type { Transcript } from "@blame/engine-client/transcript"

import type { StoryContextCompaction } from "@/components/backlog/drawer/story-context-compaction"
import { StoryStatsIsland } from "@/components/backlog/drawer/user-story-drawer-sidebar"
import type { AgentConversationRun } from "@/components/chat/agent-conversation"
import {
  conversationChanges,
  engineStatsSource,
} from "@/components/chat/engine/engine-stats"
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
  const changes = React.useMemo(() => conversationChanges(runs), [runs])
  const source = React.useMemo(
    () => engineStatsSource({ id: chatId, running, runs, transcript }),
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
