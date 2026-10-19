import {
  BoldIcon,
  CodeIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  Heading2Icon,
  InfoIcon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  QuoteIcon,
  Redo2Icon,
  SparkleIcon,
  StrikethroughIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react"
import * as React from "react"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import { DevelopmentFileIcon } from "@/components/backlog/development/development-file-icon"
import { markdownHasInlineFormatting } from "@/components/backlog/drawer/markdown-parser"
import {
  markdownArrowNavigationResult,
  markdownAtomicLinkDeletionResult,
  markdownEmptyListDeletionResult,
  markdownExpandedDeletionSelection,
  markdownInlineActionResult,
  markdownListEnterResult,
  markdownListIndentResult,
  markdownWysiwygLines,
  markdownWysiwygStructureChanged,
  type MarkdownWysiwygLine,
  type MarkdownWysiwygSegment,
} from "@/components/backlog/drawer/markdown-wysiwyg-parser"
import { SpeechToTextControl } from "@/components/backlog/drawer/speech-to-text-provider"
import { fileAttachment } from "@/components/backlog/drawer/user-story-attachment-files"
import {
  codeSelectionLineLabel,
  type PendingCodeSelectionAttachment,
} from "@/components/backlog/shared/comment-attachment-events"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { usePlatform } from "@/context/platform"
import {
  recordPerformanceCount,
  recordPerformanceMetric,
} from "@/lib/performance-diagnostics"
import { useLatestCallback } from "@/lib/use-latest-callback"
import { cn } from "@/lib/utils"
import {
  isFileLink,
  markdownLineIndent,
  MarkdownPreview,
} from "./markdown-preview"

type PastedAttachment = {
  aiContextMarkdown?: string
  id: string
  file: File
  previewUrl?: string
  source: "code" | "file"
  storedAttachment?: UserStoryFileAttachment
  subtitle?: string
  title?: string
}

export type PendingFileAttachment = {
  aiContextMarkdown?: string
  file: File
  id: string
  previewUrl?: string
  storedAttachment?: UserStoryFileAttachment
}

type FileMentionState = {
  active: boolean
  query: string
  start: number
  end: number
}

type FileMentionResult = {
  path: string
  type: "directory" | "file"
}

const markdownStructureRenderDelayMs = 120

function fileAttachments(files: File[]) {
  return files.map((file) => ({
    id: crypto.randomUUID(),
    file,
    previewUrl: file.type.startsWith("image/")
      ? URL.createObjectURL(file)
      : undefined,
    source: "file" as const,
  }))
}

function pastedAttachments(event: React.ClipboardEvent<HTMLDivElement>) {
  return fileAttachments(
    Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
  )
}

function selectedAttachments(event: React.ChangeEvent<HTMLInputElement>) {
  return fileAttachments(
    Array.from(event.currentTarget.files ?? []).filter((file): file is File =>
      Boolean(file)
    )
  )
}

function draggedAttachments(event: React.DragEvent<HTMLDivElement>) {
  return fileAttachments(Array.from(event.dataTransfer.files))
}

function isFileDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("Files")
}

function aiContextAttachmentSupported(file: File) {
  return supportedAiContextAttachmentExtensions().some((extension) =>
    file.name.toLowerCase().endsWith(extension)
  )
}

function supportedAiContextAttachmentExtensions() {
  return [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"]
}

function fileMentionState(value: string, cursor: number): FileMentionState {
  const match = value.substring(0, cursor).match(/@(\S*)$/)
  return match
    ? {
        active: true,
        query: match[1] ?? "",
        start: match.index ?? cursor - match[0].length,
        end: cursor,
      }
    : { active: false, query: "", start: 0, end: cursor }
}

function markdownWithReplacement(
  value: string,
  start: number,
  end: number,
  replacement: string
) {
  return `${value.slice(0, start)}${replacement}${value.slice(end)}`
}

function markdownWithWrappedSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after = before
) {
  const selected = value.slice(start, end)
  return {
    cursor: start + before.length + selected.length,
    value: markdownWithReplacement(
      value,
      start,
      end,
      `${before}${selected}${after}`
    ),
  }
}

function markdownWithCodeSelection(value: string, start: number, end: number) {
  const selected = value.slice(start, end)
  if (!selected.includes("\n"))
    return markdownWithWrappedSelection(value, start, end, "`")
  const replacement = `\`\`\`\n${selected}\n\`\`\``
  return {
    cursor: start + replacement.length,
    value: markdownWithReplacement(value, start, end, replacement),
  }
}

function lineBounds(value: string, cursor: number) {
  const start = value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1
  const nextLine = value.indexOf("\n", cursor)
  return { start, end: nextLine === -1 ? value.length : nextLine }
}

function markdownWithLinePrefix(value: string, cursor: number, prefix: string) {
  const bounds = lineBounds(value, cursor)
  const line = value.slice(bounds.start, bounds.end)
  const nextLine = line.startsWith(prefix)
    ? line.slice(prefix.length)
    : `${prefix}${line}`
  return {
    cursor: cursor + nextLine.length - line.length,
    value: markdownWithReplacement(value, bounds.start, bounds.end, nextLine),
  }
}

function markdownWithTaskPrefix(value: string, cursor: number) {
  const bounds = lineBounds(value, cursor)
  const line = value.slice(bounds.start, bounds.end)
  const task = line.match(/^- \[([ xX])\] (.*)$/)
  const nextLine = task
    ? `- [${task[1] === " " ? "x" : " "}] ${task[2]}`
    : `- [ ] ${line}`
  return {
    cursor: cursor + nextLine.length - line.length,
    value: markdownWithReplacement(value, bounds.start, bounds.end, nextLine),
  }
}

function markdownActionResult(
  value: string,
  start: number,
  end: number,
  action: MarkdownAction
) {
  if (action === "heading") return markdownWithLinePrefix(value, start, "## ")
  if (action === "quote") return markdownWithLinePrefix(value, start, "> ")
  if (action === "unordered") return markdownWithLinePrefix(value, start, "- ")
  if (action === "ordered") return markdownWithLinePrefix(value, start, "1. ")
  if (action === "task") return markdownWithTaskPrefix(value, start)
  if (["bold", "italic", "link", "strike"].includes(action))
    return markdownInlineActionResult(
      value,
      start,
      end,
      action as "bold" | "italic" | "link" | "strike"
    )
  if (action === "code") return markdownWithCodeSelection(value, start, end)
  return markdownInlineActionResult(value, start, end, "link")
}

function filename(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized.split("/").at(-1) || normalized
}

function markdownFileLink(path: string) {
  return `[${filename(path)}](${path})`
}

function directoryName(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "")
  const index = normalized.lastIndexOf("/")
  return index === -1 ? "" : `${normalized.slice(0, index)}/`
}

function AttachmentDeleteButton({
  attachment,
  onRemove,
}: {
  attachment: PastedAttachment
  onRemove: (attachment: PastedAttachment) => void
}) {
  return (
    <Button
      type="button"
      aria-label={`Remove ${attachment.file.name}`}
      className="absolute -top-2 -right-2 size-6 opacity-0 shadow-sm group-hover:opacity-100 focus-visible:opacity-100"
      size="icon-xs"
      variant="destructive"
      onClick={() => onRemove(attachment)}
    >
      <Trash2Icon className="size-3" />
    </Button>
  )
}

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: PastedAttachment
  onRemove?: (attachment: PastedAttachment) => void
}) {
  if (attachment.previewUrl) {
    return (
      <ImageAttachmentPreview
        attachment={{ ...attachment, previewUrl: attachment.previewUrl }}
        onRemove={onRemove}
      />
    )
  }

  return <FileAttachmentPreview attachment={attachment} onRemove={onRemove} />
}

function ImageAttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: PastedAttachment & { previewUrl: string }
  onRemove?: (attachment: PastedAttachment) => void
}) {
  return (
    <div className="group relative">
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border bg-muted/30 transition-colors outline-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <img
              alt={attachment.file.name}
              className="h-full w-full object-cover"
              src={attachment.previewUrl}
            />
          </button>
        </DialogTrigger>
        <DialogContent className="max-w-[calc(100%-2rem)] p-2 sm:max-w-4xl">
          <DialogTitle className="sr-only">{attachment.file.name}</DialogTitle>
          <img
            alt={attachment.file.name}
            className="max-h-[80vh] w-full rounded-lg object-contain"
            src={attachment.previewUrl}
          />
        </DialogContent>
      </Dialog>
      {onRemove && (
        <AttachmentDeleteButton attachment={attachment} onRemove={onRemove} />
      )}
    </div>
  )
}

function FileAttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: PastedAttachment
  onRemove?: (attachment: PastedAttachment) => void
}) {
  return (
    <div className="group relative">
      <div className="flex h-16 w-16 items-center justify-center rounded-md border bg-muted/30 px-2 text-center text-[0.625rem] leading-tight text-muted-foreground">
        <span className="line-clamp-3 break-all">
          {attachment.title ?? attachment.file.name}
          {attachment.subtitle && (
            <span className="mt-1 block text-[0.55rem] text-muted-foreground/80">
              {attachment.subtitle}
            </span>
          )}
        </span>
      </div>
      {onRemove && (
        <AttachmentDeleteButton attachment={attachment} onRemove={onRemove} />
      )}
    </div>
  )
}

type MarkdownAction =
  | "bold"
  | "code"
  | "heading"
  | "italic"
  | "link"
  | "ordered"
  | "quote"
  | "strike"
  | "task"
  | "unordered"

const markdownActions: {
  action: MarkdownAction
  icon: React.ComponentType<{ className?: string }>
  label: string
}[] = [
  { action: "heading", icon: Heading2Icon, label: "Heading" },
  { action: "bold", icon: BoldIcon, label: "Bold" },
  { action: "italic", icon: ItalicIcon, label: "Italic" },
  { action: "strike", icon: StrikethroughIcon, label: "Strikethrough" },
  { action: "code", icon: CodeIcon, label: "Inline code" },
  { action: "link", icon: LinkIcon, label: "Link" },
  { action: "quote", icon: QuoteIcon, label: "Quote" },
  { action: "unordered", icon: ListIcon, label: "Bullet list" },
  { action: "ordered", icon: ListOrderedIcon, label: "Numbered list" },
  { action: "task", icon: ListChecksIcon, label: "Task list" },
]

const visibleMarkdownActions = markdownActions.filter(({ action }) =>
  ["bold", "italic", "code", "link"].includes(action)
)

const additionalMarkdownActions = markdownActions.filter(
  ({ action }) => !visibleMarkdownActions.some((item) => item.action === action)
)

const MarkdownToolbar = React.memo(function MarkdownToolbar({
  disabled,
  onAction,
  onActionIntent,
  onRedo,
  onUndo,
}: {
  disabled?: boolean
  onAction: (action: MarkdownAction) => void
  onActionIntent: () => void
  onRedo: () => void
  onUndo: () => void
}) {
  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-0.5">
        <ToolbarIconButton disabled={disabled} label="Undo" onClick={onUndo}>
          <Undo2Icon className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton disabled={disabled} label="Redo" onClick={onRedo}>
          <Redo2Icon className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarSeparator />
        {visibleMarkdownActions.map(({ action, icon: Icon, label }) => (
          <ToolbarIconButton
            key={action}
            disabled={disabled}
            label={label}
            onClick={() => onAction(action)}
          >
            <Icon className="size-3.5" />
          </ToolbarIconButton>
        ))}
        <AdditionalMarkdownActions
          disabled={disabled}
          onAction={onAction}
          onActionIntent={onActionIntent}
        />
      </div>
    </TooltipProvider>
  )
})

const MarkdownOptimizeButton = React.memo(function MarkdownOptimizeButton({
  disabled,
  onOptimize,
  optimizing,
}: {
  disabled?: boolean
  onOptimize: () => void
  optimizing?: boolean
}) {
  return (
    <TooltipProvider>
      <Tooltip delayDuration={1000}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            aria-label="Enhance with AI"
            className="h-8 gap-1.5 rounded-xl border-transparent bg-transparent px-2.5 text-[11px] font-semibold text-foreground shadow-[0_0_0_1px_oklch(0.7_0.17_250_/_0.12),0_0_8px_oklch(0.65_0.2_250_/_0.12)] ring-1 ring-foreground/20 transition-[filter] duration-150 hover:brightness-105 focus-visible:ring-2 focus-visible:ring-sky-300/80 active:translate-y-0"
            disabled={disabled}
            onClick={onOptimize}
            style={{
              background:
                "linear-gradient(color-mix(in oklch, var(--muted) 68%, var(--background)), color-mix(in oklch, var(--muted) 68%, var(--background))) padding-box, linear-gradient(135deg, oklch(0.8 0.16 240 / 52%), oklch(0.7 0.21 245 / 52%), oklch(0.62 0.22 255 / 42%)) border-box",
              backgroundClip: "padding-box, border-box",
            }}
          >
            {optimizing ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <SparkleIcon className="size-3.5" />
            )}
            Enhance
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>
          Transform this user story into a clearer, structured prompt.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})

function AdditionalMarkdownActions({
  disabled,
  onActionIntent,
  onAction,
}: {
  disabled?: boolean
  onActionIntent: () => void
  onAction: (action: MarkdownAction) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          aria-label="More formatting"
          className="text-muted-foreground hover:text-foreground"
          disabled={disabled}
          size="icon-sm"
          variant="ghost"
          onPointerDown={onActionIntent}
        >
          <EllipsisIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-44"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {additionalMarkdownActions.map(({ action, icon: Icon, label }) => (
          <DropdownMenuItem key={action} onSelect={() => onAction(action)}>
            <Icon className="size-3.5 text-muted-foreground" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ToolbarSeparator() {
  return (
    <Separator className="mx-1.5 h-4 !self-center" orientation="vertical" />
  )
}

function ToolbarIconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode
  disabled?: boolean
  label: string
  onClick?: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          aria-label={label}
          className="text-muted-foreground hover:text-foreground"
          disabled={disabled || !onClick}
          size="icon-sm"
          variant="ghost"
          onClick={onClick}
          onPointerDown={(event) => event.preventDefault()}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  )
}

type MarkdownSelection = { end: number; start: number }

