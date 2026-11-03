import * as React from "react"
import { File as PierreFile } from "@pierre/diffs/react"
import { ChevronRightIcon, FileIcon } from "lucide-react"

import { DevelopmentDiffView } from "@/components/backlog/development/development-diff-view"
import { DevelopmentScrollArea } from "@/components/backlog/development/development-scroll-area"
import type { FileContent, VcsFileDiff } from "@/components/backlog/development/development-workspace"
import {
  filename,
  parseGitDiff,
} from "@/components/backlog/development/development-workspace"
import { dispatchCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import {
  pierreSyntaxThemes,
  usePierreSyntaxHighlighting,
} from "@/components/backlog/development/pierre-syntax-highlighting"
import {
  labelPierreGutterUtility,
  pierreGutterUtilityCSS,
} from "@/components/backlog/development/pierre-gutter-utility"
import { Skeleton } from "@/components/ui/skeleton"
import { useTheme } from "@/components/providers/theme-provider"

type FileState = {
  path: string
  content?: FileContent
  error?: string
}

export function DevelopmentFileView({
  diff,
  path,
  readFile,
  reloadKey,
}: {
  diff?: VcsFileDiff
  path: string
  readFile: (path: string) => Promise<FileContent | undefined>
  reloadKey: number
}) {
  const [state, setState] = React.useState<FileState>()

  React.useEffect(() => {
    let cancelled = false
    readFile(path)
      .then((content) => {
        if (!cancelled) setState({ content, path })
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            error: error instanceof Error ? error.message : "Unable to read file",
            path,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [path, readFile, reloadKey])

  if (!state || state.path !== path) return <FileSkeleton />

  if (state.error) {
    return (
      <EmptyFileState
        description={state.error}
        title="Unable to open file"
      />
    )
  }

  if (!state.content) {
    return (
      <EmptyFileState
        description="This file cannot be previewed as text."
        title="Binary file"
      />
    )
  }

  if (isImageContent(state.content)) {
    return <ImagePreview content={state.content} path={path} />
  }

  if (state.content.type === "binary") {
    return (
      <EmptyFileState
        description="This file cannot be previewed."
        title="Binary file"
      />
    )
  }

  const previewDiff = diff ?? contentDiff(path, state.content)

  if (!previewDiff) {
    return <FileSource path={path} source={sourceText(state.content)} />
  }

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] overflow-hidden">
      <div className="min-h-0 min-w-0 overflow-hidden">
        <FileSource path={path} source={sourceText(state.content)} />
      </div>
      <div className="min-h-0 min-w-0 overflow-hidden border-t">
        <DevelopmentDiffView diff={previewDiff} title="Changes" />
      </div>
    </div>
  )
}

function FileSource({ path, source }: { path: string; source: string }) {
  const syntaxHighlightingReady = usePierreSyntaxHighlighting(path)
  const { theme } = useTheme()
  const sourceLines = React.useMemo(() => source.split("\n"), [source])
  const commentSelection = React.useCallback(
    (range: { end: number; start: number }) => {
      const start = Math.max(1, range.start)
      const end = Math.min(sourceLines.length, Math.max(start, range.end))
      dispatchCodeSelectionAttachment({
        content: sourceLines.slice(start - 1, end).join("\n"),
        endLine: end,
        path,
        startLine: start,
      })
    },
    [path, sourceLines]
  )
  const themeType =
    theme === "system"
      ? document.documentElement.classList.contains("dark")
        ? "dark"
        : "light"
      : theme
  const options = React.useMemo(
    () => ({
      disableFileHeader: true,
      enableGutterUtility: true,
      enableLineSelection: true,
      lineHoverHighlight: "line" as const,
      onGutterUtilityClick: commentSelection,
      onPostRender: (node: HTMLElement) =>
        labelPierreGutterUtility(node, `Comment ${path} source selection`),
      overflow: "scroll" as const,
      theme: pierreSyntaxThemes,
      themeType,
      unsafeCSS: pierreGutterUtilityCSS,
    }),
    [commentSelection, path, themeType]
  )

  if (!syntaxHighlightingReady) return <FileSkeleton />

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden">
      <FileHeader path={path} />
      <DevelopmentScrollArea className="min-h-0 w-full max-w-full flex-1">
        <PierreFile
          className="blame-pierre-file"
          file={{ contents: source, name: path }}
          options={options}
        />
      </DevelopmentScrollArea>
    </div>
  )
}

function ImagePreview({
  content,
  path,
}: {
  content: FileContent
  path: string
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden">
      <FileHeader path={path} />
      <DevelopmentScrollArea className="min-h-0 w-full max-w-full flex-1">
        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          <img
            alt={filename(path)}
            className="max-h-full max-w-full object-contain"
            src={`data:${content.mimeType};base64,${content.content}`}
          />
        </div>
      </DevelopmentScrollArea>
    </div>
  )
}

// The file's place in the tree, its name already on the open tab.
function FileHeader({ path }: { path: string }) {
  const folders = path.split("/").slice(0, -1).filter(Boolean)
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1 px-4 pt-3 pb-1.5 text-xs text-muted-foreground">
      {folders.map((folder, index) => (
        <React.Fragment key={`${folder}-${index}`}>
          <span className="shrink-0 truncate">{folder}</span>
          <ChevronRightIcon className="size-3 shrink-0 opacity-60" />
        </React.Fragment>
      ))}
      <span className="truncate font-medium text-foreground">
        {filename(path)}
      </span>
    </div>
  )
}

function FileSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-6 w-1/4" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

function EmptyFileState({
  description,
  title,
}: {
  description: string
  title: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <FileIcon className="size-8 text-muted-foreground" />
      <h3 className="font-heading text-lg font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

function sourceText(content: FileContent) {
  if (content.encoding === "base64") return ""
  return content.content
}

function isImageContent(content: FileContent) {
  return content.encoding === "base64" && content.mimeType?.startsWith("image/")
}

function contentDiff(path: string, content: FileContent): VcsFileDiff | undefined {
  if (!content.diff) return undefined
  const parsed = parseGitDiff(content.diff)[0]
  return parsed
    ? { ...parsed, file: path }
    : { file: path, patch: content.diff, status: "modified" }
}
