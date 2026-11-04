import type { GitStatusFile } from "@/context/platform"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  type MergeChoice,
  type MergeDocument,
  type MergeRow,
  mergeRowChoice,
  mergeRowResult,
  mergeSideClassName,
  resultLineNumber,
  sideMarker,
} from "./git-merge-document"

export function MergeTitle({ file }: { file: GitStatusFile }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{file.path}</div>
        <div className="text-xs text-muted-foreground">
          Choose current or incoming lines.
        </div>
      </div>
      <Badge variant="outline">{conflictStatusLabel(file)}</Badge>
    </div>
  )
}

export function MergeEditor({
  choices,
  document,
  onSelectLine,
  path,
}: {
  choices: Record<string, MergeChoice>
  document: MergeDocument
  onSelectLine(row: MergeRow, choice: MergeChoice): void
  path: string
}) {
  return (
    <div className="min-h-0 overflow-auto bg-background font-mono text-xs leading-5">
      <div className="min-w-[64rem]">
        <MergeColumnHeader path={path} />
        <pre className="m-0 min-w-full p-0">
          {document.rows.map((row) => (
            <MergeEditorRow
              choice={mergeRowChoice(row, choices)}
              key={row.id}
              row={row}
              onSelectLine={onSelectLine}
            />
          ))}
        </pre>
      </div>
    </div>
  )
}

function MergeColumnHeader({ path }: { path: string }) {
  return (
    <div className="sticky top-0 z-10 grid grid-cols-3 border-b bg-background/95 backdrop-blur">
      <MergeHeaderCell label="Changes from current" />
      <MergeHeaderCell label={`Result ${path}`} />
      <MergeHeaderCell label="Changes from incoming" />
    </div>
  )
}

function MergeHeaderCell({ label }: { label: string }) {
  return (
    <div className="min-w-0 border-r px-3 py-2 last:border-r-0">
      <div className="truncate font-sans text-xs font-medium">{label}</div>
    </div>
  )
}

function MergeEditorRow({
  choice,
  onSelectLine,
  row,
}: {
  choice: MergeChoice
  onSelectLine(row: MergeRow, choice: MergeChoice): void
  row: MergeRow
}) {
  const result = mergeRowResult(row, choice)

  return (
    <div className="grid min-w-full grid-cols-3">
      <MergeLineCell
        active={choice === "current"}
        line={row.current}
        lineNumber={row.currentLine}
        side="current"
        type={row.type}
        onIgnore={() => onSelectLine(row, "none")}
        onSelect={() => onSelectLine(row, "current")}
      />
      <MergeResultCell
        line={result}
        lineNumber={result === undefined ? undefined : resultLineNumber(row)}
        type={row.type}
      />
      <MergeLineCell
        active={choice === "incoming"}
        line={row.incoming}
        lineNumber={row.incomingLine}
        side="incoming"
        type={row.type}
        onIgnore={() => onSelectLine(row, "none")}
        onSelect={() => onSelectLine(row, "incoming")}
      />
    </div>
  )
}

function MergeLineCell({
  active,
  line,
  lineNumber,
  onIgnore,
  onSelect,
  side,
  type,
}: {
  active: boolean
  line?: string
  lineNumber?: number
  onIgnore(): void
  onSelect(): void
  side: "current" | "incoming"
  type: MergeRow["type"]
}) {
  const selectable = type === "conflict" && line !== undefined

  return (
    <div
      className={cn(
        "grid h-5 min-w-0 grid-cols-[3rem_3rem_minmax(0,1fr)] border-r",
        mergeSideClassName(type, side, active)
      )}
    >
      <span className="px-1.5 text-right text-muted-foreground/70">
        {lineNumber ?? ""}
      </span>
      <MergeLineActions
        selectable={selectable}
        side={side}
        onIgnore={onIgnore}
        onSelect={onSelect}
      />
      <button
        className={cn(
          "min-w-0 overflow-hidden px-2 text-left whitespace-pre",
          selectable && "cursor-pointer hover:bg-blue-500/10",
          !selectable && "cursor-default"
        )}
        disabled={!selectable}
        type="button"
        onClick={onSelect}
      >
        <code>{line ?? " "}</code>
      </button>
    </div>
  )
}

function MergeLineActions({
  onIgnore,
  onSelect,
  selectable,
  side,
}: {
  onIgnore(): void
  onSelect(): void
  selectable: boolean
  side: "current" | "incoming"
}) {
  if (!selectable) return <span />
  const arrow = <MergeLineAction label={sideMarker(side)} onClick={onSelect} />
  const ignore = <MergeLineAction label="x" onClick={onIgnore} />
  return (
    <span className="flex items-center justify-center gap-0.5 text-muted-foreground/70">
      {side === "current" ? ignore : arrow}
      {side === "current" ? arrow : ignore}
    </span>
  )
}

function MergeLineAction({
  label,
  onClick,
}: {
  label: string
  onClick(): void
}) {
  return (
    <button
      className="h-5 min-w-4 px-0.5 text-center hover:text-foreground"
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function MergeResultCell({
  line,
  lineNumber,
  type,
}: {
  line?: string
  lineNumber?: number
  type: MergeRow["type"]
}) {
  return (
    <div
      className={cn(
        "grid h-5 min-w-0 grid-cols-[3rem_3rem_minmax(0,1fr)] border-r",
        type === "conflict" && "bg-blue-500/10"
      )}
    >
      <span className="px-1.5 text-right text-muted-foreground/70">
        {lineNumber ?? ""}
      </span>
      <span className="text-center text-muted-foreground/70">
        {type === "conflict" ? "=" : ""}
      </span>
      <code className="min-w-0 overflow-hidden px-2 whitespace-pre">
        {line ?? " "}
      </code>
    </div>
  )
}

export function conflictStatusLabel(file: GitStatusFile) {
  const status = `${file.indexStatus}${file.worktreeStatus}`
  if (status === "UU") return "both modified"
  if (status === "AA") return "both added"
  if (status === "DD") return "both deleted"
  if (status === "AU") return "added by us"
  if (status === "UA") return "added by them"
  if (status === "DU") return "deleted by us"
  if (status === "UD") return "deleted by them"
  return "conflict"
}
