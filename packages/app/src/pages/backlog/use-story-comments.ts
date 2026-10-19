import * as React from "react"
import type { AgentEvent } from "@blame/agent-runtime"
import { toast } from "sonner"

import type {
  UserStory,
  UserStoryAgentRun,
  UserStoryCodeSelectionAttachment,
  UserStoryComment,
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
import {
  dropQueuedComments,
  onQueuedDeliveryRequest,
  storiesWithQueuedComments,
  takeQueuedComments,
} from "./comment-queue"
import { finalizeStoppedRun } from "./story-agent-control"
import { storiesInTransition, withStoryTransition } from "./story-transitions"

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
      const interrupting =
        story.status === "in-progress" && story.agentStatus !== "Paused"
      // Sent mid-task: the agent reads it, then picks the task back up.
      const agentFeedback = interrupting
        ? `${feedback}\n\n(This message arrived while you were working. Take it into account, then continue the task where you left off.)`
        : feedback
      try {
        if (interrupting) {
          // Wait for the current execution to stop before starting the feedback turn.
          // A failed stop must preserve the saved comment and composer draft.
          await agent.sessions.abort(story.clineSessionId)
          await finalizeStoppedRun(backlog, story, "Interrupted by your comment.")
        }
        session = await startStoryDevelopmentSession(story, {
          feedback: agentFeedback,
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
          feedback: agentFeedback,
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

// Delivers comments queued while an agent was working: all together when
// it finishes its turn, or at once when the person picks "Send now".
export function useQueuedCommentDelivery({
  createComment,
  requestChanges,
  stories,
}: {
  createComment(
    story: UserStory,
    input: Pick<
      UserStoryComment,
      "body" | "codeSelectionAttachments" | "fileAttachments"
    >
  ): Promise<UserStoryComment>
  requestChanges(
    story: UserStory,
    feedback: string,
    commentId: string,
    codeSelectionAttachments: UserStoryCodeSelectionAttachment[] | null | undefined,
    fileAttachments: UserStoryFileAttachment[] | null | undefined
  ): Promise<UserStory | undefined>
  stories: readonly UserStory[]
}) {
  const deliver = useLatestCallback(async (storyId: string, now: boolean) => {
    const story = stories.find((item) => item.id === storyId)
    if (!story) return
    if (storiesInTransition().has(storyId)) {
      if (now)
        toast.info("The agent is busy for a moment", {
          description: "Your comment stays queued; try again in a few seconds.",
          position: "bottom-right",
        })
      return
    }
    const merged = takeQueuedComments(storyId)
    if (!merged) return
    try {
      const created = await createComment(story, merged)
      const sent = await requestChanges(
        story,
        merged.body,
        created.id,
        created.codeSelectionAttachments,
        created.fileAttachments
      )
      if (!sent)
        toast.error("Your queued comment was saved but not sent", {
          description: "Send it again from the story when the agent is ready.",
          position: "bottom-right",
        })
    } catch (error) {
      toast.error("Couldn't send your queued comment", {
        description: errorMessage(error),
        position: "bottom-right",
      })
    }
  })

  // The agent finished its turn: send what was waiting. Stories that can no
  // longer take comments drop their queue.
  React.useEffect(() => {
    for (const storyId of storiesWithQueuedComments()) {
      const story = stories.find((item) => item.id === storyId)
      if (!story) continue
      if (["backlog", "ready", "done", "discarded"].includes(story.status)) {
        dropQueuedComments(storyId)
        continue
      }
      if (story.status === "in-review") void deliver(storyId, false)
    }
  }, [deliver, stories])

  React.useEffect(
    () => onQueuedDeliveryRequest((storyId) => void deliver(storyId, true)),
    [deliver]
  )
}
