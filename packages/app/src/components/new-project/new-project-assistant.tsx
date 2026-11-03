import * as React from "react"
import { ArrowLeftIcon, LightbulbIcon } from "lucide-react"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import {
  pendingFileAttachments,
  replaceFileAttachments,
} from "@/components/backlog/drawer/user-story-attachment-files"
import {
  AgentConversationComposer,
  AgentConversationTimeline,
} from "@/components/chat/agent-conversation"
import { agentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import { PlanningConversation } from "@/components/chat/planning-conversation"
import {
  ProposalHostProvider,
  type ProposalCardProps,
} from "@/components/chat/proposals/proposal-context"
import { projectStackProposalToolName } from "@/components/chat/proposals/proposal-tools"
import { ModelSelector } from "@/components/model/model-selector"
import { Button } from "@/components/ui/button"

import { NewProjectSummary } from "./new-project-summary"
import { stackProposal } from "./use-new-project-planning"
import type { NewProjectWizard } from "./use-new-project-wizard"

// The stack a turn proposed, shown in the thread as the wizard's summary.
const stackCards = {
  [projectStackProposalToolName]: function ProposedStack({
    activity,
  }: ProposalCardProps) {
    const configuration = stackProposal(activity.detail)
    return configuration ? (
      <section aria-label="Proposed stack">
        <NewProjectSummary configuration={configuration} />
      </section>
    ) : null
  },
}

export function NewProjectAssistant({ wizard }: { wizard: NewProjectWizard }) {
  const plan = wizard.planning
  const [files, setFiles] = React.useState<UserStoryFileAttachment[]>([])
  const [draft, setDraft] = React.useState("")
  const [editorKey, setEditorKey] = React.useState(0)
  const editorRef = React.useRef<HTMLDivElement>(null)
  const { comments, runs } = plan.conversation
  const empty = runs.length === 0
  const latestRun = runs.at(-1)
  const responseHeader = agentConversationResponseHeader({
    modelId: latestRun?.modelId ?? wizard.planningSelection.currentModel?.id,
    providerId:
      latestRun?.providerId ??
      wizard.planningSelection.currentModel?.provider.id,
    providers: wizard.planningSelection.allProviders,
  })
  function focusComposer() {
    requestAnimationFrame(() =>
      editorRef.current
        ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
        ?.focus()
    )
  }
  function submit() {
    const text =
      draft.trim() ||
      (files.length ? "Please take these files into account." : "")
    if (!plan.send({ text, fileAttachments: files })) return
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
                <ModelSelector role="agent" />
              </div>
            }
          />
        </>
      }
    >
      {empty ? (
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
      ) : (
        <ProposalHostProvider cards={stackCards}>
          <AgentConversationTimeline
            comments={comments}
            responseHeader={responseHeader}
            runs={runs}
          />
        </ProposalHostProvider>
      )}
    </PlanningConversation>
  )
}
