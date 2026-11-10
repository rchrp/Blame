import * as React from "react"
import {
  AlertCircleIcon,
  LayersIcon,
  LightbulbIcon,
  RotateCcwIcon,
  SearchCheckIcon,
  WrenchIcon,
} from "lucide-react"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import {
  pendingFileAttachments,
  replaceFileAttachments,
} from "@/components/backlog/drawer/user-story-attachment-files"
import type {
  CodeSelectionAttachment,
  PendingCodeSelectionAttachment,
} from "@/components/backlog/shared/comment-attachment-events"
import { ExcerptTargetProvider } from "@/components/backlog/shared/selection-excerpt-actions"
import {
  AgentConversationComposer,
  AgentConversationTimeline,
} from "@/components/chat/agent-conversation"
import { agentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import { PlanningConversation } from "@/components/chat/planning-conversation"
import { ProposalHostProvider } from "@/components/chat/proposals/proposal-context"
import { useModelSelection } from "@/components/model/model-selection"
import { ModelSelector } from "@/components/model/model-selector"
import { ConversationPersonalizationMenu } from "@/components/personalization/personalization-menu"
import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { usePlatform } from "@/context/platform"
import { useLatestCallback } from "@/lib/use-latest-callback"
import { cn } from "@/lib/utils"
import { openProjectPath } from "@/pages/chat/quick-chat-helpers"

import { usePlanMode, type PlanMode } from "./use-plan-mode"

const composerInputSelector = "[data-markdown-editor-input='true']"
const suggestions = [
  {
    icon: LayersIcon,
    label: "Break down a feature",
    prompt: "I want to add ",
  },
  {
    icon: WrenchIcon,
    label: "Repair earlier work",
    prompt: "Something is wrong with what we built in US-",
  },
  {
    icon: SearchCheckIcon,
    label: "What should we do next?",
    prompt:
      "Look at the open backlog and the latest finished stories, then suggest what we should build next.",
  },
] as const

/**
 * The backlog's "Plan Mode" button and its conversation. The conversation lives
 * here, not in the dialog, so a reply that arrives while it is closed is
 * kept and flagged on the button.
 */
export function PlanModeLauncher({
  disabled,
  onOpenStory,
}: {
  disabled?: boolean
  onOpenStory: (storyId: string) => void
}) {
  const plan = usePlanMode()
  const [open, setOpen] = React.useState(false)
  const replies = plan.conversation.runs.filter(
    (run) => run.status !== "running"
  ).length
  const [seenReplies, setSeenReplies] = React.useState(replies)
  if (open && seenReplies !== replies) setSeenReplies(replies)
  const unread = !open && replies > seenReplies

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="relative"
      >
        <LightbulbIcon />
        Plan Mode
        {plan.running || unread ? (
          <span
            aria-label={plan.running ? "Planning" : "New reply"}
            className={cn(
              "absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-background",
              plan.running ? "agent-thinking-mark" : "bg-blue-500"
            )}
          />
        ) : null}
      </Button>
      <PlanModeDialog
        open={open}
        onOpenChange={setOpen}
        onOpenStory={(storyId) => {
          setOpen(false)
          onOpenStory(storyId)
        }}
        plan={plan}
      />
    </>
  )
}

