import * as React from "react"
import type { StoryTurnChoice } from "@blame/agent-runtime/engine-protocol"
import { toast } from "sonner"

import type {
  UserStory,
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import { parseUserStory } from "@/components/backlog/data/backlog-api"
import { conversationUltra, storyUltraKey } from "@/lib/conversation-ultra"
import { usePlatform } from "@/context/platform"
import { useLatestCallback } from "@/lib/use-latest-callback"
import { withStoryTransition } from "./story-transitions"

export type StoryMessageInput = {
  text: string
  codeSelectionAttachments?: UserStoryCodeSelectionAttachment[] | null
  fileAttachments?: UserStoryFileAttachment[] | null
  /** While the agent works: hand it the message now, inside its turn. */
  steer?: boolean
}

/**
 * Sends a message to a story's agent through the story service. A paused
 * or reviewed story resumes; while its agent works, the message waits for
 * the turn to end (the engine queues it) or, with `steer`, joins the
 * running turn.
 */
export function useStoryComments({
  turnFor,
}: {
  /** What the person picked for the story's next turn (its model, its cap…). */
  turnFor(story: UserStory): StoryTurnChoice
}) {
  const platform = usePlatform()
  const send = useLatestCallback(
    async (story: UserStory, input: StoryMessageInput) => {
      const engine = platform.engine
      if (!engine || !story.engineSessionId) {
        toast.error("Unable to send your message", {
          description: !engine
            ? "The desktop agent engine is not available."
            : "This user story has no agent to talk to yet.",
          position: "bottom-right",
        })
        return undefined
      }
      try {
        const sent = await engine.call("storySend", {
          storyId: story.id,
          message: {
            text: input.text,
            codeSelectionAttachments: input.codeSelectionAttachments,
            fileAttachments: input.fileAttachments,
          },
          steer: input.steer,
          turn: {
            ...turnFor(story),
            // Ultra mode is whatever the composer shows when the message goes.
            ultra: conversationUltra.get(storyUltraKey(story.id)),
          },
        })
        return parseUserStory(sent)
      } catch (error) {
        toast.error("Unable to send your message", {
          description: error instanceof Error ? error.message : String(error),
          position: "bottom-right",
        })
        return undefined
      }
    }
  )
  const requestChanges = React.useCallback(
    (story: UserStory, input: StoryMessageInput) =>
      withStoryTransition(story.id, () => send(story, input)),
    [send]
  )
  return { requestChanges }
}
