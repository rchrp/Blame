import * as React from "react"
import type { EpicState } from "@blame/agent-runtime/engine-protocol"
import {
  AlertCircleIcon,
  GitMergeIcon,
  ListChecksIcon,
  OctagonPauseIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import {
  pendingFileAttachments,
  replaceFileAttachments,
} from "@/components/backlog/drawer/user-story-attachment-files"
import type { PendingCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import { AgentConversationComposer } from "@/components/chat/agent-conversation"
import { EngineApprovalProvider } from "@/components/chat/engine/engine-approvals"
import type { Epic } from "@/components/orchestrator/data/epic-data"
import { openQuestion } from "@/components/orchestrator/data/epic-transcript"
import { useEpicConversation } from "@/components/orchestrator/data/use-epic-conversation"
import { useEpicStories } from "@/components/orchestrator/data/use-epic-board"
import { EpicTimeline } from "@/components/orchestrator/epic-timeline"
import { ConversationPersonalizationMenu } from "@/components/personalization/personalization-menu"
import { useProjects } from "@/context/projects"
import { epicAmbitionKey } from "@/lib/conversation-ambition"

const steps = [
  {
    icon: ListChecksIcon,
    text: "Splits the goal into user stories and starts an agent on each, with a model it picks inside your range.",
  },
  {
    icon: SparklesIcon,
    text: "Reads each result: merges it, asks for changes, or rejects it. A story whose checks failed is never merged.",
  },
  {
    icon: GitMergeIcon,
    text: "Merges into the epic's branch only. Your branch moves when you approve the epic.",
  },
] as const

// The conversation with the epic's orchestrator. Its input is the epic (and
// where a story opens): the session, the transcript and sending come from
// useEpicConversation.
export function EpicConversation({
  epic,
  onOpenStory,
}: {
  epic: Epic
  onOpenStory: (storyId: string) => void
}) {
  const project = useProjects().activeProject
  const chat = useEpicConversation(epic)
  const stories = useEpicStories()
  const [draft, setDraft] = React.useState("")
  const [editorKey, setEditorKey] = React.useState(0)
  const editorRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [codeAttachments, setCodeAttachments] = React.useState<
    PendingCodeSelectionAttachment[]
  >([])
  const [fileAttachments, setFileAttachments] = React.useState<
    UserStoryFileAttachment[]
  >([])
  const entries = chat.entries
  const empty = !entries.length
  const question =
    chat.state?.conversation === "asking" ? openQuestion(entries) : undefined

  // The latest of the conversation stays in view as it grows.
  const lastKey = entries.at(-1)?.key
  React.useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [entries.length, lastKey])

  function sendText(text: string) {
    const sent = chat.send({
      text,
      codeSelectionAttachments: codeAttachments,
      fileAttachments,
    })
    if (!sent) return
    setDraft("")
    setCodeAttachments([])
    setFileAttachments([])
    setEditorKey((key) => key + 1)
  }

  function submit() {
    const attached = codeAttachments.length + fileAttachments.length > 0
    const text =
      draft.trim() || (attached ? "Please take these files into account." : "")
    if (text) sendText(text)
  }

  return (
    <EngineApprovalProvider session={chat.session}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-4"
        >
          {epic.goal ? <EpicGoal goal={epic.goal} /> : null}
          {empty ? (
            <EpicConversationIntro />
          ) : (
            <EpicTimeline
              entries={entries}
              epic={epic}
              openQuestionKey={question?.key}
              stories={stories}
              onAnswer={sendText}
              onOpenStory={onOpenStory}
            />
          )}
        </div>
        <div className="grid shrink-0 gap-2">
          <ConversationNotice state={chat.state} />
          {chat.unavailableReason ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <AlertCircleIcon className="size-3.5 shrink-0" />
              {chat.unavailableReason}
            </p>
          ) : null}
          <AgentConversationComposer
            agentRunning={chat.running}
            codeSelectionAttachments={codeAttachments}
            disabled={Boolean(chat.unavailableReason)}
            editorKey={editorKey}
            editorRef={editorRef}
            fileAttachments={pendingFileAttachments(fileAttachments)}
            mentionDirectory={project?.path}
            message={draft}
            minHeight="min-h-16"
            queueWhileRunning
            onAgentCancel={chat.stop}
            onCodeSelectionAttachmentRemove={(id) =>
              setCodeAttachments((current) =>
                current.filter((attachment) => attachment.id !== id)
              )
            }
            onFileAttachmentRemove={(id) =>
              setFileAttachments((current) =>
                current.filter((attachment) => attachment.id !== id)
              )
            }
            onFileAttachmentsReplace={(replacements) =>
              setFileAttachments((current) =>
                replaceFileAttachments(current, replacements)
              )
            }
            onFileAttachmentsAdd={(attachments) =>
              setFileAttachments((current) => [...current, ...attachments])
            }
            onMessageChange={setDraft}
            onMessageSubmit={submit}
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
            speechSessionKey={`epic:${epic.id}`}
            speechTarget={{
              draftKey: `epic:${epic.id}`,
              label: "your message to the orchestrator",
            }}
            submitLabel={chat.running ? "Send when it finishes" : "Send"}
          />
        </div>
      </div>
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

// Why the orchestrator does nothing now, and what the person can do.
function ConversationNotice({ state }: { state: EpicState | undefined }) {
  if (state?.conversation === "failed")
    return (
      <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
        <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
        <span>
          The orchestrator stopped on an error
          {state.error ? `: ${state.error}` : ""}. Write to it to let it try
          again, or change its model in the epic&rsquo;s settings.
        </span>
      </p>
    )
  if (state?.conversation === "stopped")
    return (
      <p className="flex items-start gap-2 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">
        <OctagonPauseIcon className="mt-px size-3.5 shrink-0" />
        <span>
          You stopped the orchestrator. It is not woken until you write to it;
          its stories go on.
        </span>
      </p>
    )
  if (state?.error)
    return (
      <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
        <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
        <span>{state.error}</span>
      </p>
    )
  return null
}

function EpicGoal({ goal }: { goal: string }) {
  return (
    <section className="mb-4 grid gap-1 rounded-lg border bg-muted/40 p-3">
      <h3 className="text-xs font-medium text-muted-foreground">Goal</h3>
      <p className="text-sm break-words whitespace-pre-wrap">{goal}</p>
    </section>
  )
}

function EpicConversationIntro() {
  return (
    <div className="grid gap-3 py-2">
      <p className="text-sm text-muted-foreground">
        Talk to the orchestrator here. It answers, asks what it must know, and
        tells you what it decided on each story.
      </p>
      <ul className="grid gap-2.5">
        {steps.map((step) => (
          <li key={step.text} className="flex gap-2.5 text-sm">
            <step.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>{step.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
