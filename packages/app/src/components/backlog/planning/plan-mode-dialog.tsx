import * as React from "react"
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  HistoryIcon,
  LayersIcon,
  LightbulbIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchCheckIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react"

import { MarkdownPreview } from "@/components/backlog/drawer/markdown-preview"
import { pendingFileAttachments } from "@/components/backlog/drawer/user-story-attachment-files"
import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import type { PendingCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import { AgentConversationComposer } from "@/components/chat/agent-conversation"
import { ModelSelector } from "@/components/model/model-selector"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { cn } from "@/lib/utils"

import {
  addedStoryRefs,
  latestProposalId,
  missingDependencies,
  pendingStories,
  planAttachmentContext,
  type PlanMessage,
} from "./plan-mode-data"
import { PlanStoryCarousel } from "./plan-story-carousel"
import { usePlanMode, type PlanMode, type PlanPending } from "./use-plan-mode"

const composerInputSelector = "[data-markdown-editor-input='true']"
const headerSoftBlurMask = {
  maskImage:
    "linear-gradient(to bottom, black 0%, black 60%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to bottom, black 0%, black 60%, transparent 100%)",
} satisfies React.CSSProperties
const headerStrongBlurMask = {
  maskImage: "linear-gradient(to bottom, black 0%, transparent 72%)",
  WebkitMaskImage: "linear-gradient(to bottom, black 0%, transparent 72%)",
} satisfies React.CSSProperties
const footerBlurMask = {
  maskImage: "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
} satisfies React.CSSProperties

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
 * The backlog's "Plan" button and its conversation. The conversation lives
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
  const messageCount = plan.thread.messages.length
  const [seenCount, setSeenCount] = React.useState(messageCount)
  if (open && seenCount !== messageCount) setSeenCount(messageCount)
  const unread = !open && messageCount > seenCount

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="relative"
      >
        <LightbulbIcon />
        Plan
        {plan.pending || unread ? (
          <span
            aria-label={plan.pending ? "Planning" : "New proposal"}
            className={cn(
              "absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-background",
              plan.pending ? "agent-thinking-mark" : "bg-blue-500"
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
  const [draft, setDraft] = React.useState("")
  const [editorKey, setEditorKey] = React.useState(0)
  const editorRef = React.useRef<HTMLDivElement>(null)
  const [codeAttachments, setCodeAttachments] = React.useState<
    PendingCodeSelectionAttachment[]
  >([])
  const [fileAttachments, setFileAttachments] = React.useState<
    UserStoryFileAttachment[]
  >([])
  const footerRef = React.useRef<HTMLElement>(null)
  const footerHeight = useElementHeight(footerRef, open)
  const messages = plan.thread.messages
  const empty = !messages.length
  const latestProposal = latestProposalId(messages)

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

  function submit() {
    const extra = planAttachmentContext(codeAttachments, fileAttachments)
    const text =
      draft.trim() ||
      (extra.context ? "Please take these files into account." : "")
    if (!text || !plan.send(text, extra)) return
    setDraft("")
    setCodeAttachments([])
    setFileAttachments([])
    setEditorKey((key) => key + 1)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="block h-[min(54rem,calc(100svh-3rem))] overflow-hidden p-0 sm:max-w-3xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusComposer()
        }}
      >
        <MessageScrollerProvider>
          <MessageScroller className="h-full">
            <MessageScrollerViewport aria-label="Planning conversation">
              <MessageScrollerContent
                className={cn(
                  "mx-auto grid w-full max-w-2xl gap-6 px-6 pt-24",
                  empty ? "content-center" : "content-start"
                )}
                style={{ paddingBottom: footerHeight + 24 }}
              >
                {empty ? (
                  <PlanEmptyState
                    onSuggestion={
                      plan.unavailableReason ? undefined : applySuggestion
                    }
                  />
                ) : null}
                {messages.map((message) =>
                  message.role === "user" ? (
                    <UserMessage
                      key={message.id}
                      message={message}
                      onRetry={
                        message.failed && !plan.pending
                          ? () => plan.retry(message.id)
                          : undefined
                      }
                    />
                  ) : (
                    <AssistantMessage
                      key={message.id}
                      latest={message.id === latestProposal}
                      message={message}
                      onOpenStory={onOpenStory}
                      plan={plan}
                    />
                  )
                )}
                {plan.pending ? (
                  <PlanningIndicator pending={plan.pending} />
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton
              className="right-6 z-30"
              style={{ bottom: footerHeight + 16 }}
            />
          </MessageScroller>
        </MessageScrollerProvider>
        {/* Header and composer float over the conversation, which fades
            under them the way it does in the story drawer. */}
        <header className="absolute inset-x-0 top-0 isolate z-20 flex items-center gap-3 px-6 pt-5 pb-8">
          <div
            className="absolute inset-0 -z-10 bg-popover/20 backdrop-blur-sm"
            style={headerSoftBlurMask}
          />
          <div
            className="absolute inset-0 -z-10 bg-popover/20 backdrop-blur-2xl backdrop-saturate-150"
            style={headerStrongBlurMask}
          />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <DialogTitle className="flex items-center gap-2 font-heading text-xl leading-tight font-semibold">
              <LightbulbIcon className="size-4.5 text-muted-foreground" />
              Plan mode
            </DialogTitle>
            <DialogDescription className="truncate text-xs">
              Describe what you need. Your agent proposes user stories you
              review and add to the backlog.
            </DialogDescription>
          </div>
          {!empty ? (
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
          ) : null}
          <DialogClose asChild>
            <Button
              className="border bg-background/90 shadow-sm"
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
        </header>
        <footer
          ref={footerRef}
          className="absolute inset-x-0 bottom-0 z-20 px-6 pt-6 pb-5"
        >
          <div
            className="pointer-events-none absolute inset-0 bg-background/40 backdrop-blur-xl"
            style={footerBlurMask}
          />
          <div className="relative mx-auto grid w-full max-w-2xl gap-2">
            {plan.unavailableReason ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <AlertCircleIcon className="size-3.5" />
                {plan.unavailableReason}
              </p>
            ) : null}
            <AgentConversationComposer
              agentRunning={Boolean(plan.pending)}
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
              onFileAttachmentsAdd={(attachments) =>
                setFileAttachments((current) => [...current, ...attachments])
              }
              onMessageChange={setDraft}
              onMessageSubmit={submit}
              placeholder={
                empty
                  ? "What do you want to build or fix? The more context, the better the stories."
                  : "Answer, refine the stories, or ask for more…"
              }
              speechSessionKey="plan-mode"
              speechTarget={{ draftKey: "plan-mode", label: "your plan" }}
              submitLabel="Send"
              toolbarEnd={
                <div className="w-[22rem] max-w-full min-w-0">
                  <ModelSelector role="agent" />
                </div>
              }
            />
          </div>
        </footer>
      </DialogContent>
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

function UserMessage({
  message,
  onRetry,
}: {
  message: PlanMessage
  onRetry?: () => void
}) {
  return (
    <div className="chat-enter-user grid justify-items-end gap-1.5">
      <div
        className={cn(
          "max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2.5 text-sm whitespace-pre-wrap",
          message.failed && "opacity-70"
        )}
      >
        {message.text}
      </div>
      {message.attachments?.length ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
          {message.attachments.map((name) => (
            <span
              key={name}
              className="inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] text-muted-foreground"
            >
              <PaperclipIcon className="size-3" />
              {name}
            </span>
          ))}
        </div>
      ) : null}
      {message.failed ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircleIcon className="size-3.5 text-destructive" />
          <span className="max-w-md truncate" title={message.error}>
            {message.error ?? "The agent did not answer."}
          </span>
          {onRetry ? (
            <Button size="xs" type="button" variant="outline" onClick={onRetry}>
              <RotateCcwIcon />
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function AssistantMessage({
  latest,
  message,
  onOpenStory,
  plan,
}: {
  latest: boolean
  message: PlanMessage
  onOpenStory: (storyId: string) => void
  plan: PlanMode
}) {
  const stories = message.stories ?? []
  const [showEarlier, setShowEarlier] = React.useState(false)
  const pending = pendingStories(stories)
  const added = stories.filter((story) => story.addedAs).length
  const addingAll = pending.some((story) =>
    plan.adding.has(`${message.id}:${story.key}`)
  )
  const expanded = latest || showEarlier
  const earlierAdds = addedStoryRefs(plan.thread.messages)
  const dependencyLabel = (key: string) =>
    stories.find((story) => story.key === key)?.addedAs ??
    earlierAdds.get(key)?.displayId ??
    key

  return (
    <div className="chat-enter-agent flex gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
        <LightbulbIcon className="size-3.5" />
      </span>
      <div className="grid min-w-0 flex-1 gap-3">
        <MarkdownPreview
          className="text-sm"
          markdown={message.text}
          placeholder=""
        />
        {stories.length ? (
          <section className="grid gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={latest}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground outline-none enabled:hover:text-foreground"
                onClick={() => setShowEarlier((value) => !value)}
              >
                {!latest ? (
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 transition-transform",
                      showEarlier && "rotate-90"
                    )}
                  />
                ) : null}
                {latest ? "Proposed stories" : "Earlier proposal"} ·{" "}
                {stories.length}
                {added ? ` · ${added} added` : ""}
              </button>
              {expanded && pending.length > 1 ? (
                <Button
                  className="ml-auto"
                  disabled={addingAll}
                  size="sm"
                  type="button"
                  onClick={() =>
                    void plan.addStories(
                      message.id,
                      pending.map((story) => story.key)
                    )
                  }
                >
                  {addingAll ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : (
                    <PlusIcon />
                  )}
                  Add all {pending.length}
                </Button>
              ) : null}
            </div>
            {expanded ? (
              <PlanStoryCarousel
                stories={stories}
                actionsFor={(story) => ({
                  adding: plan.adding.has(`${message.id}:${story.key}`),
                  dependencyLabel,
                  missingDependencies: missingDependencies(stories, story.key),
                  onAdd: () => void plan.addStories(message.id, [story.key]),
                  onDismiss: (dismissed) =>
                    plan.dismiss(message.id, story.key, dismissed),
                  onEdit: (patch) => plan.edit(message.id, story.key, patch),
                  onOpen:
                    story.addedStoryId &&
                    plan.stories.some((item) => item.id === story.addedStoryId)
                      ? () => onOpenStory(story.addedStoryId!)
                      : undefined,
                })}
              />
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  )
}

function PlanningIndicator({ pending }: { pending: PlanPending }) {
  return (
    <div className="chat-enter-agent flex gap-3" role="status">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted">
        <span className="agent-thinking-mark" aria-hidden="true" />
      </span>
      <div className="grid min-w-0 gap-1.5 pt-1">
        <span className="agent-thinking-text text-sm">
          {pending.steps.length ? "Exploring the project" : "Thinking"}
        </span>
        {pending.steps.map((step) => (
          <span
            key={step.id}
            className="chat-enter-step flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
          >
            {step.running ? (
              <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
            ) : step.label.toLowerCase().includes("stor") ? (
              <HistoryIcon className="size-3 shrink-0" />
            ) : (
              <CheckIcon className="size-3 shrink-0" />
            )}
            <span
              className={cn(
                "truncate",
                step.running && "agent-activity-running"
              )}
            >
              {step.label}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

// The floating composer's height, so the conversation can scroll clear of it.
function useElementHeight(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean
) {
  const [height, setHeight] = React.useState(160)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element || !active) return
    const update = () => {
      const next = Math.ceil(element.getBoundingClientRect().height)
      setHeight((current) => (current === next ? current : next))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active, ref])
  return height
}
