import * as React from "react"
import {
  diffLineKind,
  diffLines,
  type DiffCodeLine,
} from "@/components/backlog/development/development-diff-parser"
import type { VcsFileDiff } from "@/components/backlog/development/development-workspace"
import { PatchDiff } from "@pierre/diffs/react"

import {
  pierreShadowHostSelector,
  selectedCodeExcerpt,
} from "@/components/backlog/development/code-excerpt"
import { DiffStats } from "@/components/backlog/development/development-diff-stats"
import {
  diffKindClassName,
  filename,
} from "@/components/backlog/development/development-workspace"
import {
  pierreSyntaxThemes,
  usePierreSyntaxHighlighting,
} from "@/components/backlog/development/pierre-syntax-highlighting"
import {
  SelectionExcerptActions,
  type TextSelection,
} from "@/components/backlog/shared/selection-excerpt-actions"
import { Badge } from "@/components/ui/badge"
import { useTheme } from "@/components/providers/theme-provider"
import { runWorkerTask, workerTaskAborted } from "@/lib/worker-task"
import { cn } from "@/lib/utils"

const diffLineHeight = 20
const diffVirtualizationThreshold = 400
const diffOverscan = 24
const diffScrollClassName = "min-h-0 w-full max-w-full flex-1 overflow-auto"

export function DevelopmentDiffView({
  diff,
  scroll = true,
  title,
}: {
  diff?: VcsFileDiff
  scroll?: boolean
  title?: string
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const path = diff?.file
  const readExcerpt = React.useCallback(
    (selection: TextSelection) =>
      path ? selectedCodeExcerpt(path, selection) : undefined,
    [path]
  )

  if (!diff?.patch) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No diff available.
      </div>
    )
  }

  return (
    // The story drawer turns text selection off; code stays selectable.
    <div
      ref={containerRef}
      className="flex h-full min-h-0 max-w-full min-w-0 flex-col overflow-hidden select-text"
    >
      {title && (
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
          <span className="truncate font-medium">{title}</span>
          <DiffStats diff={diff} />
        </div>
      )}
      {scroll ? (
        <PierreDiff patch={diff.patch} path={diff.file} scroll />
      ) : (
        <PierreDiff patch={diff.patch} path={diff.file} />
      )}
      <SelectionExcerptActions
        containerRef={containerRef}
        readExcerpt={readExcerpt}
        shadowHostSelector={pierreShadowHostSelector}
      />
    </div>
  )
}

function PierreDiff({
  patch,
  path,
  scroll = false,
}: {
  patch: string
  path: string
  scroll?: boolean
}) {
  const syntaxHighlightingReady = usePierreSyntaxHighlighting(path)
  const { theme } = useTheme()
  const themeType =
    theme === "system"
      ? document.documentElement.classList.contains("dark")
        ? "dark"
        : "light"
      : theme
  const options = React.useMemo(
    () => ({
      diffIndicators: "bars" as const,
      diffStyle: "unified" as const,
      disableFileHeader: true,
      lineHoverHighlight: "line" as const,
      overflow: scroll ? ("scroll" as const) : ("wrap" as const),
      theme: pierreSyntaxThemes,
      themeType,
    }),
    [scroll, themeType]
  )

  if (!patch.includes("@@")) {
    return <DiffCode patch={patch} scroll={scroll} />
  }

  if (!syntaxHighlightingReady) {
    return (
      <div className={cn("min-h-0 max-w-full min-w-0", scroll && "h-full")} />
    )
  }

  return (
    <div className={cn("min-h-0 max-w-full min-w-0", scroll && "h-full")}>
      <PatchDiff
        className="blame-pierre-diff"
        options={options}
        patch={patch}
      />
    </div>
  )
}

export function DiffFileHeader({ diff }: { diff: VcsFileDiff }) {
  const kind =
    diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-muted/30 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{filename(diff.file)}</div>
        <div className="truncate text-xs text-muted-foreground">
          {diff.file}
        </div>
      </div>
      <Badge
        className={cn("shrink-0", diffKindClassName(kind))}
        variant="outline"
      >
        {diff.status ?? "modified"}
      </Badge>
      <DiffStats diff={diff} />
    </div>
  )
}

