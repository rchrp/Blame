import * as React from "react"
import { ChevronRightIcon } from "lucide-react"

import { useEngineLocation } from "@/components/chat/engine/engine-approvals"
import { useEngineSessions } from "@/components/chat/engine/use-engine-sessions"
import { cn } from "@/lib/utils"

import { SubAgentThreadDialog } from "./sub-agent-thread-dialog"
import {
  formatDuration,
  formatTokens,
  roleLabels,
  statusLabels,
  subAgentRows,
  subAgentSession,
  subAgentTotals,
  summaryLine,
  type SubAgentRow,
  type SubAgentStatus,
  type SubAgentsCall,
} from "./sub-agents-view"

// The helper agents of one `run_agents` call, as one card: a row for each,
// its status, time and tokens, and the total at the bottom. A row opens that
// helper's thread; the lead's conversation keeps only the call and its result.
export function SubAgentsCard({
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
  const totals = subAgentTotals(rows)
  const [opened, setOpened] = React.useState<number>()
  return (
    <section
      aria-label="Helper agents"
      className="@container grid min-w-0 overflow-hidden rounded-xl border bg-muted/30 text-sm"
    >
      <header className="flex items-center justify-between gap-3 px-3.5 py-2.5">
        <h3 className="font-medium">Helper agents</h3>
        <span
          aria-live="polite"
          className="text-xs text-muted-foreground tabular-nums"
        >
          {summaryLine(totals, call.running)}
        </span>
      </header>
      <ul className="grid border-t">
        {rows.map((row) => (
          <li key={row.index} className="border-b last:border-b-0">
            <SubAgentRowButton row={row} onOpen={() => setOpened(row.index)} />
          </li>
        ))}
      </ul>
      <footer className="flex items-center justify-between gap-3 border-t px-3.5 py-2 text-xs text-muted-foreground tabular-nums">
        <span>Total</span>
        <span>
          {formatTokens(totals.tokens)} tokens ·{" "}
          {formatDuration(totals.durationMs)}
        </span>
      </footer>
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

function SubAgentRowButton({
  onOpen,
  row,
}: {
  onOpen(): void
  row: SubAgentRow
}) {
  const waiting = row.status === "waiting"
  return (
    <button
      aria-haspopup="dialog"
      aria-label={rowLabel(row)}
      className="group/row grid w-full min-w-0 grid-cols-[0.75rem_minmax(0,1fr)_1rem] items-center gap-x-3 gap-y-0.5 px-3.5 py-2.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset @md:grid-cols-[0.75rem_minmax(0,1fr)_auto_1rem]"
      type="button"
      onClick={onOpen}
    >
      <StatusDot status={row.status} />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="w-[4.25rem] shrink-0 text-xs text-muted-foreground">
          {roleLabels[row.role]}
        </span>
        <span className="truncate" title={row.title}>
          {row.title}
        </span>
      </span>
      <span className="col-start-2 row-start-2 flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground tabular-nums @md:col-start-3 @md:row-start-1">
        <span
          className={cn(
            "@md:w-[4.5rem] @md:text-right",
            row.status === "failed" && "text-destructive",
            row.status === "running" && "agent-activity-running"
          )}
        >
          {statusLabels[row.status]}
        </span>
        {waiting ? null : (
          <>
            <span className="@md:w-[3.75rem] @md:text-right">
              {formatDuration(row.durationMs)}
            </span>
            <span className="@md:w-[3.25rem] @md:text-right">
              {formatTokens(row.tokens)}
            </span>
          </>
        )}
      </span>
      <ChevronRightIcon
        aria-hidden="true"
        className="col-start-3 row-start-1 size-4 text-muted-foreground opacity-60 transition-opacity group-hover/row:opacity-100 @md:col-start-4"
      />
      {row.status === "failed" && row.reason ? (
        <span className="col-start-2 row-start-3 truncate text-xs text-destructive @md:row-start-2">
          {row.reason}
        </span>
      ) : null}
    </button>
  )
}

function StatusDot({ status }: { status: SubAgentStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "justify-self-center rounded-full",
        status === "running"
          ? "agent-thinking-mark"
          : cn(
              "size-2",
              status === "done" && "bg-emerald-500",
              status === "failed" && "bg-destructive",
              status === "cancelled" && "bg-muted-foreground/50",
              status === "waiting" && "border border-muted-foreground/60"
            )
      )}
    />
  )
}

/** What a screen reader hears for a row. */
function rowLabel(row: SubAgentRow) {
  const parts = [
    `${roleLabels[row.role]}: ${row.title}`,
    statusLabels[row.status],
  ]
  if (row.status !== "waiting")
    parts.push(
      formatDuration(row.durationMs),
      `${formatTokens(row.tokens)} tokens`
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
