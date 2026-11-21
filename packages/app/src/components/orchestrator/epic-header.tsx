import * as React from "react"
import {
  GitBranchIcon,
  PauseIcon,
  PlayIcon,
  Settings2Icon,
  WalletIcon,
} from "lucide-react"

import {
  formatMicroUsd,
  type Epic,
} from "@/components/orchestrator/data/epic-data"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function EpicHeader({
  epic,
  pausing,
  spentMicroUsd,
  onOpenSettings,
  onPauseAll,
  onResume,
  onRename,
}: {
  epic: Epic
  pausing: boolean
  // What the epic spent, once the engine says it; unknown until then.
  spentMicroUsd?: number
  onOpenSettings: () => void
  onPauseAll: () => void
  onResume: () => void
  onRename: (title: string) => Promise<unknown>
}) {
  const closed = epic.status === "completed" || epic.status === "discarded"
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="grid min-w-0 flex-1 basis-64 gap-1">
        <EpicTitle key={epic.id} title={epic.title} onRename={onRename} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span
            className="inline-flex min-w-0 items-center gap-1.5"
            title={
              epic.branch
                ? `Verified stories merge into ${epic.branch}. ${epic.targetBranch ?? "Its target"} only moves when you approve the epic.`
                : "The epic's branch is created when the orchestrator starts."
            }
          >
            <GitBranchIcon className="size-3.5 shrink-0" />
            {epic.branch ? (
              <span className="truncate font-mono text-xs">{epic.branch}</span>
            ) : (
              <span>Branch created when it starts</span>
            )}
            {epic.targetBranch ? (
              <span className="shrink-0 text-xs">
                → <span className="font-mono">{epic.targetBranch}</span>
              </span>
            ) : null}
          </span>
          <EpicSpend
            budgetMicroUsd={epic.settings.budgetMicroUsd}
            spentMicroUsd={spentMicroUsd}
          />
          {epic.status === "paused" ? (
            <span className="font-medium text-amber-700 dark:text-amber-300">
              Paused
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {closed ? null : epic.status === "paused" ? (
          <Button
            disabled={pausing}
            title="The orchestrator and the queue go on"
            type="button"
            variant="outline"
            onClick={onResume}
          >
            <PlayIcon />
            Resume
          </Button>
        ) : (
          <Button
            disabled={pausing}
            title="Pause every agent of the epic; nothing new starts"
            type="button"
            variant="outline"
            onClick={onPauseAll}
          >
            <PauseIcon />
            Pause all
          </Button>
        )}
        <Button
          aria-label="Epic settings"
          title="Epic settings"
          type="button"
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
        >
          <Settings2Icon />
        </Button>
      </div>
    </div>
  )
}

function EpicSpend({
  budgetMicroUsd,
  spentMicroUsd,
}: {
  budgetMicroUsd?: number
  spentMicroUsd?: number
}) {
  if (budgetMicroUsd === undefined && spentMicroUsd === undefined) return null
  const over =
    budgetMicroUsd !== undefined &&
    spentMicroUsd !== undefined &&
    spentMicroUsd >= budgetMicroUsd
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 tabular-nums",
        over && "font-medium text-destructive"
      )}
    >
      <WalletIcon className="size-3.5" />
      {spentMicroUsd === undefined
        ? `Budget ${formatMicroUsd(budgetMicroUsd!)}`
        : budgetMicroUsd === undefined
          ? `${formatMicroUsd(spentMicroUsd)} spent`
          : `${formatMicroUsd(spentMicroUsd)} of ${formatMicroUsd(budgetMicroUsd)}`}
    </span>
  )
}

// The title reads as a heading and turns into a field on click.
function EpicTitle({
  title,
  onRename,
}: {
  title: string
  onRename: (title: string) => Promise<unknown>
}) {
  const [draft, setDraft] = React.useState<string>()
  const inputRef = React.useRef<HTMLInputElement>(null)

  function commit() {
    const next = draft?.trim()
    setDraft(undefined)
    if (next && next !== title) void onRename(next).catch(() => undefined)
  }

  if (draft === undefined)
    return (
      <h2 className="min-w-0">
        <button
          className="-mx-1.5 max-w-full truncate rounded-md px-1.5 text-left font-heading text-xl font-semibold tracking-normal outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
          title="Rename the epic"
          type="button"
          onClick={() => {
            setDraft(title)
            requestAnimationFrame(() => inputRef.current?.select())
          }}
        >
          {title}
        </button>
      </h2>
    )
  return (
    <input
      ref={inputRef}
      aria-label="Epic title"
      autoFocus
      className="-mx-1.5 w-full min-w-0 rounded-md bg-muted px-1.5 font-heading text-xl font-semibold tracking-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      maxLength={255}
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit()
        if (event.key === "Escape") {
          event.stopPropagation()
          setDraft(undefined)
        }
      }}
    />
  )
}
