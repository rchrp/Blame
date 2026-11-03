import { PlayIcon } from "lucide-react"
import * as React from "react"

import type { RunLogItem } from "@/components/backlog/board/run-log-items"
import { AttachedTabs } from "@/components/backlog/shared/attached-tabs"
import { Button } from "@/components/ui/button"
import { terminalText } from "@/lib/terminal-text"
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
  notice?: React.ReactNode
  output: string
  value?: string
  onValueChange: (id: string) => void
}

// A run's logs: one tab per service or app, the selected one joined to
// the terminal under it.
export function RunLogPanel({
  empty,
  items,
  notice,
  output,
  placeholder,
  value,
  onValueChange,
}: RunLogPanelProps) {
  // Raw terminal output: colors and spinners dropped, as a terminal shows it.
  const text = React.useMemo(() => terminalText(output), [output])
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-4">
      <div className="flex h-12 shrink-0 items-start gap-2">
        {/* Tabs as tall as the runner's controls, on the terminal. */}
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
        notice={notice}
        output={text}
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

function RunLogTerminal({
  empty,
  flushStart,
  notice,
  output,
}: {
  empty: RunLogEmpty
  flushStart: boolean
  notice?: React.ReactNode
  output: string
}) {
  const outputRef = React.useRef<HTMLPreElement>(null)
  React.useEffect(() => {
    const element = outputRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [output])
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-zinc-950",
        flushStart && "rounded-tl-none"
      )}
    >
      {/* The terminal stays dark in both themes: so does what it holds. */}
      {notice ? <div className="dark shrink-0 p-3 pb-0">{notice}</div> : null}
      {output ? (
        <pre
          ref={outputRef}
          className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs whitespace-pre-wrap text-zinc-100 select-text"
        >
          {output}
        </pre>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <p className="text-sm font-medium text-zinc-300">{empty.title}</p>
          {empty.description ? (
            <p className="max-w-sm text-xs text-pretty text-zinc-500">
              {empty.description}
            </p>
          ) : null}
          {empty.action ? (
            <Button
              className="mt-3 border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800 hover:text-zinc-50"
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