function PlanModeDialog({
  onOpenChange,
  onOpenStory,
  open,
  plan,
}: {
  onOpenChange: (open: boolean) => void
  onOpenStory: (storyId: string) => void
  open: boolean
  plan: PlanMode
}) {
  const platform = usePlatform()
  const selection = useModelSelection({ role: "agent" })
  const [draft, setDraft] = React.useState("")
  const [editorKey, setEditorKey] = React.useState(0)
  const editorRef = React.useRef<HTMLDivElement>(null)
  const [codeAttachments, setCodeAttachments] = React.useState<
    PendingCodeSelectionAttachment[]
  >([])
  const [fileAttachments, setFileAttachments] = React.useState<
    UserStoryFileAttachment[]
  >([])
  const { comments, runs } = plan.conversation
  // What proposed stories can carry: every file attached in the thread.
  const conversationFiles = React.useMemo(
    () => comments.flatMap((comment) => comment.fileAttachments ?? []),
    [comments]
  )
  const empty = !runs.length
  const latestRun = runs.at(-1)
  const responseHeader = agentConversationResponseHeader({
    modelId: latestRun?.modelId ?? plan.model?.id,
    providerId: latestRun?.providerId ?? plan.model?.provider.id,
    providers: selection.allProviders,
  })
  const openFile = (path: string) =>
    openProjectPath(plan.projectPath, path, platform.openPath)

  function focusComposer() {
    requestAnimationFrame(() =>
      editorRef.current
        ?.querySelector<HTMLElement>(composerInputSelector)
        ?.focus()
    )
  }

  function applySuggestion(prompt: string) {
    setDraft(prompt)
    setEditorKey((key) => key + 1)
    focusComposer()
  }

  const attachAsContext = useLatestCallback(
    (excerpt: CodeSelectionAttachment) => {
      setCodeAttachments((current) => [
        ...current,
        { ...excerpt, id: crypto.randomUUID() },
      ])
      focusComposer()
    }
  )

  function submit() {
    const attached = codeAttachments.length + fileAttachments.length > 0
    const text =
      draft.trim() || (attached ? "Please take these files into account." : "")
    const sent = plan.send({
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <PlanningConversation
        open={open}
        empty={empty}
        label="Planning conversation"
        title={
          <>
            <LightbulbIcon className="size-4.5 text-muted-foreground" />
            Plan Mode
          </>
        }
        description="Describe what you need. Your agent proposes user stories you review and add to the backlog."
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusComposer()
        }}
        actions={
          !empty ? (
            <Button
              className="border bg-background/90 shadow-sm"
              size="sm"
              type="button"
              variant="outline"
              onClick={plan.reset}
              title="Start a new plan. Stories already added stay in the backlog."
            >
              <RotateCcwIcon />
              New plan
            </Button>
          ) : null
        }
        footer={
          <>
            {plan.unavailableReason ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <AlertCircleIcon className="size-3.5" />
                {plan.unavailableReason}
              </p>
            ) : null}
            <AgentConversationComposer
              agentRunning={plan.running}
              codeSelectionAttachments={codeAttachments}
              disabled={Boolean(plan.unavailableReason)}
              editorKey={editorKey}
              editorRef={editorRef}
              fileAttachments={pendingFileAttachments(fileAttachments)}
              mentionDirectory={plan.projectPath}
              message={draft}
              minHeight={empty ? "min-h-28" : "min-h-16"}
              onAgentCancel={plan.stop}
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
                  ambitionKey={plan.ambitionKey}
                />
              }
              placeholder={
                empty
                  ? "What do you want to build or fix? The more context, the better the stories."
                  : "Answer, refine the stories, or ask for more…"
              }
              speechSessionKey="plan-mode"
              speechTarget={{ draftKey: "plan-mode", label: "your plan" }}
              submitLabel="Send"
              toolbarEnd={<ModelSelector role="agent" />}
            />
          </>
        }
      >
        {empty ? (
          <PlanEmptyState
            onSuggestion={plan.unavailableReason ? undefined : applySuggestion}
          />
        ) : (
          <ExcerptTargetProvider
            attachAsContext={
              plan.unavailableReason ? undefined : attachAsContext
            }
          >
            <ProposalHostProvider
              fileAttachments={conversationFiles}
              onOpenStory={onOpenStory}
            >
              <AgentConversationTimeline
                comments={comments}
                onFileLinkClick={openFile}
                responseHeader={responseHeader}
                runs={runs}
              />
            </ProposalHostProvider>
          </ExcerptTargetProvider>
        )}
      </PlanningConversation>
    </Dialog>
  )
}

function PlanEmptyState({
  onSuggestion,
}: {
  onSuggestion?: (prompt: string) => void
}) {
  return (
    <div className="onboarding-stagger grid place-items-center gap-5 pb-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border bg-muted text-muted-foreground shadow-sm">
        <LightbulbIcon className="size-5" />
      </span>
      <div className="grid max-w-md gap-1.5">
        <h2 className="font-heading text-xl font-semibold">
          What should we build next?
        </h2>
        <p className="text-sm text-muted-foreground">
          Explain the need in your own words. Your agent reads the code and
          earlier stories, asks what it must know, then proposes stories you can
          edit and add in one click.
        </p>
      </div>
      {onSuggestion ? (
        <div className="flex flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              className="group inline-flex h-8 items-center gap-1.5 rounded-full border bg-background/60 px-3 text-xs font-medium text-muted-foreground shadow-xs transition-[transform,color,background-color,box-shadow] duration-200 outline-none hover:-translate-y-0.5 hover:bg-background hover:text-foreground hover:shadow-sm focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:translate-y-0 active:scale-[0.98]"
              onClick={() => onSuggestion(suggestion.prompt)}
            >
              <suggestion.icon className="size-3.5 transition-colors group-hover:text-primary" />
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
