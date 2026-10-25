import { replaceFileAttachments } from "@/components/backlog/drawer/user-story-attachment-files"
import * as React from "react"
import { ArrowLeftIcon, LightbulbIcon, RotateCcwIcon } from "lucide-react"
import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import { pendingFileAttachments } from "@/components/backlog/drawer/user-story-attachment-files"
import { planAttachmentContext } from "@/components/backlog/planning/plan-mode-data"
import { MarkdownPreview } from "@/components/backlog/drawer/markdown-preview"
import { AgentConversationComposer } from "@/components/chat/agent-conversation"
import { PlanningConversation } from "@/components/chat/planning-conversation"
import { ModelSelector } from "@/components/model/model-selector"
import { Button } from "@/components/ui/button"
import type { NewProjectWizard } from "./use-new-project-wizard"
import { NewProjectSummary } from "./new-project-summary"

export function NewProjectAssistant({ wizard }: { wizard: NewProjectWizard }) {
  const plan = wizard.planning
  const [files, setFiles] = React.useState<UserStoryFileAttachment[]>([])
  const [draft, setDraft] = React.useState("")
  const [editorKey, setEditorKey] = React.useState(0)
  const editorRef = React.useRef<HTMLDivElement>(null)
  const empty = plan.messages.length === 0
  function focusComposer() {
    requestAnimationFrame(() =>
      editorRef.current
        ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
        ?.focus()
    )
  }
  function submit() {
    const extra = planAttachmentContext([], files)
    const text =
      draft.trim() ||
      (extra.context ? "Please take these files into account." : "")
    if (!plan.send(text, extra)) return
    setFiles([])
    setDraft("")
    setEditorKey((key) => key + 1)
    focusComposer()
  }
  return (
    <PlanningConversation
      open
      empty={empty}
      label="Project planning conversation"
      title={
        <>
          <LightbulbIcon className="size-4.5 text-muted-foreground" />
          Plan your project
        </>
      }
      description={`Choose the stack for ${wizard.projectName}.`}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        focusComposer()
      }}
      onInteractOutside={(event) => event.preventDefault()}
      actions={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={wizard.goBack}
        >
          <ArrowLeftIcon />
          Back
        </Button>
      }
      footer={
        <>
          {plan.unavailableReason && (
            <p role="status" className="text-xs text-muted-foreground">
              {plan.unavailableReason}
            </p>
          )}
          {plan.proposal && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Your stack is ready. Refine it or continue to review.
              </p>
              <Button type="button" size="sm" onClick={wizard.goNext}>
                Review stack
              </Button>
            </div>
          )}
          <AgentConversationComposer
            agentRunning={plan.pending}
            fileAttachments={pendingFileAttachments(files)}
            onFileAttachmentsReplace={(replacements) =>
              setFiles((current) =>
                replaceFileAttachments(current, replacements)
              )
            }
            onFileAttachmentsAdd={(next) =>
              setFiles((current) => [...current, ...next])
            }
            onFileAttachmentRemove={(id) =>
              setFiles((current) => current.filter((file) => file.id !== id))
            }
            disabled={Boolean(plan.unavailableReason)}
            editorKey={editorKey}
            editorRef={editorRef}
            message={draft}
            minHeight={empty ? "min-h-28" : "min-h-16"}
            onAgentCancel={plan.stop}
            onMessageChange={setDraft}
            onMessageSubmit={submit}
            placeholder={
              empty
                ? "What do you want to build, and who is it for?"
                : "Answer a question or refine your stack…"
            }
            speechSessionKey="new-project-planning"
            speechTarget={{
              draftKey: "new-project-planning",
              label: "your project",
            }}
            submitLabel="Send"
            toolbarEnd={
              <div className="w-44 max-w-full min-w-0 sm:w-[22rem]">
                <ModelSelector role="alternative" />
              </div>
            }
          />
        </>
      }
    >
      {empty && (
        <div className="grid place-items-center gap-3 pb-8 text-center">
          <LightbulbIcon className="size-7 text-muted-foreground" />
          <div className="grid max-w-md gap-2">
            <h2 className="font-heading text-xl font-semibold">
              What do you want to build?
            </h2>
            <p className="text-sm text-muted-foreground">
              Describe your idea, who will use it, and what it needs to do. Your
              agent will clarify the details and choose a stack from Blame’s
              supported options.
            </p>
          </div>
        </div>
      )}
      {plan.messages.map((message) =>
        message.role === "user" ? (
          <div
            key={message.id}
            className="chat-enter-user grid justify-items-end gap-2"
          >
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2.5 text-sm break-words whitespace-pre-wrap">
              {message.text}
            </div>
            {message.attachments?.length ? (
              <p className="max-w-[85%] text-xs break-words text-muted-foreground">
                {message.attachments.join(", ")}
              </p>
            ) : null}
            {message.error && (
              <div
                role="alert"
                className="grid justify-items-end gap-2 text-sm text-destructive"
              >
                <p className="break-words">{message.error}</p>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={plan.pending || Boolean(plan.unavailableReason)}
                  onClick={() => plan.retry(message.id)}
                >
                  <RotateCcwIcon />
                  Retry
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div key={message.id} className="chat-enter-agent flex gap-3">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
              <LightbulbIcon className="size-3.5" />
            </span>
            <div className="grid min-w-0 flex-1 gap-3">
              <MarkdownPreview
                className="text-sm"
                markdown={message.text}
                placeholder=""
              />
              {message.configuration && (
                <section aria-label="Proposed stack">
                  <NewProjectSummary configuration={message.configuration} />
                </section>
              )}
            </div>
          </div>
        )
      )}
      {plan.pending && (
        <div
          role="status"
          className="flex items-center gap-3 text-sm text-muted-foreground"
        >
          <span className="agent-thinking-mark" aria-hidden="true" />
          Choosing the right stack for your project…
        </div>
      )}
    </PlanningConversation>
  )
}
