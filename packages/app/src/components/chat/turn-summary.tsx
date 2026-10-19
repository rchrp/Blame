import * as React from "react"
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CircleXIcon,
  FlaskConicalIcon,
  SquareTerminalIcon,
} from "lucide-react"

import { formatAgentTurnDuration } from "@/components/chat/agent-turn-metrics-data"
import { turnChanges, type TurnActivity } from "@/components/chat/tool-calls/turn-changes"
import { useCountUp } from "@/lib/use-count-up"
import { cn } from "@/lib/utils"

const collapsedFileCount = 4

type TurnSummaryRun = {
  completedAt?: string | null
  createdAt: string
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  updatedAt?: string | null
}

// The end-of-turn recap: how long the agent worked, which files this turn
// changed (from its tool calls) and how the checks went.
export function TurnSummary({
  activities,
  onFileClick,
  run,
}: {
  activities: readonly TurnActivity[]
  onFileClick?: (path: string) => void
  run: TurnSummaryRun
}) {
  const changes = React.useMemo(() => turnChanges(activities), [activities])
  const [expanded, setExpanded] = React.useState(false)
  if (run.status === "running" || run.status === "pending") return null
  if (!changes.files.length && !changes.commands) return null

  const duration = formatAgentTurnDuration(turnDuration(run))
  const visibleFiles = expanded ? changes.files : changes.files.slice(0, collapsedFileCount)
  const hiddenCount = changes.files.length - visibleFiles.length

  return (
    <section
      aria-label="Turn summary"
      className="chat-enter-agent min-w-0 overflow-hidden rounded-xl border bg-muted/20"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5 text-xs text-muted-foreground">
        <TurnStatus status={run.status} duration={duration} />
        {changes.files.length ? (
          <span className="flex items-center gap-1.5">
            <span className="text-foreground">
              {changes.files.length} {changes.files.length === 1 ? "file" : "files"} changed
            </span>
            <LineCounts additions={changes.additions} deletions={changes.deletions} />
          </span>
        ) : null}
        {changes.tests ? (
          <span className="flex items-center gap-1.5">
            <FlaskConicalIcon className="size-3.5" />
            {changes.tests.failed ? (
              <span className="text-red-600 dark:text-red-400">{changes.tests.failed} failed</span>
            ) : null}
            <span className={cn(!changes.tests.failed && "text-emerald-600 dark:text-emerald-400")}>
              {changes.tests.passed ?? 0} passed
            </span>
          </span>
        ) : null}
        {changes.commands ? (
          <span className="flex items-center gap-1.5">
            <SquareTerminalIcon className="size-3.5" />
            {changes.commands} {changes.commands === 1 ? "command" : "commands"}
            {changes.failedCommands ? (
              <span className="text-red-600 dark:text-red-400">· {changes.failedCommands} failed</span>
            ) : null}
          </span>
        ) : null}
      </div>
      {visibleFiles.length ? (
        <ul className="grid gap-px border-t bg-background/40 p-1">
          {visibleFiles.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                onClick={() => onFileClick?.(file.path)}
                title={file.path}
              >
                <FilePath path={file.path} />
                {file.added ? <Tag>New</Tag> : null}
                {file.byCommand ? <Tag>By command</Tag> : null}
                <span className="ml-auto shrink-0">
                  {file.byCommand ? null : (
                    <LineCounts additions={file.additions ?? 0} deletions={file.added ? undefined : (file.deletions ?? 0)} />
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {changes.files.length > collapsedFileCount ? (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 border-t px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show fewer files" : `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`}
          {expanded ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
        </button>
      ) : null}
    </section>
  )
}

function TurnStatus({ duration, status }: { duration: string; status: TurnSummaryRun["status"] }) {
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
        <CircleXIcon className="size-3.5" /> Stopped after {duration}
      </span>
    )
  }
  if (status === "cancelled") {
    return (
      <span className="flex items-center gap-1.5">
        <CircleSlashIcon className="size-3.5" /> Cancelled after {duration}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
      <CircleCheckIcon className="size-3.5" /> Done in {duration}
    </span>
  )
}

export function LineCounts({
  additions,
  deletions,
}: {
  additions: number
  deletions?: number
}) {
  const shownAdditions = useCountUp(additions)
  const shownDeletions = useCountUp(deletions ?? 0)
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{shownAdditions}</span>
      {deletions !== undefined ? (
        <span className="text-red-600 dark:text-red-400">−{shownDeletions}</span>
      ) : null}
    </span>
  )
}

function FilePath({ path }: { path: string }) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
  return (
    <span className="min-w-0 truncate font-mono text-xs">
      <span className="text-muted-foreground">{path.slice(0, index)}</span>
      <span className="text-foreground">{path.slice(index)}</span>
    </span>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      {children}
    </span>
  )
}

function turnDuration(run: TurnSummaryRun) {
  const start = Date.parse(run.createdAt)
  const end = Date.parse(run.completedAt ?? run.updatedAt ?? run.createdAt)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}