function MarkdownWysiwygEditor({
  activeSelection,
  className,
  editorRef,
  markdown,
  onFileLinkClick,
  onInput,
  onKeyDown,
  onSelectionChange,
  placeholder,
  renderKey,
}: {
  activeSelection: MarkdownSelection | null
  className?: string
  editorRef: React.RefCallback<HTMLDivElement>
  markdown: string
  onFileLinkClick?: (path: string) => void
  onInput: (event: React.FormEvent<HTMLDivElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onSelectionChange: () => void
  placeholder: string
  renderKey: string
}) {
  const activeSegmentKey = markdownActiveSegmentKey(markdown, activeSelection)
  return (
    <div className="relative">
      {!markdown && (
        <div className="pointer-events-none absolute inset-x-4 top-3.5 text-[0.9375rem] text-muted-foreground/55 dark:text-muted-foreground/50">
          {placeholder}
        </div>
      )}
      <div
        key={`${renderKey}:${activeSegmentKey}`}
        ref={editorRef}
        aria-label={placeholder}
        className={cn(
          "max-w-full min-w-0 space-y-2 overflow-x-hidden text-[0.9375rem] leading-6 [overflow-wrap:anywhere] outline-none",
          className
        )}
        contentEditable
        data-markdown-editor-input="true"
        role="textbox"
        suppressContentEditableWarning
        onClick={onSelectionChange}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onKeyUp={onSelectionChange}
      >
        <MarkdownWysiwygEditorContent
          activeSegmentKey={activeSegmentKey}
          activeSelection={activeSelection}
          markdown={markdown}
          onFileLinkClick={onFileLinkClick}
        />
      </div>
    </div>
  )
}

const MarkdownWysiwygEditorContent = React.memo(
  function MarkdownWysiwygEditorContent(properties: {
    activeSegmentKey: string
    activeSelection: MarkdownSelection | null
    markdown: string
    onFileLinkClick?: (path: string) => void
  }) {
    const { activeSelection, markdown, onFileLinkClick } = properties
    return markdownWysiwygLinesWithStarts(markdown).map(
      ({ line, start }, index) => (
        <MarkdownWysiwygEditorLine
          key={index}
          line={line}
          lineStart={start}
          onFileLinkClick={onFileLinkClick}
          selection={activeSelection}
        />
      )
    )
  },
  (current, next) => current.activeSegmentKey === next.activeSegmentKey
)

function MarkdownWysiwygEditorLine({
  line,
  lineStart,
  onFileLinkClick,
  selection,
}: {
  line: MarkdownWysiwygLine
  lineStart: number
  onFileLinkClick?: (path: string) => void
  selection: MarkdownSelection | null
}) {
  const segments = markdownSegmentsWithStarts(line, lineStart)
  const listMarker = markdownWysiwygListMarker(line)
  const listDepth = listMarker
    ? Math.floor(markdownLineIndent(line.prefix) / 2)
    : 0
  const className = cn(
    "relative min-h-6 whitespace-pre-wrap",
    line.kind === "heading-1" && "text-xl font-semibold",
    line.kind === "heading-2" && "text-lg font-semibold",
    line.kind.startsWith("heading-") &&
      !["heading-1", "heading-2"].includes(line.kind) &&
      "font-semibold",
    line.kind === "quote" && "border-l-2 pl-3 text-muted-foreground",
    listMarker &&
      "pl-5 before:absolute before:left-1 before:text-muted-foreground before:content-[attr(data-list-marker)]",
    line.kind === "code" && "bg-muted/50 font-mono text-xs",
    line.kind === "fence" && "font-mono text-xs text-muted-foreground"
  )
  return (
    <div
      className={className}
      data-list-marker={listMarker || undefined}
      data-markdown-line="true"
      style={
        listDepth ? { marginInlineStart: `${listDepth * 1.25}rem` } : undefined
      }
    >
      {line.prefix && <MarkdownSourceMarker source={line.prefix} />}
      {segments.map(({ segment, start }, index) => {
        return (
          <MarkdownWysiwygEditorSegment
            key={index}
            active={markdownSelectionInsideSource(
              selection,
              start,
              segment.source.length
            )}
            onFileLinkClick={onFileLinkClick}
            segment={segment}
          />
        )
      })}
      {line.segments.every((segment) => !segment.source) && <br />}
    </div>
  )
}

function markdownSegmentsWithStarts(
  line: MarkdownWysiwygLine,
  lineStart: number
) {
  let start = lineStart + line.prefix.length
  return line.segments.map((segment) => {
    const entry = { segment, start }
    start += segment.source.length
    return entry
  })
}

function markdownWysiwygLinesWithStarts(markdown: string) {
  let start = 0
  return markdownWysiwygLines(markdown).map((line) => {
    const entry = { line, start }
    start +=
      line.prefix.length +
      line.segments.reduce(
        (length, segment) => length + segment.source.length,
        0
      ) +
      1
    return entry
  })
}

function markdownActiveSegmentKey(
  markdown: string,
  selection: MarkdownSelection | null
) {
  if (!selection || selection.start !== selection.end) return ""
  const bounds = lineBounds(markdown, selection.start)
  const sourceLine = markdown.slice(bounds.start, bounds.end)
  if (!markdownHasInlineFormatting(sourceLine)) return ""
  const line = markdownWysiwygLines(sourceLine)[0]
  for (const { segment, start } of markdownSegmentsWithStarts(
    line,
    bounds.start
  )) {
    if (
      segment.type !== "text" &&
      markdownSelectionInsideSource(selection, start, segment.source.length)
    )
      return `${start}:${segment.type}`
  }
  return ""
}

function markdownSelectionInsideSource(
  selection: MarkdownSelection | null,
  start: number,
  length: number
) {
  if (!selection || selection.start !== selection.end || length === 0)
    return false
  return selection.start > start && selection.start < start + length
}

function markdownWysiwygListMarker(line: MarkdownWysiwygLine) {
  if (line.kind === "unordered-list") return "•"
  if (line.kind === "ordered-list") return line.prefix.trim()
  if (line.kind === "task") return /- \[[xX]\]/.test(line.prefix) ? "☑" : "☐"
  return ""
}

function MarkdownWysiwygEditorSegment({
  active,
  onFileLinkClick,
  segment,
}: {
  active: boolean
  onFileLinkClick?: (path: string) => void
  segment: MarkdownWysiwygSegment
}) {
  if (segment.type === "text" || active) return segment.source
  const content = (
    <>
      <MarkdownSourceMarker source={openingMarkdownMarker(segment)} />
      {segment.content}
      <MarkdownSourceMarker closing source={closingMarkdownMarker(segment)} />
    </>
  )
  if (segment.type === "bold") return <strong>{content}</strong>
  if (segment.type === "italic") return <em>{content}</em>
  if (segment.type === "strike") return <s>{content}</s>
  if (segment.type === "code")
    return (
      <code className="rounded bg-muted px-1 py-0.5 text-xs">{content}</code>
    )
  return (
    <MarkdownWysiwygLinkSegment
      content={content}
      onFileLinkClick={onFileLinkClick}
      segment={segment}
    />
  )
}

function MarkdownWysiwygLinkSegment({
  content,
  onFileLinkClick,
  segment,
}: {
  content: React.ReactNode
  onFileLinkClick?: (path: string) => void
  segment: Extract<MarkdownWysiwygSegment, { type: "link" }>
}) {
  return (
    <span className="text-blue-600 underline underline-offset-2 dark:text-blue-400">
      {isFileLink(segment.href) && (
        <MarkdownWysiwygFileLinkButton
          href={segment.href}
          onFileLinkClick={onFileLinkClick}
        />
      )}
      {content}
    </span>
  )
}

function MarkdownWysiwygFileLinkButton({
  href,
  onFileLinkClick,
}: {
  href: string
  onFileLinkClick?: (path: string) => void
}) {
  return (
    <button
      type="button"
      aria-label={`Open ${filename(href)}`}
      className="mr-1 inline-flex align-text-bottom"
      contentEditable={false}
      onClick={() => onFileLinkClick?.(href)}
      onPointerDown={(event) => event.preventDefault()}
    >
      <DevelopmentFileIcon
        className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400"
        mono
        node={{ path: href, type: "file" }}
      />
    </button>
  )
}

function MarkdownSourceMarker({
  closing,
  source,
}: {
  closing?: boolean
  source: string
}) {
  return (
    <span
      className="absolute h-0 w-0 overflow-hidden text-[0px] leading-none"
      data-markdown-closing={closing || undefined}
      data-markdown-source="true"
    >
      {source}
    </span>
  )
}

function openingMarkdownMarker(
  segment: Exclude<MarkdownWysiwygSegment, { type: "text" }>
) {
  if (segment.type === "bold") return "**"
  if (segment.type === "italic") return "*"
  if (segment.type === "strike") return "~~"
  if (segment.type === "code") return "`"
  return "["
}

function closingMarkdownMarker(
  segment: Exclude<MarkdownWysiwygSegment, { type: "text" }>
) {
  if (segment.type === "bold") return "**"
  if (segment.type === "italic") return "*"
  if (segment.type === "strike") return "~~"
  if (segment.type === "code") return "`"
  return `](${"href" in segment ? segment.href : ""})`
}

function markdownEditorSelection(
  editor: HTMLDivElement
): MarkdownSelection | undefined {
  return markdownSelectionFromSnapshot(
    editor,
    markdownEditorDomSnapshot(editor)
  )
}

function markdownEditorSnapshot(editor: HTMLDivElement) {
  const dom = markdownEditorDomSnapshot(editor)
  return {
    selection: markdownSelectionFromSnapshot(editor, dom),
    value: dom.lineValues.join("\n"),
  }
}

function markdownEditorDomSnapshot(editor: HTMLDivElement) {
  const lines = Array.from(editor.children)
  const lineValues = lines.map((line) => line.textContent ?? "")
  const lineStarts: number[] = []
  let start = 0
  lineValues.forEach((value) => {
    lineStarts.push(start)
    start += value.length + 1
  })
  return { lines, lineStarts, lineValues }
}

function markdownSelectionFromSnapshot(
  editor: HTMLDivElement,
  dom: ReturnType<typeof markdownEditorDomSnapshot>
) {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return
  const range = selection.getRangeAt(0)
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return
  const start = markdownEditorOffset(
    editor,
    dom,
    range.startContainer,
    range.startOffset
  )
  if (range.collapsed) return { start, end: start }
  return {
    start,
    end: markdownEditorOffset(editor, dom, range.endContainer, range.endOffset),
  }
}

function markdownEditorOffset(
  editor: HTMLDivElement,
  dom: ReturnType<typeof markdownEditorDomSnapshot>,
  node: Node,
  offset: number
) {
  if (node === editor) {
    return editorBoundaryOffset(dom.lineValues, offset)
  }
  const lineIndex = dom.lines.findIndex(
    (line) => line === node || line.contains(node)
  )
  if (lineIndex === -1) return 0
  return (
    dom.lineStarts[lineIndex] +
    markdownOffsetWithinLine(dom.lines[lineIndex], node, offset)
  )
}

function editorBoundaryOffset(lineValues: string[], offset: number) {
  return lineValues
    .slice(0, offset)
    .reduce(
      (length, value, index) => length + value.length + (index > 0 ? 1 : 0),
      0
    )
}

function markdownOffsetWithinLine(
  line: Element,
  target: Node,
  targetOffset: number
) {
  let offset = markdownNodeBoundaryLength(target, targetOffset)
  let node = target
  while (node !== line) {
    const parent = node.parentNode
    if (!parent) return 0
    for (const sibling of parent.childNodes) {
      if (sibling === node) break
      offset += markdownNodeSourceLength(sibling)
    }
    node = parent
  }
  return offset
}

function markdownNodeBoundaryLength(node: Node, offset: number) {
  if (node.nodeType === Node.TEXT_NODE) {
    return Math.max(0, Math.min(offset, markdownNodeSourceLength(node)))
  }
  return Array.from(node.childNodes)
    .slice(0, Math.max(0, Math.min(offset, node.childNodes.length)))
    .reduce((length, child) => length + markdownNodeSourceLength(child), 0)
}

function markdownNodeSourceLength(node: Node) {
  if (node instanceof HTMLElement && node.contentEditable === "false") return 0
  return node.textContent?.length ?? 0
}

function restoreMarkdownEditorSelection(
  editor: HTMLDivElement,
  selection: MarkdownSelection
) {
  const start = markdownEditorDomPoint(editor, selection.start)
  const end = markdownEditorDomPoint(editor, selection.end)
  const range = document.createRange()
  setMarkdownRangeBoundary(range, "start", start)
  setMarkdownRangeBoundary(range, "end", end)
  const browserSelection = window.getSelection()
  browserSelection?.removeAllRanges()
  browserSelection?.addRange(range)
  editor.focus({ preventScroll: true })
}

function setMarkdownRangeBoundary(
  range: Range,
  boundary: "end" | "start",
  point: { node: Node; offset: number }
) {
  const maximum =
    point.node.nodeType === Node.TEXT_NODE
      ? (point.node.textContent?.length ?? 0)
      : point.node.childNodes.length
  const offset = Math.max(0, Math.min(point.offset, maximum))
  if (boundary === "start") range.setStart(point.node, offset)
  else range.setEnd(point.node, offset)
}

function markdownEditorDomPoint(editor: HTMLDivElement, target: number) {
  const lines = Array.from(editor.children)
  let remaining = target
  let lastNode: Node = editor
  let lastVisibleNode: Node | undefined
  for (const [lineIndex, line] of lines.entries()) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    if (!node && remaining === 0) return { node: line, offset: 0 }
    while (node) {
      const length = node.textContent?.length ?? 0
      if (node.parentElement?.dataset.markdownSource === "true") {
        if (
          remaining === 0 &&
          node.parentElement.dataset.markdownClosing !== "true"
        ) {
          return markdownEditorPointBefore(
            node.parentElement.parentElement ?? node.parentElement
          )
        }
        if (remaining < length)
          return markdownEditorPointAfter(node.parentElement)
        if (remaining === length) {
          return node.parentElement.dataset.markdownClosing === "true"
            ? markdownEditorPointAfter(
                node.parentElement.parentElement ?? node.parentElement
              )
            : markdownEditorPointAfter(node.parentElement)
        }
        remaining -= length
        lastNode = node
        node = walker.nextNode()
        continue
      }
      if (remaining <= length) return { node, offset: remaining }
      remaining -= length
      lastNode = node
      lastVisibleNode = node
      node = walker.nextNode()
    }
    if (lineIndex < lines.length - 1) {
      if (remaining === 0) return { node: line, offset: line.childNodes.length }
      remaining -= 1
    }
  }
  const fallbackNode = lastVisibleNode ?? lastNode
  return { node: fallbackNode, offset: fallbackNode.textContent?.length ?? 0 }
}

