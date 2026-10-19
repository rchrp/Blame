import * as React from "react"
import type { AgentEvent } from "@blame/agent-runtime"
import { toast } from "sonner"

import type {
  UserStory,
  UserStoryAgentRun,
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { nextCheckpointRunCount } from "@/components/chat/agent-run-checkpoints"
import type { Platform } from "@/context/platform"
import { useLatestCallback } from "@/lib/use-latest-callback"
import {
  clineLogPath,
  errorMessage,
  reportAgentPersistenceError,
} from "./backlog-rotation-helpers"
import { finalizeStoppedRun } from "./story-agent-control"
import { withStoryTransition } from "./story-transitions"

type StoryComments = {
  backlog: ReturnType<typeof useBacklogStore>
  persistAgentEvent(
    story: UserStory,
    run: UserStoryAgentRun | undefined,
    event: AgentEvent
  ): Promise<void>
  platform: Platform
  startStoryDevelopmentSession(
    story: UserStory,
    input: {
      feedback?: string
      feedbackCodeSelectionAttachments?: UserStoryCodeSelectionAttachment[]
      feedbackFileAttachments?: UserStoryFileAttachment[]
      resumeSessionId?: string | null
      worktree: string
    }
  ): Promise<{ executionId: string; sessionId: string; storyId: string }>
  subscribeStoryAgentEvents(
    story: UserStory,
    run: UserStoryAgentRun,
    sessionId: string,
    executionId: string
  ): void
  updateStory(
    story: UserStory,
    input: UserStoryUpdate,
    options?: { cleanup?: boolean }
  ): Promise<UserStory>
}

// Sends a comment to a story's agent: resumes a paused or reviewed story,
// or interrupts a running one (it stops, reads the comment, continues).
export function useStoryComments({
  backlog,
  persistAgentEvent,
  platform,
  startStoryDevelopmentSession,
  subscribeStoryAgentEvents,
  updateStory,
}: StoryComments) {
  const sendStoryComment = React.useCallback(
    async (
      story: UserStory,
      feedback: string,
      commentId: string,
      codeSelectionAttachments:
        | UserStoryCodeSelectionAttachment[]
        | null
        | undefined,
      fileAttachments: UserStoryFileAttachment[] | null | undefined
    ) => {
      if (!story.worktree) {
        toast.error("Unable to request changes", {
          description: "This user story has no active worktree.",
          position: "bottom-right",
        })
        return undefined
      }
      if (!story.clineSessionId) {
        toast.error("Unable to request changes", {
          description: "This user story has no existing Cline session.",
          position: "bottom-right",
        })
        return undefined
      }
      const agent = platform.agent
      if (!agent) {
        toast.error("Unable to request changes", {
          description: "Desktop agent runtime is not available.",
          position: "bottom-right",
        })
        return undefined
      }
      let session: { executionId: string; sessionId: string; storyId: string }
      try {
        if (story.status === "in-progress" && story.agentStatus !== "Paused") {
          // Wait for the current execution to stop before starting the feedback turn.
          // A failed stop must preserve the saved comment and composer draft.
          await agent.sessions.abort(story.clineSessionId)
          await finalizeStoppedRun(backlog, story, "Interrupted by your comment.")
        }
        session = await startStoryDevelopmentSession(story, {
          feedback,
          feedbackCodeSelectionAttachments: codeSelectionAttachments ?? [],
          feedbackFileAttachments: fileAttachments ?? [],
          resumeSessionId: story.clineSessionId,
          worktree: story.worktree,
        })
      } catch (error) {
        toast.error("Unable to request changes", {
          description: errorMessage(error),
          position: "bottom-right",
        })
        return undefined
      }
      const sessionId = session.sessionId
      const run = await backlog.createAgentRun(story, {
        checkpointRunCount: nextCheckpointRunCount(story.agentRuns ?? []),
        commentId,
        clineSessionId: sessionId,
        executionId: session.executionId,
        kind: "change-request",
      })
      const updatedStory = await updateStory(story, {
        agentLastError: null,
        agentLastEvent: `Cline debug log: ${clineLogPath(story.worktree, sessionId)}`,
        agentActivities: [],
        agentFinalResponse: null,
        agentUsage: null,
        agentStatus: "Running",
        clineSessionId: sessionId,
        status: "in-progress",
      })
      subscribeStoryAgentEvents(
        updatedStory,
        run,
        sessionId,
        session.executionId
      )
      void agent.sessions
        .sendDevelopment({
          executionId: session.executionId,
          sessionId,
          storyId: session.storyId,
          title: story.title,
          summary: story.summary,
          feedback,
          feedbackOnly: true,
          feedbackCodeSelectionAttachments: codeSelectionAttachments ?? [],
          feedbackFileAttachments: fileAttachments ?? [],
        })
        .catch((error) =>
          persistAgentEvent(updatedStory, run, {
            type: "error",
            sessionId: sessionId,
            executionId: session.executionId,
            payload: { message: errorMessage(error) },
          })
        )
        .catch(reportAgentPersistenceError)
      return updatedStory
    },
    [
      backlog,
      platform,
      startStoryDevelopmentSession,
      updateStory,
      subscribeStoryAgentEvents,
      persistAgentEvent,
    ]
  )
  return useLatestCallback(
    (
      story: UserStory,
      feedback: string,
      commentId: string,
      codeSelectionAttachments:
        | UserStoryCodeSelectionAttachment[]
        | null
        | undefined,
      fileAttachments: UserStoryFileAttachment[] | null | undefined
    ) =>
      withStoryTransition(story.id, () =>
        sendStoryComment(
          story,
          feedback,
          commentId,
          codeSelectionAttachments,
          fileAttachments
        )
      )
  )
}
