import * as React from "react"
import {
  helperAgentsAvailable,
  type EngineSessionSettings,
} from "@blame/agent-runtime/engine-protocol"
import { toast } from "sonner"

import type {
  UserStory,
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { useCloudAuth } from "@/context/cloud-auth"
import { conversationUltra, storyUltraKey } from "@/lib/conversation-ultra"
import { usePlatform } from "@/context/platform"
import { useLatestCallback } from "@/lib/use-latest-callback"
import {
  storyMessage,
  withAgentModel,
} from "./story-engine"
import { readStoryAttachment } from "./story-attachment"
import { withStoryTransition } from "./story-transitions"

export type StoryMessageInput = {
  text: string
  codeSelectionAttachments?: UserStoryCodeSelectionAttachment[] | null
  fileAttachments?: UserStoryFileAttachment[] | null
  /** While the agent works: hand it the message now, inside its turn. */
  steer?: boolean
}

/**
 * Sends a message to a story's agent. A paused or reviewed story resumes;
 * while its agent works, the message waits for the turn to end (the engine
 * queues it) or, with `steer`, joins the running turn.
 */
export function useStoryComments({
  backlog,
  settingsFor,
}: {
  backlog: ReturnType<typeof useBacklogStore>
  /** The settings of the story's next turn (its model, its preview…). */
  settingsFor(story: UserStory): Promise<EngineSessionSettings>
}) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const send = useLatestCallback(
    async (story: UserStory, input: StoryMessageInput) => {
      const engine = platform.engine
      const session = story.engineSessionId
      if (!engine || !story.worktree || !session) {
        toast.error("Unable to send your message", {
          description: !engine
            ? "The desktop agent engine is not available."
            : "This user story has no agent to talk to yet.",
          position: "bottom-right",
        })
        return undefined
      }
      const running = story.agentStatus === "Running"
      try {
        const settings = await settingsFor(story)
        // Ultra mode is whatever the composer shows when the message goes.
        const ultra =
          conversationUltra.get(storyUltraKey(story.id)) &&
          helperAgentsAvailable(settings.settings.model.providerId)
        await engine.call("send", {
          session,
          message: {
            ...(await storyMessage(
              input.text,
              input.codeSelectionAttachments,
              input.fileAttachments,
              (file) => readStoryAttachment(auth.apiConnection, file)
            )),
            ...(ultra ? { ultra } : {}),
          },
          delivery: running && input.steer ? "steer" : "turn",
          settings,
        })
        if (running) return story
        const { model } = settings.settings
        return await backlog.update(story, {
          agentLastError: null,
          agentModels: withAgentModel(story.agentModels, {
            modelId: model.modelId,
            providerId: model.providerId,
            reasoningEffort: model.reasoning ?? null,
          }),
          agentStatus: "Running",
          status: "in-progress",
        })
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
  // `send` is for a caller already inside the story's transition (resume):
  // a second transition on the same story would be refused.
  return { requestChanges, send }
}