function markdownEditorPointBefore(node: Node) {
  const parent = node.parentNode
  if (!parent) return { node, offset: 0 }
  return {
    node: parent,
    offset: Array.prototype.indexOf.call(parent.childNodes, node),
  }
}

function markdownEditorPointAfter(node: Node) {
  const parent = node.parentNode
  if (!parent) return { node, offset: node.textContent?.length ?? 0 }
  return {
    node: parent,
    offset: Array.prototype.indexOf.call(parent.childNodes, node) + 1,
  }
}

export const MarkdownEditor = React.forwardRef<
  HTMLDivElement,
  {
    animateAppend?: boolean
    speechSessionKey?: string
    appearance?: "bubble" | "subtle"
    markdown: string
    maxHeight?: string
    minHeight: string
    placeholder: string
    codeSelectionAttachments?: PendingCodeSelectionAttachment[]
    fileAttachments?: PendingFileAttachment[]
    mentionDirectory?: string
    onCodeSelectionAttachmentRemove?: (id: string) => void
    onFileAttachmentRemove?: (id: string) => void
    onFileAttachmentsAdd?: (attachments: UserStoryFileAttachment[]) => void
    onFileLinkClick?: (path: string) => void
    onMarkdownChange?: (markdown: string) => void
    onOptimize?: (markdown: string) => Promise<string>
    onSubmitShortcut?: () => void
    primaryAction?: React.ReactNode
    readOnly?: boolean
    toolbarEnd?: React.ReactNode
  }
