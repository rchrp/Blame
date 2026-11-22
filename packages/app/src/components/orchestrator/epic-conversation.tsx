import * as React from "react"
import type { EpicState } from "@blame/agent-runtime/engine-protocol"
import {
  AlertCircleIcon,
  OctagonPauseIcon,
  TriangleAlertIcon,
} from "lucide-react"

import {
  AgentConversationComposer,
  AgentConversationTimeline,
} from "@/components/chat/agent-conversation"
import { agentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import { ConversationSurface } from "@/components/chat/conversation-surface"
import { ConversationSkeleton } from "@/components/shared/skeletons"
import { useEpicDraft } from "./use-epic-draft"
import { usePlatform } from "@/context/platform"
import { openProjectPath } from "@/pages/chat/quick-chat-helpers"
import { EngineApprovalProvider } from "@/components/chat/engine/engine-approvals"
import type { Epic } from "@/components/orchestrator/data/epic-data"
import { epicProblems } from "@/components/orchestrator/data/epic-problems"
import { openQuestion } from "@/components/orchestrator/data/epic-transcript"
import type { useEpicConversation } from "@/components/orchestrator/data/use-epic-conversation"
import type { EpicBoardGroup } from "./data/epic-board"
import { EpicQuestion } from "./epic-question"
import { EpicTimeline } from "@/components/orchestrator/epic-timeline"
import { ConversationPersonalizationMenu } from "@/components/personalization/personalization-menu"
import { useProjects } from "@/context/projects"
import { epicAmbitionKey } from "@/lib/conversation-ambition"

export function EpicConversation({
  epic,
  chat,
  groups,
  onOpenStory,
}: {
  epic: Epic
  chat: ReturnType<typeof useEpicConversation>
  groups: EpicBoardGroup[]
  onOpenStory: (storyId: string) => void
}) {
  const project = useProjects().activeProject
  const platform = usePlatform()
  const draft = useEpicDraft(epic.projectId, epic.id)
  const [sending, setSending] = React.useState(false)
  const empty =
    !chat.conversation?.runs.length && !chat.conversation?.queued.length
  const question =
    chat.state?.conversation === "asking"
      ? openQuestion(chat.entries)
      : undefined
  const openPath = (path: string) =>
    openProjectPath(project?.path, path, platform.openPath)
  async function send(answer?: string) {
    if (sending || !chat.loaded || chat.unavailableReason) return
    const text =
      answer ?? (draft.message.text || "Please take these files into account.")
    setSending(true)
    try {
      const sent = await chat.send(
        answer ? { text } : { ...draft.message, text }
      )
      if (sent && !answer) draft.clear()
    } finally {
      setSending(false)
    }
  }
  return (
    <EngineApprovalProvider session={chat.session}>
      <section
        aria-label="Conversation with the orchestrator"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [--work-completed-color:var(--muted-foreground)]"
      >
        <ConversationSurface
          conversationId={`epic:${epic.id}`}
          running={chat.running}
          composer={
            <AgentConversationComposer
              {...draft.composer}
              agentRunning={chat.running}
              disabled={Boolean(chat.unavailableReason) || !chat.loaded}
              submitting={sending}
              mentionDirectory={project?.path}
              queueWhileRunning
              onAgentCancel={chat.stop}
              onFileLinkClick={openPath}
              onMessageSubmit={() => void send()}
              personalizationMenu={
                <ConversationPersonalizationMenu
                  ambitionKey={epicAmbitionKey(epic.id)}
                />
              }
              placeholder={composerPlaceholder(
                chat.state,
                Boolean(question),
                empty,
                epic
              )}
              submitLabel={chat.running ? "Send when it finishes" : "Send"}
            />
          }
        >
          {!chat.loaded && !chat.unavailableReason ? (
            <ConversationSkeleton />
          ) : empty && epic.goal ? (
            <AgentConversationTimeline
              comments={[]}
              runs={[]}
              unsentComments={[
                {
                  id: epic.id,
                  author: "You",
                  body: epic.goal,
                  createdAt: epic.createdAt,
                },
              ]}
              responseHeader={agentConversationResponseHeader({
                providers: [],
                fallbackName: "Orchestrator",
              })}
            />
          ) : (
            <EpicTimeline
              chat={chat}
              epic={epic}
              groups={groups}
              openQuestionKey={question?.key}
              onFileLinkClick={openPath}
              onOpenStory={onOpenStory}
            />
          )}
          <ConversationNotice state={chat.state} />
          {chat.error || chat.unavailableReason ? (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <AlertCircleIcon className="size-4 shrink-0" />{" "}
              {chat.error ?? chat.unavailableReason}
            </p>
          ) : null}
          {question && (
            <EpicQuestion
              question={question}
              disabled={sending || !!chat.unavailableReason || !chat.loaded}
              onAnswer={(answer) => void send(answer)}
              editorRef={draft.composer.editorRef}
            />
          )}
        </ConversationSurface>
      </section>
    </EngineApprovalProvider>
  )
}

function composerPlaceholder(
  state: EpicState | undefined,
  asked: boolean,
  empty: boolean,
  epic: Epic
) {
  if (asked) return "Answer the orchestrator's question"
  if (state?.conversation === "finished")
    return "Ask for more, or review the epic's branch"
  if (!empty) return "Message the orchestrator"
  return epic.goal
    ? "Anything else the orchestrator should know?"
    : "Describe what the epic should achieve"
}

// Why the orchestrator does nothing now, and what the person can do: every
// problem of the epic's own, then a conversation stopped.
function ConversationNotice({ state }: { state: EpicState | undefined }) {
  const problems = epicProblems(state)
  return (
    <>
      {problems.map((problem) => (
        <div
          key={`${problem.kind}:${problem.message}`}
          className="flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          role="alert"
        >
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
          <span className="grid gap-0.5">
            <span className="break-words">{problem.message}</span>
            <span className="text-foreground/80">{problem.action}</span>
          </span>
        </div>
      ))}
      {state?.conversation === "stopped" ? (
        <p className="flex items-start gap-2 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">
          <OctagonPauseIcon className="mt-px size-3.5 shrink-0" />
          <span>
            The orchestrator has stopped. Send a message to resume the
            conversation. Its stories can keep running.
          </span>
        </p>
      ) : null}
    </>
  )
}
