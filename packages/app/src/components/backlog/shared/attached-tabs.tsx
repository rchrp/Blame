import { XIcon } from "lucide-react"
import { Tabs as TabsPrimitive } from "radix-ui"
import type * as React from "react"

import { ProjectRunnerStatusDot } from "@/components/backlog/board/project-runner-controls"
import type { ProjectRunnerControlStatus } from "@/components/backlog/board/project-runner-types"
import { cn } from "@/lib/utils"

// Tabs set on the panel under them, the selected one joined to it by a
// smooth curve on each side (.attached-tab in index.css): a run's logs on
// their terminal, a story's open files on their editor.
export type AttachedTab = {
  id: string
  label: string
  icon?: React.ReactNode
  status?: ProjectRunnerControlStatus
  // The full name, when the label is short.
  title?: string
  closable?: boolean
}

// The panel's color, which the selected tab and its curves take.
type AttachedTabsSurface = "terminal" | "panel"

const surfaceColor: Record<AttachedTabsSurface, string> = {
  panel: "var(--background)",
  terminal: "var(--color-zinc-950)",
}

const activeClassName: Record<AttachedTabsSurface, string> = {
  panel:
    "data-[state=active]:border-border data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:hover:bg-background",
  // The terminal stays dark in both themes, and so does a gray on it.
  terminal:
    "data-[state=active]:border-border data-[state=active]:bg-zinc-950 data-[state=active]:text-zinc-100 data-[state=active]:hover:bg-zinc-950 data-[state=active]:[&_[data-status=stopped]]:bg-zinc-500",
}

export function AttachedTabs({
  label,
  items,
  surface = "terminal",
  value,
  onClose,
  onValueChange,
}: {
  label: string
  items: AttachedTab[]
  surface?: AttachedTabsSurface
  value?: string
  onClose?: (id: string) => void
  onValueChange: (id: string) => void
}) {
  return (
    <TabsPrimitive.Root
      activationMode="manual"
      value={value}
      onValueChange={onValueChange}
    >
      <TabsPrimitive.List
        aria-label={label}
        className="relative z-10 -mb-px no-scrollbar flex items-end gap-0.5 overflow-x-auto pr-2"
        style={
          {
            "--attached-tab-surface": surfaceColor[surface],
          } as React.CSSProperties
        }
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.id}
            className={cn(
              "attached-tab group/attached-tab relative flex h-[2.375rem] max-w-60 min-w-32 shrink-0 items-center justify-center gap-2 rounded-t-lg border border-b-0 border-transparent px-4 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
              item.closable && "pr-2",
              activeClassName[surface]
            )}
            title={item.title}
            value={item.id}
            onAuxClick={(event) => {
              if (event.button !== 1 || !item.closable) return
              event.preventDefault()
              onClose?.(item.id)
            }}
          >
            {item.status ? (
              <ProjectRunnerStatusDot status={item.status} />
            ) : null}
            {item.icon}
            <span className="truncate">{item.label}</span>
            {item.closable ? (
              <span
                aria-label={`Close ${item.label}`}
                className="ml-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/attached-tab:opacity-100 group-data-[state=active]/attached-tab:opacity-100 hover:bg-foreground/10 hover:text-foreground"
                role="button"
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose?.(item.id)
                }}
                // Radix selects a tab on mouse down: closing it must not.
                onMouseDown={(event) => event.stopPropagation()}
              >
                <XIcon className="size-3.5" />
              </span>
            ) : null}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  )
}