>(function MarkdownEditor(
  {
    animateAppend,
    appearance = "bubble",
    speechSessionKey,
    codeSelectionAttachments,
    fileAttachments,
    markdown,
    maxHeight,
    mentionDirectory,
    minHeight,
    onCodeSelectionAttachmentRemove,
    onFileAttachmentRemove,
    onFileAttachmentsAdd,
    onFileLinkClick,
    onMarkdownChange,
    onOptimize,
    onSubmitShortcut,
    primaryAction,
    placeholder,
    readOnly,
    toolbarEnd,
  },
  ref
) {
  const platform = usePlatform()
  const [attachments, setAttachments] = React.useState<PastedAttachment[]>([])
  const [mention, setMention] = React.useState<FileMentionState>({
    active: false,
    query: "",
    start: 0,
    end: 0,
  })
  const [mentionResults, setMentionResults] = React.useState<
    FileMentionResult[]
  >([])
  const [activeMentionIndex, setActiveMentionIndex] = React.useState(0)
  const attachmentsRef = React.useRef<PastedAttachment[]>([])
  const fileDragDepthRef = React.useRef(0)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const handledCodeSelectionIdsRef = React.useRef(new Set<string>())
  const handledFileAttachmentIdsRef = React.useRef(new Set<string>())
  const mentionSearchRef = React.useRef(0)
  const lastSelectionRef = React.useRef<MarkdownSelection | null>(null)
  const pendingSelectionRef = React.useRef<MarkdownSelection | null>(null)
  const lastEmittedMarkdownRef = React.useRef(markdown)
  const markdownPropRef = React.useRef(markdown)
  const currentValueRef = React.useRef(markdown)
  const speechInsertionSelectionRef = React.useRef<MarkdownSelection | null>(
    null
  )
  const activeSegmentKeyRef = React.useRef("")
  const editorRenderVersionRef = React.useRef(0)
  const structureRenderTimerRef = React.useRef<number | undefined>(undefined)
  const structureRenderPendingRef = React.useRef(false)
  const activeMentionItemRef = React.useRef<HTMLDivElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const editorRef = React.useRef<HTMLDivElement>(null)
  const editorScrollTopRef = React.useRef(0)
  const [draft, setDraft] = React.useState({
    external: markdown,
    value: markdown,
  })
  const [activeSelection, setActiveSelection] =
    React.useState<MarkdownSelection | null>(null)
  const [optimizing, setOptimizing] = React.useState(false)
  const [optimizingAttachments, setOptimizingAttachments] =
    React.useState(false)
  const [fileDropActive, setFileDropActive] = React.useState(false)
  const [optimizeAttachmentsForAiContext, setOptimizeAttachmentsForAiContext] =
    React.useState(true)
  const setEditorElement = React.useCallback(
    (element: HTMLDivElement | null) => {
      const currentEditor = editorRef.current
      if (currentEditor && currentEditor !== element)
        editorScrollTopRef.current = currentEditor.scrollTop
      editorRef.current = element
      if (element) element.scrollTop = editorScrollTopRef.current
    },
    []
  )
  const value = readOnly
    ? markdown
    : draft.external === markdown
      ? draft.value
      : markdown
  if (markdownPropRef.current !== markdown) {
    if (lastEmittedMarkdownRef.current !== markdown)
      editorRenderVersionRef.current += 1
    markdownPropRef.current = markdown
    currentValueRef.current = markdown
  }
  currentValueRef.current = value
  const editorRenderKey = String(editorRenderVersionRef.current)
  const mentionOpen =
    mention.active && Boolean(mentionDirectory && platform.workspace)
  const optimizableAttachmentsVisible = attachments.some(
    (attachment) =>
      attachment.source === "file" &&
      aiContextAttachmentSupported(attachment.file)
  )

  React.useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  React.useEffect(() => {
    if (!mentionOpen) return

    const search = ++mentionSearchRef.current
    const timer = setTimeout(async () => {
      try {
        if (search !== mentionSearchRef.current) return
        if (!mentionDirectory || !platform.workspace) return
        const results = await platform.workspace.searchFiles({
          root: mentionDirectory,
          query: mention.query,
          limit: 100,
        })
        if (search !== mentionSearchRef.current) return
        setMentionResults(results)
        setActiveMentionIndex(0)
      } catch {
        if (search !== mentionSearchRef.current) return
        setMentionResults([])
        setActiveMentionIndex(0)
      }
    }, 80)

    return () => clearTimeout(timer)
  }, [mention.query, mentionDirectory, mentionOpen, platform.workspace])

  React.useEffect(() => {
    if (mentionOpen) return
    mentionSearchRef.current += 1
  }, [mentionOpen])

  React.useEffect(() => {
    activeMentionItemRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeMentionIndex, mentionResults.length])

  React.useEffect(
    () => () => {
      attachmentsRef.current.forEach((attachment) => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
      })
    },
    []
  )

  React.useLayoutEffect(() => {
    const selection = pendingSelectionRef.current
    const editor = editorRef.current
    if (selection === null || !editor) return
    pendingSelectionRef.current = null
    restoreMarkdownEditorSelection(editor, selection)
    editor.scrollTop = editorScrollTopRef.current
    lastSelectionRef.current = selection
    activeSegmentKeyRef.current = markdownActiveSegmentKey(
      currentValueRef.current,
      selection
    )
    setActiveSelection((current) =>
      equalMarkdownSelection(current, selection) ? current : selection
    )
  }, [activeSelection, editorRenderKey, value])

  function updateActiveSelection(
    selection: MarkdownSelection,
    nextValue = currentValueRef.current
  ) {
    const nextKey = markdownActiveSegmentKey(nextValue, selection)
    if (activeSegmentKeyRef.current === nextKey) return
    activeSegmentKeyRef.current = nextKey
    pendingSelectionRef.current = selection
    setActiveSelection(selection)
  }

  const updateMention = React.useCallback(
    (
      nextValue = currentValueRef.current,
      nextSelection?: MarkdownSelection
    ) => {
      const editor = editorRef.current
      const selection =
        nextSelection ?? (editor && markdownEditorSelection(editor))
      if (!editor || !selection || readOnly || !mentionDirectory) {
        setMention((current) =>
          current.active
            ? { active: false, query: "", start: 0, end: 0 }
            : current
        )
        return
      }
      const nextMention = fileMentionState(nextValue, selection.start)
      setMention((current) =>
        equalFileMentionState(current, nextMention) ? current : nextMention
      )
    },
    [mentionDirectory, readOnly]
  )

  const scheduleMarkdownStructureRender = React.useCallback(() => {
    structureRenderPendingRef.current = true
    window.clearTimeout(structureRenderTimerRef.current)
    structureRenderTimerRef.current = window.setTimeout(() => {
      structureRenderPendingRef.current = false
      editorRenderVersionRef.current += 1
      pendingSelectionRef.current = lastSelectionRef.current
      setDraft((current) => ({ ...current }))
    }, markdownStructureRenderDelayMs)
  }, [])

  const cancelMarkdownStructureRender = React.useCallback(() => {
    structureRenderPendingRef.current = false
    window.clearTimeout(structureRenderTimerRef.current)
  }, [])

  const emitMarkdown = React.useCallback(
    (nextMarkdown: string, cursor?: number, selection?: MarkdownSelection) => {
      const structureStartedAt = performance.now()
      const structureChanged =
        !selection ||
        markdownWysiwygStructureChanged(currentValueRef.current, nextMarkdown)
      recordPerformanceMetric(
        "markdown.input.structure_duration_ms",
        performance.now() - structureStartedAt
      )
      lastEmittedMarkdownRef.current = nextMarkdown
      currentValueRef.current = nextMarkdown
      if (selection) {
        if (structureChanged || structureRenderPendingRef.current)
          scheduleMarkdownStructureRender()
      } else {
        cancelMarkdownStructureRender()
        if (structureChanged) editorRenderVersionRef.current += 1
      }
      setDraft({
        external: markdownPropRef.current,
        value: nextMarkdown,
      })
      onMarkdownChange?.(nextMarkdown)
      if (cursor !== undefined)
        pendingSelectionRef.current = { end: cursor, start: cursor }
      if (selection) {
        updateMention(nextMarkdown, selection)
        return
      }
      requestAnimationFrame(() => updateMention(nextMarkdown))
    },
    [
      cancelMarkdownStructureRender,
      onMarkdownChange,
      scheduleMarkdownStructureRender,
      updateMention,
    ]
  )

  React.useEffect(
    () => () => window.clearTimeout(structureRenderTimerRef.current),
    []
  )

  React.useEffect(() => {
    const nextAttachments = (codeSelectionAttachments ?? []).filter(
      (attachment) => !handledCodeSelectionIdsRef.current.has(attachment.id)
    )
    if (nextAttachments.length === 0) return
    codeSelectionAttachments?.forEach((attachment) => {
      handledCodeSelectionIdsRef.current.add(attachment.id)
    })
    addAttachments(nextAttachments.map(codeSelectionAttachment))
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [codeSelectionAttachments])

  React.useEffect(() => {
    const nextAttachments = (fileAttachments ?? [])
      .filter(
        (attachment) => !handledFileAttachmentIdsRef.current.has(attachment.id)
      )
      .map(pendingFileAttachment)
    if (nextAttachments.length === 0) return
    fileAttachments?.forEach((attachment) => {
      handledFileAttachmentIdsRef.current.add(attachment.id)
    })
    addAttachments(nextAttachments)
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [fileAttachments])

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!mentionOpen) return
    if (event.key === "Escape") {
      closeMention()
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key === "ArrowDown") {
      setActiveMentionIndex((index) =>
        mentionResults.length === 0 ? 0 : (index + 1) % mentionResults.length
      )
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key === "ArrowUp") {
      setActiveMentionIndex((index) =>
        mentionResults.length === 0
          ? 0
          : (index - 1 + mentionResults.length) % mentionResults.length
      )
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key === "Enter" || event.key === "Tab") {
      selectMention(mentionResults[activeMentionIndex])
      event.preventDefault()
      event.stopPropagation()
    }
  }

  function closeMention() {
    setMention({ active: false, query: "", start: 0, end: 0 })
    setMentionResults([])
    setActiveMentionIndex(0)
  }

  function selectMention(result?: FileMentionResult) {
    if (!result) return
    const insertedPath =
      result.type === "file"
        ? `${markdownFileLink(result.path)} `
        : `${result.path} `
    const nextMarkdown = markdownWithReplacement(
      value,
      mention.start,
      mention.end,
      insertedPath
    )
    closeMention()
    emitMarkdown(nextMarkdown, mention.start + insertedPath.length)
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    if (readOnly) return
    const nextAttachments = pastedAttachments(event)
    if (nextAttachments.length > 0) {
      event.preventDefault()
      void addFileAttachments(nextAttachments)
      return
    }
    const editor = editorRef.current
    const selection = editor && markdownEditorSelection(editor)
    if (!editor || !selection) return
    const pastedMarkdown = event.clipboardData.getData("text/plain")
    if (!pastedMarkdown) return
    event.preventDefault()
    const normalizedMarkdown = pastedMarkdown.replace(/\r\n?/g, "\n")
    emitMarkdown(
      markdownWithReplacement(
        value,
        selection.start,
        selection.end,
        normalizedMarkdown
      ),
      selection.start + normalizedMarkdown.length
    )
  }

  function handleFileSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const nextAttachments = selectedAttachments(event)
    event.currentTarget.value = ""
    if (nextAttachments.length === 0) return
    void addFileAttachments(nextAttachments)
  }

  function handleFileDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (readOnly || !isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    fileDragDepthRef.current += 1
    setFileDropActive(true)
  }

  function handleFileDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (readOnly || !isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = "copy"
  }

  function handleFileDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (readOnly || !isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
    if (fileDragDepthRef.current === 0) setFileDropActive(false)
  }

  function handleFileDrop(event: React.DragEvent<HTMLDivElement>) {
    if (readOnly || !isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    fileDragDepthRef.current = 0
    setFileDropActive(false)
    const nextAttachments = draggedAttachments(event)
    if (nextAttachments.length === 0) return
    void addFileAttachments(nextAttachments)
  }

  async function addFileAttachments(nextAttachments: PastedAttachment[]) {
    addAttachments(nextAttachments)
    if (!onFileAttachmentsAdd) {
      return
    }
    nextAttachments.forEach((attachment) => {
      handledFileAttachmentIdsRef.current.add(attachment.id)
    })
    setOptimizingAttachments(
      optimizeAttachmentsForAiContext &&
        nextAttachments.some((attachment) =>
          aiContextAttachmentSupported(attachment.file)
        )
    )
    try {
      onFileAttachmentsAdd(
        await Promise.all(
          nextAttachments.map((attachment) =>
            persistentFileAttachment(attachment, {
              optimize: optimizeAttachmentsForAiContext,
              workspace: platform.workspace,
            })
          )
        )
      )
    } finally {
      setOptimizingAttachments(false)
    }
  }

  function addAttachments(nextAttachments: PastedAttachment[]) {
    setAttachments((currentAttachments) => [
      ...currentAttachments,
      ...nextAttachments,
    ])
  }

  function removeAttachment(attachment: PastedAttachment) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    if (attachment.source === "code")
      onCodeSelectionAttachmentRemove?.(attachment.id)
    if (attachment.source === "file") onFileAttachmentRemove?.(attachment.id)
    setAttachments((currentAttachments) =>
      currentAttachments.filter(
        (currentAttachment) => currentAttachment.id !== attachment.id
      )
    )
  }

  function handleMarkdownInput(event: React.FormEvent<HTMLDivElement>) {
    if (
      event.nativeEvent instanceof InputEvent &&
      event.nativeEvent.isComposing
    )
      return
    const startedAt = performance.now()
    recordPerformanceCount("markdown.input")
    const captureStartedAt = performance.now()
    const snapshot = markdownEditorSnapshot(event.currentTarget)
    recordPerformanceMetric(
      "markdown.input.capture_duration_ms",
      performance.now() - captureStartedAt
    )
    const { selection, value: nextMarkdown } = snapshot
    recordPerformanceMetric(
      "markdown.input.document_length",
      nextMarkdown.length
    )
    if (selection) {
      lastSelectionRef.current = selection
      updateActiveSelection(selection, nextMarkdown)
    }
    emitMarkdown(nextMarkdown, undefined, selection)
    recordPerformanceMetric(
      "markdown.input.handler_duration_ms",
      performance.now() - startedAt
    )
  }

  function rememberEditorSelection() {
    const editor = editorRef.current
    const selection = editor && markdownEditorSelection(editor)
    if (selection) {
      lastSelectionRef.current = selection
      updateActiveSelection(selection)
    }
  }

  function rememberSpeechSelection() {
    rememberEditorSelection()
    speechInsertionSelectionRef.current = lastSelectionRef.current ?? {
      end: value.length,
      start: value.length,
    }
  }

  function insertSpeechTranscription(transcription: string) {
    const text = transcription.trim()
    if (!text) return
    const selection = speechInsertionSelectionRef.current ?? {
      end: value.length,
      start: value.length,
    }
    const start = Math.max(0, Math.min(selection.start, value.length))
    const end = Math.max(start, Math.min(selection.end, value.length))
    const prefix = start > 0 && !/\s/.test(value[start - 1] ?? "") ? " " : ""
    const suffix = end < value.length && !/\s/.test(value[end] ?? "") ? " " : ""
    const inserted = `${prefix}${text}${suffix}`
    emitMarkdown(
      markdownWithReplacement(value, start, end, inserted),
      start + inserted.length
    )
    speechInsertionSelectionRef.current = null
  }

  function handleSelectionChange() {
    rememberEditorSelection()
    updateMention()
  }

  function handleEditorKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (
      event.key === "Tab" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      const selection = markdownEditorSelection(event.currentTarget)
      if (!selection || selection.start !== selection.end) return
      const result = markdownListIndentResult(
        value,
        selection.start,
        event.shiftKey
      )
      if (!result) return
      event.preventDefault()
      emitMarkdown(result.value, result.cursor)
      return
    }
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const selection = markdownEditorSelection(event.currentTarget)
      if (!selection || selection.start !== selection.end) return
      event.preventDefault()
      const cursor = markdownArrowNavigationResult(
        value,
        selection.start,
        event.key
      )
      const nextSelection = { end: cursor, start: cursor }
      lastSelectionRef.current = nextSelection
      restoreMarkdownEditorSelection(event.currentTarget, nextSelection)
      updateActiveSelection(nextSelection)
      return
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      if (!value) {
        event.preventDefault()
        return
      }
      const currentSelection = markdownEditorSelection(event.currentTarget)
      if (!currentSelection) return
      const selection =
        currentSelection.start === currentSelection.end
          ? currentSelection
          : markdownExpandedDeletionSelection(
              value,
              currentSelection.start,
              currentSelection.end
            )
      const emptyListResult =
        event.key === "Backspace" && selection.start === selection.end
          ? markdownEmptyListDeletionResult(value, selection.start)
          : undefined
      if (emptyListResult) {
        event.preventDefault()
        emitMarkdown(emptyListResult.value, emptyListResult.cursor)
        return
      }
      const result = markdownAtomicLinkDeletionResult(
        value,
        selection.start,
        selection.end,
        event.key
      )
      if (!result && selection === currentSelection) return
      event.preventDefault()
      if (result) emitMarkdown(result.value, result.cursor)
      else {
        emitMarkdown(
          markdownWithReplacement(value, selection.start, selection.end, ""),
          selection.start
        )
      }
      return
    }
    if (
      event.key !== "Enter" ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.nativeEvent.isComposing
    )
      return
    if (!event.shiftKey && onSubmitShortcut) {
      event.preventDefault()
      if (!event.repeat) onSubmitShortcut()
      return
    }
    const selection = markdownEditorSelection(event.currentTarget)
    if (!selection) return
    event.preventDefault()
    const listResult =
      selection.start === selection.end
        ? markdownListEnterResult(value, selection.start)
        : undefined
    if (listResult) {
      emitMarkdown(listResult.value, listResult.cursor)
      return
    }
    const nextValue = markdownWithReplacement(
      value,
      selection.start,
      selection.end,
      "\n"
    )
    emitMarkdown(nextValue, selection.start + 1)
  }

  function applyMarkdownAction(action: MarkdownAction) {
    const editor = editorRef.current
    const selection =
      (editor && markdownEditorSelection(editor)) ?? lastSelectionRef.current
    if (!editor || !selection || readOnly) return
    const result = markdownActionResult(
      value,
      selection.start,
      selection.end,
      action
    )
    emitMarkdown(result.value, result.cursor)
  }

  function toggleTaskLine(lineIndex: number, checked: boolean) {
    const lines = value.split("\n")
    const line = lines[lineIndex]
    if (line === undefined) return
    lines[lineIndex] = line.replace(
      /^- \[[ xX]\]/,
      `- [${checked ? "x" : " "}]`
    )
    emitMarkdown(lines.join("\n"))
  }

  function runHistoryCommand(command: "redo" | "undo") {
    editorRef.current?.focus()
    document.execCommand(command)
  }

  async function handleOptimize() {
    if (!onOptimize || readOnly || optimizing) return
    setOptimizing(true)
    try {
      emitMarkdown(await onOptimize(value))
    } finally {
      setOptimizing(false)
    }
  }

  const stableApplyMarkdownAction = useLatestCallback(applyMarkdownAction)
  const stableRememberEditorSelection = useLatestCallback(
    rememberEditorSelection
  )
  const stableFileLinkClick = useLatestCallback((path: string) =>
    onFileLinkClick?.(path)
  )
  const stableRedo = useLatestCallback(() => runHistoryCommand("redo"))
  const stableUndo = useLatestCallback(() => runHistoryCommand("undo"))
  const stableOptimize = useLatestCallback(handleOptimize)

  return (
    <Popover open={mentionOpen}>
      <PopoverAnchor asChild>
        <div
          ref={(element) => {
            rootRef.current = element
            if (typeof ref === "function") ref(element)
            else if (ref) ref.current = element
          }}
          className={cn(
            "relative max-w-full min-w-0 overflow-hidden rounded-3xl bg-muted/50 p-1 shadow-xl ring-1 shadow-black/10 ring-foreground/20 transition-colors dark:bg-muted/50",
            appearance === "subtle" &&
              "rounded-none bg-transparent p-0 text-muted-foreground shadow-none ring-0 dark:bg-transparent",
            fileDropActive && "ring-2 ring-primary"
          )}
          onBlur={() => requestAnimationFrame(() => updateMention())}
          onDragEnter={handleFileDragEnter}
          onDragLeave={handleFileDragLeave}
          onDragOver={handleFileDragOver}
          onDrop={handleFileDrop}
          onKeyDownCapture={handleKeyDown}
          onPaste={handlePaste}
        >
          {fileDropActive && (
            <div
              aria-live="polite"
              className="pointer-events-none absolute inset-1 z-30 flex items-center justify-center rounded-[calc(1.5rem-0.25rem)] border-2 border-primary/60 bg-background/90 text-primary backdrop-blur-sm"
              role="status"
            >
              <div className="flex items-center gap-2 rounded-full bg-primary/10 px-4 py-2 text-sm font-medium">
                <PaperclipIcon className="size-4" />
                Drop files to attach
              </div>
            </div>
          )}
          {readOnly ? (
            <MarkdownPreview
              animateAppend={animateAppend}
              className={cn(
                minHeight,
                appearance === "subtle" ? "py-2" : "px-4 py-3.5"
              )}
              markdown={value}
              onFileLinkClick={onFileLinkClick}
              onTaskToggle={readOnly ? undefined : toggleTaskLine}
              placeholder={placeholder}
            />
          ) : (
            <div className="relative">
              <div className="pointer-events-none absolute top-3 right-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-2xl border border-border/70 bg-background/85 p-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/65">
                {onOptimize && (
                  <div className="pointer-events-auto shrink-0">
                    <MarkdownOptimizeButton
                      disabled={optimizing}
                      onOptimize={stableOptimize}
                      optimizing={optimizing}
                    />
                  </div>
                )}
                <div className="pointer-events-auto shrink-0">
                  <SpeechToTextControl
                    sessionKey={speechSessionKey}
                    disabled={optimizing || optimizingAttachments}
                    onStartRecording={rememberSpeechSelection}
                    onTranscription={insertSpeechTranscription}
                  />
                </div>
                {primaryAction ? (
                  <div className="pointer-events-auto shrink-0">
                    {primaryAction}
                  </div>
                ) : null}
              </div>
              <MarkdownWysiwygEditor
                activeSelection={activeSelection}
                editorRef={setEditorElement}
                className={cn(
                  minHeight,
                  maxHeight,
                  "overflow-y-auto rounded-3xl bg-input/40 px-4 py-3.5 pr-56 dark:bg-muted"
                )}
                markdown={value}
                onFileLinkClick={stableFileLinkClick}
                placeholder={placeholder}
                onInput={handleMarkdownInput}
                onKeyDown={handleEditorKeyDown}
                onSelectionChange={handleSelectionChange}
                renderKey={editorRenderKey}
              />
              {attachments.length > 0 && (
                <div className="mx-1 flex flex-wrap items-center gap-3 px-3 py-3">
                  {attachments.map((attachment) => (
                    <AttachmentPreview
                      key={attachment.id}
                      attachment={attachment}
                      onRemove={removeAttachment}
                    />
                  ))}
                </div>
              )}
              {optimizableAttachmentsVisible && (
                <div className="mx-1 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <Switch
                      checked={optimizeAttachmentsForAiContext}
                      disabled={optimizingAttachments}
                      onCheckedChange={setOptimizeAttachmentsForAiContext}
                    />
                    <span className="text-foreground">
                      Optimize attachments for AI context
                    </span>
                    {optimizingAttachments && (
                      <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                          aria-label="Attachment optimization details"
                        >
                          <InfoIcon className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        className="max-w-72 text-pretty"
                        sideOffset={6}
                      >
                        <span>
                          Converts supported PDF, Word, PowerPoint, and Excel
                          files to Markdown before sending them to the agent.
                        </span>{" "}
                        <a
                          className="inline-flex items-center gap-1 underline underline-offset-2"
                          href="https://github.com/microsoft/markitdown"
                          rel="noreferrer"
                          target="_blank"
                        >
                          Microsoft MarkItDown
                          <ExternalLinkIcon className="size-3" />
                        </a>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-0.5">
                  <input
                    ref={fileInputRef}
                    className="hidden"
                    multiple
                    type="file"
                    onChange={handleFileSelection}
                  />
                  <Button
                    type="button"
                    aria-label="Attach files"
                    className="text-muted-foreground hover:text-foreground"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <PaperclipIcon className="size-3.5" />
                  </Button>
                  <ToolbarSeparator />
                  <MarkdownToolbar
                    disabled={optimizing}
                    onAction={stableApplyMarkdownAction}
                    onActionIntent={stableRememberEditorSelection}
                    onRedo={stableRedo}
                    onUndo={stableUndo}
                  />
                </div>
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  {toolbarEnd}
                </div>
              </div>
            </div>
          )}

          {readOnly && attachments.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-3 py-3">
              {attachments.map((attachment) => (
                <AttachmentPreview
                  key={attachment.id}
                  attachment={attachment}
                />
              ))}
            </div>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-[min(36rem,calc(100vw-2rem))] p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
        side="top"
        sideOffset={8}
      >
        <Command shouldFilter={false}>
          <CommandList
            className="max-h-72 overscroll-contain"
            onWheel={(event) => {
              const list = event.currentTarget
              if (list.scrollHeight <= list.clientHeight) return
              const multiplier =
                event.deltaMode === 1
                  ? 16
                  : event.deltaMode === 2
                    ? list.clientHeight
                    : 1
              event.preventDefault()
              event.stopPropagation()
              list.scrollTop += event.deltaY * multiplier
            }}
          >
            <CommandEmpty className="py-3 text-muted-foreground">
              No matching files.
            </CommandEmpty>
            <CommandGroup>
              {mentionResults.map((result, index) => (
                <CommandItem
                  key={result.path}
                  value={result.path}
                  className={`gap-2 ${index === activeMentionIndex ? "bg-muted text-foreground" : ""}`}
                  ref={
                    index === activeMentionIndex
                      ? activeMentionItemRef
                      : undefined
                  }
                  onMouseEnter={() => setActiveMentionIndex(index)}
                  onSelect={() => selectMention(result)}
                >
                  <DevelopmentFileIcon className="shrink-0" node={result} />
                  <span className="flex min-w-0 items-center text-sm">
                    <span className="truncate text-muted-foreground">
                      {directoryName(result.path)}
                    </span>
                    <span className="shrink-0 text-foreground">
                      {filename(result.path)}
                      {result.type === "directory" ? "/" : ""}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
})

function equalMarkdownSelection(
  current: MarkdownSelection | null,
  next: MarkdownSelection
) {
  return current?.start === next.start && current.end === next.end
}

function equalFileMentionState(
  current: FileMentionState,
  next: FileMentionState
) {
  return (
    current.active === next.active &&
    current.end === next.end &&
    current.query === next.query &&
    current.start === next.start
  )
}

function codeSelectionAttachment(
  attachment: PendingCodeSelectionAttachment
): PastedAttachment {
  return {
    id: attachment.id,
    file: new File([attachment.content], attachment.path, {
      type: "text/plain",
    }),
    source: "code",
    subtitle: codeSelectionLineLabel(attachment),
    title: attachment.path,
  }
}

function pendingFileAttachment(
  attachment: PendingFileAttachment
): PastedAttachment {
  return {
    aiContextMarkdown: attachment.aiContextMarkdown,
    id: attachment.id,
    file: attachment.file,
    previewUrl:
      attachment.previewUrl ??
      (attachment.file.type.startsWith("image/")
        ? URL.createObjectURL(attachment.file)
        : undefined),
    source: "file",
    storedAttachment: attachment.storedAttachment,
  }
}

async function persistentFileAttachment(
  attachment: PastedAttachment,
  options: {
    optimize: boolean
    workspace: ReturnType<typeof usePlatform>["workspace"]
  }
): Promise<UserStoryFileAttachment> {
  if (attachment.storedAttachment) return attachment.storedAttachment
  const persistedAttachment = {
    ...(await fileAttachment(attachment.file, attachment.aiContextMarkdown)),
    id: attachment.id,
  }
  if (
    persistedAttachment.aiContextMarkdown ||
    !options.optimize ||
    !options.workspace ||
    !aiContextAttachmentSupported(attachment.file)
  ) {
    return persistedAttachment
  }
  try {
    const result = await options.workspace.optimizeAttachmentForAiContext({
      content: persistedAttachment.content,
      name: persistedAttachment.name,
      type: persistedAttachment.type,
    })
    if (!result.markdown.trim()) return persistedAttachment
    return { ...persistedAttachment, aiContextMarkdown: result.markdown }
  } catch {
    return persistedAttachment
  }
}
