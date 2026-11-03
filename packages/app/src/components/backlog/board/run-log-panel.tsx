import { PlayIcon } from "lucide-react"
import { Tabs as TabsPrimitive } from "radix-ui"
import * as React from "react"

import { ProjectRunnerStatusDot } from "@/components/backlog/board/project-runner-controls"
import type { RunLogItem } from "@/components/backlog/board/run-log-items"
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
        {/* Tabs start level with the runner's controls, their labels on
            its line, and run down into the terminal. */}
        <div className="min-w-0 flex-1 self-end">
          {items.length ? (
            <RunLogTabs
              items={items}
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

function RunLogTabs({
  items,
  value,
  onValueChange,
}: {
  items: RunLogItem[]
  value?: string
  onValueChange: (id: string) => void
}) {
  return (
    <TabsPrimitive.Root
      activationMode="manual"
      value={value}
      onValueChange={onValueChange}
    >
      <TabsPrimitive.List
        aria-label="Run logs"
        className="relative z-10 -mb-px no-scrollbar flex items-end gap-0.5 overflow-x-auto pr-2"
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.id}
            className={cn(
              "run-log-tab relative flex h-12 max-w-60 min-w-32 shrink-0 items-center justify-center gap-2 rounded-t-lg border border-b-0 border-transparent px-4 pb-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
              "data-[state=active]:border-border data-[state=active]:bg-zinc-950 data-[state=active]:text-zinc-100 data-[state=active]:hover:bg-zinc-950",
              // The selected tab stays dark in both themes: a gray that shows on it.
              "data-[state=active]:[&_[data-status=stopped]]:bg-zinc-500"
            )}
            value={item.id}
          >
            {item.status ? (
              <ProjectRunnerStatusDot status={item.status} />
            ) : null}
            <span className="truncate">{item.label}</span>
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
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
