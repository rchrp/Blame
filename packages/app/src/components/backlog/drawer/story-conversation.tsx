import * as React from "react"
import type { Transcript } from "@blame/engine-client/transcript"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import {
  useEngineCompaction,
  type StoryContextCompaction,
} from "@/components/backlog/drawer/story-context-compaction"
import type { AgentStatsSource } from "@/components/backlog/drawer/user-story-drawer-sidebar"
import { engineStatsSource } from "@/components/chat/engine/engine-stats"
import {
  transcriptConversation,
  type TranscriptConversation,
} from "@/components/chat/engine/transcript-conversation"
import { useEngineSession } from "@/components/chat/engine/use-engine-session"
import { usePlatform } from "@/context/platform"
import { storyLocation } from "@/pages/backlog/story-engine"

export type StoryConversation = {
  conversation?: TranscriptConversation
  transcript?: Transcript
  loaded: boolean
  error?: string
}

const StoryConversationContext = React.createContext<StoryConversation>({
  loaded: false,
})

/**
 * The open story's conversation with its agent, read from its engine
 * session once for the whole drawer (timeline, metrics, stats).
 */
export function StoryConversationProvider({
  children,
  story,
}: {
  children: React.ReactNode
  story: Pick<UserStory, "engineSessionId" | "workspaceMode"> | undefined
}) {
  const platform = usePlatform()
  const location = storyLocation(
    story?.workspaceMode ?? "direct",
    platform.platform
  )
  const view = useEngineSession(story?.engineSessionId, location)
  const transcript = view.transcript
  const conversation = React.useMemo(
    () =>
      transcript
        ? transcriptConversation(transcript, "You", { brief: true })
        : undefined,
    [transcript]
  )
  const value = React.useMemo(
    () => ({
      conversation,
      error: view.error,
      loaded: !story?.engineSessionId || view.loaded,
      transcript,
    }),
    [conversation, story?.engineSessionId, transcript, view.error, view.loaded]
  )
  return (
    <StoryConversationContext.Provider value={value}>
      {children}
    </StoryConversationContext.Provider>
  )
}

export function useStoryConversation() {
  return React.useContext(StoryConversationContext)
}

/**
 * What the drawer's stats island shows of the open story: the story's own
 * agent fields, with model, usage and compaction from its records.
 */
export function useStoryAgentStats(
  story:
    | Pick<
        UserStory,
        | "id"
        | "agentModels"
        | "agentStatus"
        | "engineSessionId"
        | "workspaceMode"
      >
    | undefined
): { source?: AgentStatsSource; compaction: StoryContextCompaction } {
  const platform = usePlatform()
  const { conversation, transcript } = useStoryConversation()
  const running =
    story?.agentStatus === "Running" || transcript?.runningTurn !== undefined
  const source = React.useMemo(() => {
    if (!story) return undefined
    if (!transcript || !conversation)
      return {
        agentModels: story.agentModels,
        agentStatus: story.agentStatus,
        id: story.id,
      }
    return engineStatsSource({
      agentModels: story.agentModels,
      id: story.id,
      running,
      runs: conversation.runs,
      transcript,
    })
  }, [conversation, running, story, transcript])
  const compaction = useEngineCompaction({
    available: Boolean(transcript?.turns.length),
    location: storyLocation(
      story?.workspaceMode ?? "direct",
      platform.platform
    ),
    running,
    session: story?.engineSessionId,
  })
  return { compaction, source }
}
