import * as React from "react"
import {
  AlertCircleIcon,
  GitMergeIcon,
  ListChecksIcon,
  SparklesIcon,
} from "lucide-react"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import {
  pendingFileAttachments,
  replaceFileAttachments,
} from "@/components/backlog/drawer/user-story-attachment-files"
import type { PendingCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import {
  AgentConversationComposer,
  AgentConversationTimeline,
} from "@/components/chat/agent-conversation"
import { agentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import { EngineApprovalProvider } from "@/components/chat/engine/engine-approvals"
import type { Epic } from "@/components/orchestrator/data/epic-data"
import { useEpicConversation } from "@/components/orchestrator/data/use-epic-conversation"
import { useEpicModels } from "@/components/orchestrator/data/use-epic-models"
import { useProjects } from "@/context/projects"

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

// The conversation with the epic's orchestrator. Its one input is the epic:
// everything else (the engine session, the transcript, sending) comes from
// useEpicConversation.
export function EpicConversation({ epic }: { epic: Epic }) {
  const project = useProjects().activeProject
  const chat = useEpicConversation(epic)
  const models = useEpicModels()
  const [draft, setDraft] = React.useState("")
  const [editorKey, setEditorKey] = React.useState(0)
  const editorRef = React.useRef<HTMLDivElement>(null)
  const [codeAttachments, setCodeAttachments] = React.useState<
    PendingCodeSelectionAttachment[]
  >([])
  const [fileAttachments, setFileAttachments] = React.useState<
    UserStoryFileAttachment[]
  >([])
  const { comments, runs } = chat.conversation
  const empty = !runs.length
  const latestRun = runs.at(-1)
  const responseHeader = agentConversationResponseHeader({
    modelId: latestRun?.modelId ?? epic.settings.orchestratorModel?.modelId,
    providerId:
      latestRun?.providerId ?? epic.settings.orchestratorModel?.providerId,
    providers: models.allProviders,
  })

  function submit() {
    const attached = codeAttachments.length + fileAttachments.length > 0
    const text =
      draft.trim() || (attached ? "Please take these files into account." : "")
    if (!text) return
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

  return (
    <EngineApprovalProvider session={chat.session}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-4">
          {epic.goal ? <EpicGoal goal={epic.goal} /> : null}
          {empty ? (
            <EpicConversationIntro />
          ) : (
            <AgentConversationTimeline
              comments={comments}
              responseHeader={responseHeader}
              runs={runs}
            />
          )}
        </div>
        <div className="grid shrink-0 gap-2">
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
            placeholder={
              empty
                ? "Describe what the epic should achieve"
                : "Answer the orchestrator, or steer it"
            }
            speechSessionKey={`epic:${epic.id}`}
            speechTarget={{
              draftKey: `epic:${epic.id}`,
              label: "your message to the orchestrator",
            }}
            submitLabel="Send"
          />
        </div>
      </div>
    </EngineApprovalProvider>
  )
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