function DiffLine({ line }: { line: DiffCodeLine }) {
  const kind = lineKind(line.content)

  return (
    <div
      className={cn(
        "grid min-w-full grid-cols-[3rem_2.75rem_1.5rem_max-content] border-l-2 transition-colors",
        lineClassName(kind),
        "hover:bg-black/5 dark:hover:bg-white/8"
      )}
    >
      <span className="sticky left-0 z-10 h-5 bg-inherit px-1.5 text-right text-muted-foreground/70 select-none">
        {line.oldLineNumber ?? line.newLineNumber ?? ""}
      </span>
      <span className="px-1.5 text-right text-muted-foreground/70 select-none">
        {line.newLineNumber ?? ""}
      </span>
      <span className="px-1 text-center text-muted-foreground/70 select-none">
        {diffMarker(line.content)}
      </span>
      <code
        className="px-3 whitespace-pre"
        data-line={line.newLineNumber ?? line.oldLineNumber}
      >
        {diffLineContent(line.content) || " "}
      </code>
    </div>
  )
}

function DiffCode({
  patch,
  scroll = false,
}: {
  patch: string
  scroll?: boolean
}) {
  const lines = useDiffLines(patch)

  if (scroll && lines.length > diffVirtualizationThreshold) {
    return <VirtualDiffCode lines={lines} />
  }

  if (scroll) {
    return (
      <div className={diffScrollClassName}>
        <DiffCodeLines lines={lines} />
      </div>
    )
  }

  return <DiffCodeLines lines={lines} />
}

function DiffCodeLines({ lines }: { lines: DiffCodeLine[] }) {
  return (
    <pre className="w-max min-w-full p-0 font-mono text-xs leading-5">
      {lines.map((line, index) => (
        <DiffLine key={`${index}:${line.content}`} line={line} />
      ))}
    </pre>
  )
}

function VirtualDiffCode({ lines }: { lines: DiffCodeLine[] }) {
  const container = React.useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const height = useElementHeight(container)
  const visibleRange = visibleDiffWindow(scrollTop, height, lines.length)

  return (
    <div
      ref={container}
      className={cn(diffScrollClassName, "font-mono text-xs leading-5")}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <pre
        className="relative w-max min-w-full p-0"
        style={{ height: lines.length * diffLineHeight }}
      >
        <VirtualDiffLines lines={lines} visibleRange={visibleRange} />
      </pre>
    </div>
  )
}

function VirtualDiffLines({
  lines,
  visibleRange,
}: {
  lines: DiffCodeLine[]
  visibleRange: { end: number; start: number }
}) {
  return (
    <div
      style={{
        transform: `translateY(${visibleRange.start * diffLineHeight}px)`,
      }}
    >
      {lines.slice(visibleRange.start, visibleRange.end).map((line, offset) => {
        const index = visibleRange.start + offset
        return <DiffLine key={`${index}:${line.content}`} line={line} />
      })}
    </div>
  )
}

function useElementHeight(ref: React.RefObject<HTMLElement | null>) {
  const [height, setHeight] = React.useState(0)

  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const updateHeight = () => setHeight(element.clientHeight)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return height
}

function visibleDiffWindow(
  scrollTop: number,
  height: number,
  lineCount: number
) {
  const start = Math.max(
    0,
    Math.floor(scrollTop / diffLineHeight) - diffOverscan
  )
  const visible = Math.ceil(height / diffLineHeight) + diffOverscan * 2
  return { end: Math.min(lineCount, start + visible), start }
}

function useDiffLines(patch: string) {
  const [result, setResult] = React.useState<{
    lines: DiffCodeLine[]
    patch: string
  }>({ lines: [], patch: "" })

  React.useEffect(() => {
    let active = true
    const controller = new AbortController()
    runWorkerTask<{ patch: string }, DiffCodeLine[]>(
      new URL("./development-diff.worker.ts", import.meta.url),
      { patch },
      controller.signal
    )
      .catch((error) => {
        if (workerTaskAborted(error)) return []
        return diffLines(patch)
      })
      .then((nextLines) => {
        if (active) setResult({ lines: nextLines, patch })
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [patch])

  return result.patch === patch ? result.lines : []
}

function lineKind(line: string) {
  return diffLineKind(line)
}

function lineClassName(kind: ReturnType<typeof lineKind>) {
  if (kind === "add") return "border-emerald-500/50 bg-emerald-500/10"
  if (kind === "del") return "border-destructive/50 bg-destructive/10"
  if (kind === "hunk") return "border-primary/40 bg-primary/10 text-primary"
  if (kind === "meta") return "border-border bg-muted/60 text-muted-foreground"
  return "border-transparent"
}

function diffMarker(line: string) {
  if (line.startsWith("@@")) return "@@"
  if (line.startsWith("+") && !line.startsWith("+++")) return "+"
  if (line.startsWith("-") && !line.startsWith("---")) return "-"
  return ""
}

function diffLineContent(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++"))
    return ` ${line.slice(1)}`
  if (line.startsWith("-") && !line.startsWith("---"))
    return ` ${line.slice(1)}`
  return line
}
