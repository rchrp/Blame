import * as React from "react"
import { SourceCitation } from "@/components/chat/web-research/web-sources"

import { Checkbox } from "@/components/ui/checkbox"

import { MermaidDiagram } from "@/components/backlog/drawer/mermaid-diagram"

import { DevelopmentFileIcon } from "@/components/backlog/development/development-file-icon"

import {
  markdownPreviewBlocks,
  type MarkdownPreviewBlock,
} from "@/components/backlog/drawer/markdown-preview-parser"

import {
  type MarkdownInlineSegment,
  type MarkdownLine,
  type MarkdownTableCell,
} from "@/components/backlog/drawer/markdown-parser"

import { runWorkerTask, workerTaskAborted } from "@/lib/worker-task"

import { cn } from "@/lib/utils"

const markdownStreamRevealDurationMs = 500

type MarkdownStreamReveal = {
  end: number
  id: number
  start: number
}

export function markdownLineIndent(prefix: string) {
  return prefix.match(/^\s*/)?.[0].length ?? 0
}

export function MarkdownPreview({
  animateAppend,
  className,
  markdown,
  onFileLinkClick,
  onTaskToggle,
  placeholder,
}: {
  animateAppend?: boolean
  className?: string
  markdown: string
  onFileLinkClick?: (path: string) => void
  onTaskToggle?: (lineIndex: number, checked: boolean) => void
  placeholder: string
}) {
  const preview = useMarkdownPreviewBlocks(markdown, Boolean(animateAppend))
  const reveals = preview.reveals
  const sourceLines = preview.markdown.split("\n")
  const lineOffsets = markdownLineOffsets(sourceLines)
  if (!markdown.trim()) {
    return (
      <div
        className={cn(
          "text-[0.9375rem] text-muted-foreground/55 select-text dark:text-muted-foreground/50",
          className
        )}
      >
        {placeholder}
      </div>
    )
  }
  return (
    <div
      className={cn(
        "max-w-full min-w-0 space-y-2 overflow-x-hidden text-[0.9375rem] leading-6 [overflow-wrap:anywhere] select-text",
        className
      )}
    >
      {preview.blocks.map((block) => {
        const sourceStart = lineOffsets[block.lineIndex] ?? 0
        const blockReveal = markdownRevealAt(reveals, sourceStart)
        const contentReveals = blockReveal
          ? reveals.filter((reveal) => reveal.id !== blockReveal.id)
          : reveals
        return (
          <div
            className={cn(
              "max-w-full min-w-0",
              blockReveal && "markdown-stream-block-reveal"
            )}
            key={block.key}
          >
            {block.type === "code" ? (
              block.language === "mermaid" ? (
                <MermaidDiagram chart={block.code} />
              ) : (
                <MarkdownPreviewCode
                  code={block.code}
                  reveals={contentReveals}
                  sourceStart={lineOffsets[block.lineIndex + 1] ?? sourceStart}
                />
              )
            ) : block.type === "table" ? (
              <MarkdownPreviewTable
                header={block.header}
                lineIndex={block.lineIndex}
                lineOffsets={lineOffsets}
                reveals={contentReveals}
                rows={block.rows}
                sourceLines={sourceLines}
                onFileLinkClick={onFileLinkClick}
              />
            ) : (
              <MarkdownPreviewLine
                line={block.line}
                lineIndex={block.lineIndex}
                onFileLinkClick={onFileLinkClick}
                onTaskToggle={onTaskToggle}
                reveals={contentReveals}
                sourceStart={sourceStart + block.line.prefix.length}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function useMarkdownPreviewBlocks(markdown: string, animateAppend: boolean) {
  const [preview, setPreview] = React.useState<{
    blocks: MarkdownPreviewBlock[]
    enabled: boolean
    markdown: string
    nextRevealId: number
    reveals: MarkdownStreamReveal[]
  }>(() => ({
    blocks: markdown.trim() ? markdownPreviewBlocks(markdown) : [],
    enabled: animateAppend,
    markdown,
    nextRevealId: 2,
    reveals:
      animateAppend && markdown
        ? [{ end: markdown.length, id: 1, start: 0 }]
        : [],
  }))

  React.useEffect(() => {
    let active = true
    const controller = new AbortController()
    runWorkerTask<{ markdown: string }, MarkdownPreviewBlock[]>(
      new URL("./markdown-preview.worker.ts", import.meta.url),
      { markdown },
      controller.signal
    )
      .catch((error) => {
        if (workerTaskAborted(error)) return []
        return markdownPreviewBlocks(markdown)
      })
      .then((nextBlocks) => {
        if (!active) return
        setPreview((current) =>
          nextMarkdownPreviewState(current, markdown, animateAppend, nextBlocks)
        )
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [animateAppend, markdown])

  const latestRevealId = preview.reveals.at(-1)?.id
  React.useEffect(() => {
    if (latestRevealId === undefined) return
    const timer = window.setTimeout(() => {
      setPreview((current) =>
        current.reveals.at(-1)?.id === latestRevealId
          ? { ...current, reveals: [] }
          : current
      )
    }, markdownStreamRevealDurationMs)
    return () => window.clearTimeout(timer)
  }, [latestRevealId])

  return markdown.trim()
    ? preview
    : { ...preview, blocks: [], markdown: "", reveals: [] }
}

function nextMarkdownPreviewState(
  current: {
    blocks: MarkdownPreviewBlock[]
    enabled: boolean
    markdown: string
    nextRevealId: number
    reveals: MarkdownStreamReveal[]
  },
  markdown: string,
  animateAppend: boolean,
  blocks: MarkdownPreviewBlock[]
) {
  if (markdown === current.markdown && animateAppend === current.enabled) {
    return { ...current, blocks }
  }
  const appended =
    animateAppend &&
    current.enabled &&
    markdown.length > current.markdown.length &&
    markdown.startsWith(current.markdown)
  const reveals = appended
    ? [
        ...current.reveals,
        {
          end: markdown.length,
          id: current.nextRevealId,
          start: current.markdown.length,
        },
      ].slice(-12)
    : []
  return {
    blocks,
    enabled: animateAppend,
    markdown,
    nextRevealId: current.nextRevealId + (appended ? 1 : 0),
    reveals,
  }
}

function markdownRevealAt(
  reveals: MarkdownStreamReveal[],
  sourceOffset: number
) {
  return reveals.find(
    (reveal) => reveal.start <= sourceOffset && reveal.end > sourceOffset
  )
}

function markdownLineOffsets(lines: string[]) {
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  return offsets
}

function markdownTableCellOffsets(source: string, cells: MarkdownTableCell[]) {
  let cursor = 0
  return cells.map((cell) => {
    const index = source.indexOf(cell.source, cursor)
    const offset = index === -1 ? cursor : index
    cursor = offset + cell.source.length
    return offset
  })
}

function MarkdownPreviewTable({
  header,
  lineIndex,
  lineOffsets,
  onFileLinkClick,
  reveals,
  rows,
  sourceLines,
}: {
  header: MarkdownTableCell[]
  lineIndex: number
  lineOffsets: number[]
  onFileLinkClick?: (path: string) => void
  reveals: MarkdownStreamReveal[]
  rows: MarkdownTableCell[][]
  sourceLines: string[]
}) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="min-w-full border-collapse text-left text-sm">
        <MarkdownPreviewTableHeader
          cells={header}
          reveals={reveals}
          source={sourceLines[lineIndex] ?? ""}
          sourceStart={lineOffsets[lineIndex] ?? 0}
          onFileLinkClick={onFileLinkClick}
        />
        <tbody>
          {rows.map((row, index) => (
            <MarkdownPreviewTableRow
              key={index}
              cells={row}
              reveals={reveals}
              source={sourceLines[lineIndex + index + 2] ?? ""}
              sourceStart={lineOffsets[lineIndex + index + 2] ?? 0}
              onFileLinkClick={onFileLinkClick}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MarkdownPreviewTableHeader({
  cells,
  onFileLinkClick,
  reveals,
  source,
  sourceStart,
}: {
  cells: MarkdownTableCell[]
  onFileLinkClick?: (path: string) => void
  reveals: MarkdownStreamReveal[]
  source: string
  sourceStart: number
}) {
  const cellOffsets = markdownTableCellOffsets(source, cells)
  return (
    <thead>
      <tr>
        {cells.map((cell, index) => (
          <th
            key={index}
            className="border border-border bg-muted/50 px-2.5 py-1.5 font-semibold"
          >
            {inlineMarkdown(
              cell.segments,
              onFileLinkClick,
              reveals,
              sourceStart + (cellOffsets[index] ?? 0)
            )}
          </th>
        ))}
      </tr>
    </thead>
  )
}

function MarkdownPreviewTableRow({
  cells,
  onFileLinkClick,
  reveals,
  source,
  sourceStart,
}: {
  cells: MarkdownTableCell[]
  onFileLinkClick?: (path: string) => void
  reveals: MarkdownStreamReveal[]
  source: string
  sourceStart: number
}) {
  const cellOffsets = markdownTableCellOffsets(source, cells)
  return (
    <tr>
      {cells.map((cell, index) => (
        <td key={index} className="border border-border px-2.5 py-1.5">
          {inlineMarkdown(
            cell.segments,
            onFileLinkClick,
            reveals,
            sourceStart + (cellOffsets[index] ?? 0)
          )}
        </td>
      ))}
    </tr>
  )
}

function MarkdownPreviewCode({
  code,
  reveals,
  sourceStart,
}: {
  code: string
  reveals: MarkdownStreamReveal[]
  sourceStart: number
}) {
  return (
    <pre className="w-full max-w-full min-w-0 overflow-x-auto rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
      <code className="block w-max min-w-full">
        {animatedMarkdownText(code, sourceStart, reveals)}
      </code>
    </pre>
  )
}

type MarkdownPreviewLineProperties = {
  line: MarkdownLine
  lineIndex: number
  onFileLinkClick?: (path: string) => void
  onTaskToggle?: (lineIndex: number, checked: boolean) => void
  reveals: MarkdownStreamReveal[]
  sourceStart: number
}

function MarkdownPreviewLine({
  line,
  lineIndex,
  onFileLinkClick,
  onTaskToggle,
  reveals,
  sourceStart,
}: MarkdownPreviewLineProperties) {
  if (!markdownLineSource(line).trim()) return <div className="h-3" />
  if (line.kind === "horizontal-rule") return <hr className="border-border" />
  if (line.kind === "task")
    return (
      <MarkdownPreviewTaskLine
        line={line}
        lineIndex={lineIndex}
        onFileLinkClick={onFileLinkClick}
        onTaskToggle={onTaskToggle}
        reveals={reveals}
        sourceStart={sourceStart}
      />
    )
  if (line.kind.startsWith("heading-"))
    return (
      <MarkdownPreviewHeading
        level={Number(line.kind.slice("heading-".length))}
        segments={line.segments}
        onFileLinkClick={onFileLinkClick}
        reveals={reveals}
        sourceStart={sourceStart}
      />
    )
  if (line.kind === "quote") {
    return (
      <blockquote className="border-l-2 pl-3 text-muted-foreground">
        {inlineMarkdown(line.segments, onFileLinkClick, reveals, sourceStart)}
      </blockquote>
    )
  }
  if (line.kind === "ordered-list" || line.kind === "unordered-list")
    return (
      <MarkdownPreviewListLine
        line={line}
        onFileLinkClick={onFileLinkClick}
        reveals={reveals}
        sourceStart={sourceStart}
      />
    )
  return (
    <p>
      {inlineMarkdown(line.segments, onFileLinkClick, reveals, sourceStart)}
    </p>
  )
}

function MarkdownPreviewTaskLine({
  line,
  lineIndex,
  onFileLinkClick,
  onTaskToggle,
  reveals,
  sourceStart,
}: MarkdownPreviewLineProperties) {
  const checked = /- \[[xX]\]/.test(line.prefix)
  return (
    <label
      className="flex items-start gap-2 pl-1"
      style={markdownPreviewListIndentStyle(line)}
    >
      <Checkbox
        checked={checked}
        className="mt-1"
        disabled={!onTaskToggle}
        onCheckedChange={(value) => onTaskToggle?.(lineIndex, value === true)}
      />
      <span className={cn(checked && "line-through")}>
        {inlineMarkdown(line.segments, onFileLinkClick, reveals, sourceStart)}
      </span>
    </label>
  )
}

function MarkdownPreviewHeading({
  level,
  onFileLinkClick,
  reveals,
  segments,
  sourceStart,
}: {
  level: number
  onFileLinkClick?: (path: string) => void
  reveals: MarkdownStreamReveal[]
  segments: MarkdownInlineSegment[]
  sourceStart: number
}) {
  const content = inlineMarkdown(
    segments,
    onFileLinkClick,
    reveals,
    sourceStart
  )
  if (level === 1) return <h1 className="text-xl font-semibold">{content}</h1>
  if (level === 2) return <h2 className="text-lg font-semibold">{content}</h2>
  if (level === 3) return <h3 className="text-base font-semibold">{content}</h3>
  return <h4 className="font-semibold">{content}</h4>
}

function MarkdownPreviewListLine({
  line,
  onFileLinkClick,
  reveals,
  sourceStart,
}: {
  line: MarkdownLine
  onFileLinkClick?: (path: string) => void
  reveals: MarkdownStreamReveal[]
  sourceStart: number
}) {
  const marker = line.kind === "unordered-list" ? "•" : line.prefix.trim()
  return (
    <p
      className="relative pl-5 before:absolute before:left-1 before:text-muted-foreground before:content-[attr(data-list-marker)]"
      data-list-marker={marker}
      style={markdownPreviewListIndentStyle(line)}
    >
      {inlineMarkdown(line.segments, onFileLinkClick, reveals, sourceStart)}
    </p>
  )
}

function markdownPreviewListIndentStyle(line: MarkdownLine) {
  const depth = Math.floor(markdownLineIndent(line.prefix) / 2)
  return depth ? { marginInlineStart: `${depth * 1.25}rem` } : undefined
}

function markdownLineSource(line: MarkdownLine) {
  return `${line.prefix}${line.segments
    .map((segment) => segment.source)
    .join("")}`
}

function inlineMarkdown(
  segments: MarkdownInlineSegment[],
  onFileLinkClick: ((path: string) => void) | undefined,
  reveals: MarkdownStreamReveal[],
  sourceStart: number
) {
  let offset = sourceStart
  return segments.map((segment, index) => {
    const node = inlineMarkdownSegment(
      segment,
      index,
      onFileLinkClick,
      reveals,
      offset
    )
    offset += segment.source.length
    return node
  })
}

function inlineMarkdownSegment(
  segment: MarkdownInlineSegment,
  index: number,
  onFileLinkClick: ((path: string) => void) | undefined,
  reveals: MarkdownStreamReveal[],
  sourceStart: number
) {
  if (segment.type === "text")
    return (
      <React.Fragment key={index}>
        {animatedMarkdownText(segment.source, sourceStart, reveals)}
      </React.Fragment>
    )
  if (segment.type === "bold")
    return (
      <strong key={index}>
        {animatedMarkdownText(segment.content, sourceStart + 2, reveals)}
      </strong>
    )
  if (segment.type === "italic")
    return (
      <em key={index}>
        {animatedMarkdownText(segment.content, sourceStart + 1, reveals)}
      </em>
    )
  if (segment.type === "strike")
    return (
      <s key={index}>
        {animatedMarkdownText(segment.content, sourceStart + 2, reveals)}
      </s>
    )
  if (segment.type === "code") {
    return (
      <code
        key={index}
        className="rounded bg-muted px-1 py-0.5 text-xs break-all"
      >
        {animatedMarkdownText(segment.content, sourceStart + 1, reveals)}
      </code>
    )
  }
  return markdownLinkToken(
    segment.content,
    segment.href,
    index,
    onFileLinkClick,
    reveals,
    sourceStart + 1
  )
}

function markdownArrowText(value: string) {
  return value.replace(/=>|->/g, "➔")
}

function markdownLinkToken(
  label: string,
  href: string,
  index: number,
  onFileLinkClick: ((path: string) => void) | undefined,
  reveals: MarkdownStreamReveal[],
  sourceStart: number
) {
  const citation = href.match(/^#source-(web_[a-f0-9]{24})$/)
  if (citation)
    return <SourceCitation key={index} id={citation[1]!} label={label} />
  const fileLink = isFileLink(href)
  return (
    <a
      key={index}
      className="inline-flex items-center gap-1 text-blue-600 underline underline-offset-2 dark:text-blue-400"
      href={href}
      onClick={(event) => {
        if (!fileLink) return
        event.preventDefault()
        onFileLinkClick?.(href)
      }}
    >
      {fileLink && (
        <DevelopmentFileIcon
          className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400"
          mono
          node={{ path: href, type: "file" }}
        />
      )}
      {animatedMarkdownText(label, sourceStart, reveals)}
    </a>
  )
}

function animatedMarkdownText(
  value: string,
  sourceStart: number,
  reveals: MarkdownStreamReveal[]
) {
  const sourceEnd = sourceStart + value.length
  const activeReveals = reveals.filter(
    (reveal) => reveal.end > sourceStart && reveal.start < sourceEnd
  )
  if (!activeReveals.length) return markdownArrowText(value)

  const parts: React.ReactNode[] = []
  let offset = 0
  for (const reveal of activeReveals) {
    const revealStart = Math.max(0, reveal.start - sourceStart)
    const revealEnd = Math.min(value.length, reveal.end - sourceStart)
    if (revealStart > offset) {
      parts.push(
        <React.Fragment key={`plain-${sourceStart + offset}`}>
          {markdownArrowText(value.slice(offset, revealStart))}
        </React.Fragment>
      )
    }
    if (revealEnd > revealStart) {
      parts.push(
        <span
          className="markdown-stream-reveal"
          key={`reveal-${reveal.id}-${sourceStart + revealStart}`}
        >
          {markdownArrowText(value.slice(revealStart, revealEnd))}
        </span>
      )
    }
    offset = Math.max(offset, revealEnd)
  }
  if (offset < value.length) {
    parts.push(
      <React.Fragment key={`plain-${sourceStart + offset}`}>
        {markdownArrowText(value.slice(offset))}
      </React.Fragment>
    )
  }
  return parts
}

export function isFileLink(href: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return false
  if (href.startsWith("#") || href.startsWith("/")) return false
  return href.includes("/") || /\.[^./\s]+$/.test(href)
}
