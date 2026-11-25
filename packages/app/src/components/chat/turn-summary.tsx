import * as React from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FileDiffIcon,
  FlaskConicalIcon,
  SlashIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react"

import { DevelopmentFileIcon } from "@/components/backlog/development/development-file-icon"
import { formatAgentTurnDuration } from "@/components/chat/agent-turn-metrics-data"
import {
  turnChanges,
  type TurnActivity,
  type TurnFileChange,
} from "@/components/chat/tool-calls/turn-changes"
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
  const visibleFiles = expanded
    ? changes.files
    : changes.files.slice(0, collapsedFileCount)
  const hiddenCount = changes.files.length - visibleFiles.length

  return (
    <section
      aria-label="Turn summary"
      className="chat-enter-agent min-w-0 overflow-hidden rounded-2xl bg-card shadow-[0_2px_4px_-2px_#00000012,0_10px_24px_-12px_#00000026] ring-1 ring-foreground/10 dark:shadow-[0_2px_4px_-2px_#0006,0_10px_24px_-12px_#0009]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
        <TurnStatus status={run.status} duration={duration} />
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {changes.files.length ? (
            <Stat icon={FileDiffIcon}>
              <span className="text-foreground/85">
                {changes.files.length}{" "}
                {changes.files.length === 1 ? "file" : "files"}
              </span>
              {/* Files changed only by commands have no known line counts. */}
              {changes.additions || changes.deletions ? (
                <LineCounts
                  additions={changes.additions}
                  deletions={changes.deletions}
                />
              ) : null}
            </Stat>
          ) : null}
          {changes.tests ? (
            <Stat icon={FlaskConicalIcon}>
              <span
                className={cn(
                  !changes.tests.failed &&
                    "text-emerald-600 dark:text-emerald-400"
                )}
              >
                {changes.tests.passed ?? 0} passed
              </span>
              {changes.tests.failed ? (
                <span className="text-red-600 dark:text-red-400">
                  · {changes.tests.failed} failed
                </span>
              ) : null}
            </Stat>
          ) : null}
          {changes.commands ? (
            <Stat icon={SquareTerminalIcon}>
              <span className="text-foreground/85">
                {changes.commands}{" "}
                {changes.commands === 1 ? "command" : "commands"}
              </span>
              {changes.failedCommands ? (
                <span className="text-red-600 dark:text-red-400">
                  · {changes.failedCommands} failed
                </span>
              ) : null}
            </Stat>
          ) : null}
        </div>
      </header>
      {visibleFiles.length ? (
        <div className="border-t border-foreground/8 p-1.5">
          <ul className="grid">
            {visibleFiles.map((file) => (
              <li key={file.path}>
                <TurnFileRow file={file} onFileClick={onFileClick} />
              </li>
            ))}
          </ul>
          {changes.files.length > collapsedFileCount ? (
            <button
              type="button"
              className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2 pl-8 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded
                ? "Show fewer files"
                : `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`}
              {expanded ? (
                <ChevronUpIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function TurnFileRow({
  file,
  onFileClick,
}: {
  file: TurnFileChange
  onFileClick?: (path: string) => void
}) {
  const index =
    Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\")) + 1
  const directory = file.path.slice(0, Math.max(0, index - 1))
  const name = file.path.slice(index)

  return (
    <button
      type="button"
      className="grid h-8 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      onClick={() => onFileClick?.(file.path)}
      title={file.path}
    >
      <DevelopmentFileIcon
        className="size-4 shrink-0 opacity-75 grayscale"
        node={{ path: file.path, type: "file" }}
      />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="max-w-full shrink-0 truncate text-foreground">
          {name}
        </span>
        {directory ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground/80">
            {directory}
          </span>
        ) : null}
      </span>
      {file.byCommand ? (
        <span className="text-[11px] text-muted-foreground">via command</span>
      ) : (
        <LineCounts
          additions={file.additions ?? 0}
          deletions={file.added ? undefined : (file.deletions ?? 0)}
        />
      )}
      <span
        aria-label={file.added ? "Added" : "Modified"}
        className={cn(
          "w-3 text-center font-mono text-[11px] font-semibold",
          file.added
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-sky-600 dark:text-sky-400"
        )}
      >
        {file.added ? "A" : "M"}
      </span>
    </button>
  )
}

function Stat({
  children,
  icon: Icon,
}: {
  children: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-foreground/6 px-2.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      {children}
    </span>
  )
}

function TurnStatus({
  duration,
  status,
}: {
  duration: string
  status: TurnSummaryRun["status"]
}) {
  const { icon: Icon, iconTone, label, prefix, tone } = turnStatusLook(status)

  return (
    <span className="flex min-w-0 items-center gap-1.5 pl-px text-sm">
      <Icon className={cn("size-3.5 shrink-0", iconTone)} strokeWidth={2.5} />
      <span className={cn("font-medium", tone)}>{label}</span>
      <span className="text-muted-foreground tabular-nums">
        {prefix}
        {duration}
      </span>
    </span>
  )
}

function turnStatusLook(status: TurnSummaryRun["status"]) {
  if (status === "failed")
    return {
      icon: XIcon,
      iconTone: "text-red-600/80 dark:text-red-400/80",
      label: "Stopped",
      prefix: "after ",
      tone: "text-red-600 dark:text-red-400",
    }
  if (status === "cancelled")
    return {
      icon: SlashIcon,
      iconTone: "text-muted-foreground/70",
      label: "Cancelled",
      prefix: "after ",
      tone: "text-muted-foreground",
    }
  return {
    icon: CheckIcon,
    iconTone: "text-emerald-600/70 dark:text-emerald-400/70",
    label: "Done",
    prefix: "in ",
    tone: "text-foreground",
  }
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
      <span className="text-emerald-600 dark:text-emerald-400">
        +{shownAdditions}
      </span>
      {deletions !== undefined ? (
        <span className="text-red-600 dark:text-red-400">
          −{shownDeletions}
        </span>
      ) : null}
    </span>
  )
}

function turnDuration(run: TurnSummaryRun) {
  const start = Date.parse(run.createdAt)
  const end = Date.parse(run.completedAt ?? run.updatedAt ?? run.createdAt)
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : 0
}
