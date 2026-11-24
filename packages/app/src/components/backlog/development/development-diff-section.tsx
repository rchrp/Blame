import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { DevelopmentDiffView } from "@/components/backlog/development/development-diff-view"
import { DiffStats } from "@/components/backlog/development/development-diff-stats"
import { DevelopmentFileIcon } from "@/components/backlog/development/development-file-icon"
import type { VcsFileDiff } from "@/components/backlog/development/development-workspace"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type DiffSectionProps = {
  diff: VcsFileDiff
  defaultOpen?: boolean
  hideHeader?: boolean
  onOpenFile?: (path: string) => void
}

export function DevelopmentDiffSection({
  defaultOpen = false,
  diff,
  hideHeader = false,
  onOpenFile,
}: DiffSectionProps) {
  const sectionRef = React.useRef<HTMLElement>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const patchId = React.useId()
  const [expanded, setExpanded] = React.useState(defaultOpen)
  const [truncated, setTruncated] = React.useState(false)

  React.useEffect(() => {
    if (defaultOpen) sectionRef.current?.scrollIntoView({ block: "start" })
  }, [defaultOpen])

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content || expanded) return
    const measure = () =>
      setTruncated(content.offsetHeight > viewport.clientHeight + 1)
    const observer = new ResizeObserver(measure)
    measure()
    observer.observe(content)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [expanded])

  const showToggle = Boolean(diff.patch && (expanded || truncated))
  return (
    <section
      ref={sectionRef}
      className="relative min-w-0 scroll-mt-3 bg-card [--diff-surface:var(--color-card)] dark:bg-neutral-800 dark:[--diff-surface:var(--color-neutral-800)]"
    >
      {!hideHeader && (
        <div className="flex min-w-0 items-center gap-2 border-b border-foreground/8 bg-foreground/3 px-2 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-sm">
            <DevelopmentFileIcon
              className="shrink-0"
              node={{ path: diff.file, type: "file" }}
            />
            <span className="truncate font-medium" title={diff.file}>
              {diff.file}
            </span>
          </div>
          {diff.status && (
            <span className="text-xs text-muted-foreground capitalize">
              {diff.status}
            </span>
          )}
          <DiffStats compact diff={diff} />
          {onOpenFile && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Open ${diff.file}`}
              onClick={() => onOpenFile(diff.file)}
            >
              Open
            </Button>
          )}
        </div>
      )}
      <div
        id={patchId}
        ref={viewportRef}
        className={cn(
          "min-w-0",
          expanded ? "max-h-[60vh] overflow-auto" : "max-h-28 overflow-clip"
        )}
        inert={!expanded && truncated}
        tabIndex={expanded ? 0 : undefined}
        aria-label={expanded ? `Diff for ${diff.file}` : undefined}
      >
        <div ref={contentRef} className="min-w-0">
          <DevelopmentDiffView diff={diff} scroll={false} />
        </div>
      </div>
      {showToggle && (
        <div
          className={cn(
            "flex justify-center",
            !expanded &&
              "pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-[var(--diff-surface)] from-20% to-transparent pt-7 backdrop-blur-[1px]"
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-events-auto gap-1 text-xs text-muted-foreground"
            aria-controls={patchId}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} diff for ${diff.file}`}
            onClick={() => {
              if (expanded) viewportRef.current?.scrollTo(0, 0)
              setExpanded(!expanded)
            }}
          >
            {expanded ? "Show less" : "Show more"}
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3.5", expanded && "rotate-180")}
            />
          </Button>
        </div>
      )}
    </section>
  )
}
