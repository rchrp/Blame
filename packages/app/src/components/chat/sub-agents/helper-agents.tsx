import * as React from "react"
import { ChevronRightIcon } from "lucide-react"

import { useEngineLocation } from "@/components/chat/engine/engine-approvals"
import { useEngineSessions } from "@/components/chat/engine/use-engine-sessions"
import { cn } from "@/lib/utils"

import { HelperAvatar, HelperBouquet } from "./helper-avatar"
import { publishHelpers } from "./sub-agents-live"
import { SubAgentThreadDialog } from "./sub-agent-thread-dialog"
import {
  formatDuration,
  formatTokens,
  leadIn,
  roleLabels,
  statusLabels,
  subAgentRows,
  subAgentSession,
  subAgentTotals,
  type SubAgentRow,
  type SubAgentsCall,
} from "./sub-agents-view"

// The helper agents of one `run_agents` call, right in the conversation: the
// sentence that opens them like any step of the work, then each helper with
// its flower, what it is doing or found, and its time and tokens. No frame:
// they sit on the chat's own background. A helper opens its thread; the
// lead's conversation keeps only the call and its result.
export function HelperAgents({
  call,
  onFileLinkClick,
}: {
  call: SubAgentsCall
  onFileLinkClick?: (path: string) => void
}) {
  const location = useEngineLocation()
  // While the call runs each helper's own records say how it is doing; once
  // it returned, its result says it all.
  const following = call.running
    ? call.briefs
        .map((_, index) => index)
        .filter((index) => !call.queued.includes(index))
    : []
  const transcripts = useEngineSessions(
    following.map((index) => subAgentSession(call.call, index)),
    location
  )
  const now = useNow(call.running)
  const rows = React.useMemo(
    () =>
      subAgentRows(
        call,
        new Map(
          call.briefs.map((_, index) => [
            index,
            transcripts.get(subAgentSession(call.call, index)),
          ])
        ),
        now
      ),
    [call, now, transcripts]
  )
  // The stats panel reminds the person of the helpers that run.
  React.useEffect(() => {
    publishHelpers(call.call, call.running ? rows : undefined)
    return () => publishHelpers(call.call, undefined)
  }, [call.call, call.running, rows])
  const totals = subAgentTotals(rows)
  const head = leadIn(totals, call.running)
  const [opened, setOpened] = React.useState<number>()
  return (
    <section
      aria-label="Helper agents"
      className="@container grid min-w-0 gap-0.5 text-sm"
    >
      <p className="grid min-h-8 grid-cols-[2rem_minmax(0,1fr)] items-center gap-2">
        <HelperBouquet
          className="justify-self-center"
          identities={rows.map((row) => row.identity)}
        />
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 pr-5">
          <span aria-live="polite" className="flex items-baseline gap-1.5">
            <span
              className={cn(
                "text-muted-foreground",
                call.running && "agent-activity-running"
              )}
            >
              {head.verb}
            </span>
            <span>{head.target}</span>
            {head.rest ? (
              <span className="text-muted-foreground">· {head.rest}</span>
            ) : null}
          </span>
          <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">
            {formatTokens(totals.tokens)} tokens ·{" "}
            {formatDuration(totals.durationMs)}
          </span>
        </span>
      </p>
      <ul className="grid">
        {rows.map((row) => (
          <li key={row.index}>
            <HelperRow row={row} onOpen={() => setOpened(row.index)} />
          </li>
        ))}
      </ul>
      {opened !== undefined && rows[opened] ? (
        <SubAgentThreadDialog
          onFileLinkClick={onFileLinkClick}
          onOpenChange={(open) => {
            if (!open) setOpened(undefined)
          }}
          row={rows[opened]}
        />
      ) : null}
    </section>
  )
}

function HelperRow({ onOpen, row }: { onOpen(): void; row: SubAgentRow }) {
  const waiting = row.status === "waiting"
  return (
    <button
      aria-haspopup="dialog"
      aria-label={rowLabel(row)}
      className="group/row -mx-1.5 grid w-[calc(100%+0.75rem)] min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto_0.75rem] items-center gap-x-2 rounded-lg px-1.5 py-1.5 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
      type="button"
      onClick={onOpen}
    >
      <HelperAvatar
        className="row-span-2 self-start justify-self-center"
        identity={row.identity}
        size={28}
        status={row.status}
      />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium">{row.identity.name}</span>
        <span className="truncate" title={row.title}>
          {row.title}
        </span>
      </span>
      <span
        className="text-xs text-muted-foreground tabular-nums"
        title={waiting ? undefined : `${formatTokens(row.tokens)} tokens`}
      >
        {waiting ? null : (
          <>
            {formatDuration(row.durationMs)}
            {tokenText(row) ? ` · ${tokenText(row)}` : ""}
          </>
        )}
      </span>
      <ChevronRightIcon
        aria-hidden="true"
        className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
      />
      <span
        className={cn(
          "col-start-2 col-end-4 truncate text-xs text-muted-foreground",
          row.status === "failed" && "text-destructive"
        )}
      >
        {roleLabels[row.role]}
        <span aria-hidden="true"> · </span>
        {detail(row)}
      </span>
    </button>
  )
}

/** What a row says under its title: what it does, found, or why it stopped. */
function detail(row: SubAgentRow) {
  switch (row.status) {
    case "waiting":
      return "Waiting for a free slot"
    case "running":
      return row.current ?? "Starting"
    case "done":
      return plain(row.report?.summary) ?? "Done"
    case "failed":
      return row.reason ?? "Failed"
    case "cancelled":
      return "Stopped"
  }
}

/** The first line of a summary, without its markdown marks. */
function plain(summary: string | undefined) {
  return summary?.split("\n")[0]?.replace(/[`*_]/gu, "").trim()
}

// A helper that has not answered yet has no figure to show.
function tokenText(row: SubAgentRow) {
  return row.status === "running" && row.tokens === 0
    ? ""
    : `${formatTokens(row.tokens)} tok`
}

/** What a screen reader hears for a row. */
function rowLabel(row: SubAgentRow) {
  const parts = [
    `${row.identity.name}, ${roleLabels[row.role]}: ${row.title}`,
    statusLabels[row.status],
    detail(row),
  ]
  if (row.status !== "waiting")
    parts.push(
      formatDuration(row.durationMs),
      row.tokens ? `${formatTokens(row.tokens)} tokens` : "no tokens yet"
    )
  return `${parts.join(", ")}. Opens its thread.`
}

// The seconds of a running helper count up; nothing ticks once they ended.
function useNow(active: boolean) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}
