import { PlayIcon } from "lucide-react"
import * as React from "react"

import { runLogEmpty, type RunLog } from "@/components/backlog/board/run-log"
import type { RunLogItem } from "@/components/backlog/board/run-log-items"
import {
  RunLogText,
  useRunLogSnapshot,
} from "@/components/backlog/board/run-log-text"
import { AttachedTabs } from "@/components/backlog/shared/attached-tabs"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type RunLogEmpty = {
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}

type RunLogPanelProps = {
  empty: RunLogEmpty
  items: RunLogItem[]
  // Shown in place of the tabs while there are none.
  placeholder?: string
  log?: RunLog
  notice?: React.ReactNode
  value?: string
  onValueChange: (id: string) => void
}

// A run's logs: one tab per service or app, the selected one joined to
// the terminal under it.
export function RunLogPanel({
  empty,
  items,
  log,
  notice,
  placeholder,
  value,
  onValueChange,
}: RunLogPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-4">
      <div className="flex h-12 shrink-0 items-start gap-2">
        {/* The tabs sit flush with the terminal; the controls float above it. */}
        <div className="min-w-0 flex-1 self-end">
          {items.length ? (
            <AttachedTabs
              items={items}
              label="Run logs"
              value={value}
              onValueChange={onValueChange}
            />
          ) : (
            <p className="truncate px-3 pb-2 text-sm text-muted-foreground">
              {placeholder}
            </p>
          )}
        </div>
        <PreviewActionsSpace />
      </div>
      <RunLogTerminal
        // The first tab, selected, carries the terminal's left edge up.
        flushStart={Boolean(value) && items[0]?.id === value}
        empty={empty}
        log={log}
        notice={notice}
      />
    </div>
  )
}

// Room for the preview's run controls, which stay over the toolbar's right
// end whatever the view (see UserStoryPreview).
export function PreviewActionsSpace() {
  return (
    <span
      aria-hidden="true"
      className="h-full shrink-0"
      style={{ width: "var(--preview-actions-space, 0px)" }}
    />
  )
}

// Terminal output as a terminal shows it: colors and spinners dropped.
function RunLogTerminal({
  empty,
  flushStart,
  log,
  notice,
}: {
  empty: RunLogEmpty
  flushStart: boolean
  log?: RunLog
  notice?: React.ReactNode
}) {
  const snapshot = useRunLogSnapshot(log)
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-terminal-surface",
        flushStart && "rounded-tl-none"
      )}
    >
      {/* The terminal stays dark in both themes: so does what it holds. */}
      {notice ? <div className="dark shrink-0 p-3 pb-0">{notice}</div> : null}
      {log && !runLogEmpty(snapshot) ? (
        <RunLogText
          key={log.id}
          className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs whitespace-pre-wrap text-zinc-100 select-text"
          log={log}
          snapshot={snapshot}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <p className="text-sm font-medium text-zinc-300">{empty.title}</p>
          {empty.description ? (
            <p className="max-w-sm text-xs text-pretty text-neutral-400">
              {empty.description}
            </p>
          ) : null}
          {empty.action ? (
            <Button
              className="mt-3 border-white/10 bg-white/5 text-neutral-100 hover:bg-white/10 hover:text-white"
              size="sm"
              type="button"
              variant="outline"
              onClick={empty.action.onClick}
            >
              <PlayIcon className="text-emerald-400" />
              {empty.action.label}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
