import * as React from "react"
import { Maximize2Icon, Minimize2Icon } from "lucide-react"

import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import { StoryStatsIsland } from "@/components/backlog/drawer/user-story-drawer-sidebar"
import type { QuickChat } from "@/components/chat/data/quick-chat-data"
import { turnChanges } from "@/components/chat/tool-calls/turn-changes"
import { Button } from "@/components/ui/button"

// The chat's agent at a glance, under the header at the top right, like the
// story drawer's panel. It folds into a pill with the chat's one toggle.
export function QuickChatStats({
  chat,
  expanded,
  onExpandedChange,
}: {
  chat: QuickChat
  expanded: boolean
  onExpandedChange(expanded: boolean): void
}) {
  const changes = useQuickChatChanges(chat)
  return (
    <>
      <StoryStatsIsland
        buttons={1}
        className="top-[calc(var(--header-height)+0.25rem)]"
        diffStats={changes}
        expanded={expanded}
        source={chat}
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

// What the agent changed over the whole chat, from each turn's own tool
// calls: the chat works in the project folder, where git also holds the
// person's own edits.
function useQuickChatChanges(chat: QuickChat): UserStoryDiffStats | undefined {
  const runs = chat.agentRuns
  return React.useMemo(() => {
    const files = new Set<string>()
    let additions = 0
    let deletions = 0
    for (const run of runs ?? []) {
      if (!run.activities?.length) continue
      const changes = turnChanges(run.activities)
      additions += changes.additions
      deletions += changes.deletions
      for (const file of changes.files) files.add(file.path)
    }
    return runs?.length
      ? { additions, deletions, files: files.size }
      : undefined
  }, [runs])
}
