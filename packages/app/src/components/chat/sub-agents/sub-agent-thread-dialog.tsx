import * as React from "react"

import type { UserStoryAgentActivity } from "@/components/backlog/data/backlog-data"
import { MarkdownMessage } from "@/components/backlog/drawer/markdown-editor"
import { useEngineLocation } from "@/components/chat/engine/engine-approvals"
import { transcriptConversation } from "@/components/chat/engine/transcript-conversation"
import { useEngineSession } from "@/components/chat/engine/use-engine-session"
import { Accordion } from "@/components/ui/accordion"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToolCallItem } from "../tool-calls/tool-call-item"
import {
  formatDuration,
  formatTokens,
  roleLabels,
  statusLabels,
  threadTokens,
  type SubAgentRow,
} from "./sub-agents-view"

// One helper's own conversation: what the lead asked, what it reported, and
// the steps in between. Its records are its session's; they are read here,
// while the dialog is open, and never join the lead's conversation.
export function SubAgentThreadDialog({
  onFileLinkClick,
  onOpenChange,
  row,
}: {
  onFileLinkClick?: (path: string) => void
  onOpenChange(open: boolean): void
  row: SubAgentRow
}) {
  const location = useEngineLocation()
  const view = useEngineSession(row.session, location)
  const thread = view.transcript
  const steps = React.useMemo(
    () =>
      thread
        ? (transcriptConversation(thread, "Lead").runs[0]?.activities ?? [])
        : [],
    [thread]
  )
  const stepCount = shownSteps(steps).length
  // The thread's own numbers are live; the result's are final.
  const tokens =
    thread && row.status === "running" ? threadTokens(thread) : row.tokens
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(85vh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="gap-1 border-b px-5 py-4 text-left">
          <DialogTitle className="pr-8 text-base leading-snug">
            {row.title}
          </DialogTitle>
          <DialogDescription className="tabular-nums">
            {roleLabels[row.role]} · {statusLabels[row.status]} ·{" "}
            {formatDuration(row.durationMs)} · {formatTokens(tokens)} tokens
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-6 px-5 py-5">
            <Report row={row} onFileLinkClick={onFileLinkClick} />
            <Section title="Asked by the lead agent">
              <p className="rounded-xl bg-muted/50 px-3.5 py-3 text-sm whitespace-pre-wrap">
                {row.brief}
              </p>
            </Section>
            <Section title={stepCount ? `Steps · ${stepCount}` : "Steps"}>
              <Steps
                error={view.error}
                hasReport={Boolean(row.report)}
                loaded={view.loaded}
                onFileLinkClick={onFileLinkClick}
                running={row.status === "running"}
                steps={steps}
              />
            </Section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function Section({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <section className="grid gap-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </section>
  )
}

function Report({
  onFileLinkClick,
  row,
}: {
  onFileLinkClick?: (path: string) => void
  row: SubAgentRow
}) {
  if (row.report)
    return (
      <Section title="Report">
        <MarkdownMessage
          appearance="plain"
          markdown={row.report.summary}
          onFileLinkClick={onFileLinkClick}
        />
        {row.report.references.length ? (
          <ul className="grid gap-1 text-sm">
            {row.report.references.map((reference) => (
              <li
                key={`${reference.ref}\n${reference.note}`}
                className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-3"
              >
                <Reference
                  onFileLinkClick={onFileLinkClick}
                  reference={reference.ref}
                />
                <span className="text-muted-foreground">{reference.note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    )
  if (row.reason)
    return (
      <Section title="Result">
        <p className="text-sm text-muted-foreground">{row.reason}</p>
      </Section>
    )
  return null
}

function Reference({
  onFileLinkClick,
  reference,
}: {
  onFileLinkClick?: (path: string) => void
  reference: string
}) {
  const className =
    "max-w-72 truncate rounded text-left font-mono text-[12.5px] text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
  if (/^https?:\/\//u.test(reference))
    return (
      <a
        className={className}
        href={reference}
        rel="noreferrer noopener"
        target="_blank"
        title={reference}
      >
        {reference}
      </a>
    )
  const path = reference.replace(/:\d+(?:[-:]\d+)*$/u, "")
  return onFileLinkClick ? (
    <button
      className={className}
      title={reference}
      type="button"
      onClick={() => onFileLinkClick(path)}
    >
      {reference}
    </button>
  ) : (
    <span className={`${className} cursor-default`} title={reference}>
      {reference}
    </span>
  )
}

// The report is shown above, not as a step.
function shownSteps(steps: readonly UserStoryAgentActivity[]) {
  return steps.filter(
    (step) => !(step.kind === "tool" && step.toolName === "report")
  )
}

function Steps({
  error,
  hasReport,
  loaded,
  onFileLinkClick,
  running,
  steps,
}: {
  error?: string
  hasReport: boolean
  loaded: boolean
  onFileLinkClick?: (path: string) => void
  running: boolean
  steps: readonly UserStoryAgentActivity[]
}) {
  const shown = shownSteps(steps)
  if (!shown.length)
    return (
      <p className="text-sm text-muted-foreground">
        {error && !running
          ? `This thread is no longer kept on this computer: helper threads stay for a few days.${hasReport ? " The report above stays with the conversation." : ""}`
          : running || !loaded
            ? "Waiting for its first step."
            : "It took no steps."}
      </p>
    )
  return (
    <Accordion type="multiple" className="grid gap-2">
      {shown.map((step) =>
        step.kind === "tool" ? (
          <ToolCallItem
            key={step.id}
            activity={step}
            entering={false}
            hasFullDetail={false}
            onLoadDetail={() => Promise.resolve(step.detail)}
            onOpenFile={onFileLinkClick}
            running={step.status === "running"}
            value={step.id}
          />
        ) : step.kind === "message" || step.kind === "reasoning" ? (
          <MarkdownMessage
            key={step.id}
            appearance="subtle"
            markdown={step.detail}
            onFileLinkClick={onFileLinkClick}
          />
        ) : null
      )}
    </Accordion>
  )
}
