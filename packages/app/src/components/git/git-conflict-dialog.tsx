import * as React from "react"
import type {
  GitConflictFile,
  GitStatusFile,
  WorkspaceClient,
} from "@/context/platform"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  GitMergeIcon,
  RotateCcwIcon,
  BotIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  activeConflictPath,
  initialMergeChoices,
  type MergeChoice,
  type MergeDocument,
  mergeDocumentContent,
  type MergeRow,
  mergeRowChoice,
  mergeRowResult,
  mergeSideClassName,
  parseMergeDocument,
  resultLineNumber,
  selectMergeLine,
  setAllChoices,
  sideMarker,
} from "./git-merge-document"

export function GitConflictDialog({
  agentResolving,
  conflicts,
  onError,
  onOpenChange,
  onRefresh,
  onResolveWithAgent,
  open,
  root,
  workspace,
}: {
  agentResolving: boolean
  conflicts: GitStatusFile[]
  onError(message: string): void
  onOpenChange(open: boolean): void
  onRefresh(): Promise<void> | void
  onResolveWithAgent(): void
  open: boolean
  root?: string
  workspace?: WorkspaceClient
}) {
  const state = useConflictDialogState({
    conflicts,
    onError,
    open,
    root,
    workspace,
  })
  const actions = useConflictActions({
    choices: state.choices,
    document: state.document,
    onError,
    onOpenChange,
    onRefresh,
    root,
    selectedPath: state.activePath,
    setBusy: state.setBusy,
    setChoices: state.setChoices,
    workspace,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[92vh] max-h-[92vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0 sm:max-w-[calc(100vw-3rem)]">
        <ConflictHeader conflicts={conflicts} />
        <div className="grid min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-[20rem_minmax(0,1fr)]">
          <ConflictFileList
            conflicts={conflicts}
            selectedPath={state.activePath}
            onSelect={state.setSelectedPath}
          />
          <ConflictResolutionView
            choices={state.choices}
            document={state.document}
            file={state.selectedFile}
            loading={state.loading}
            onSelectLine={state.selectLine}
          />
        </div>
        <ConflictFooter
          agentResolving={agentResolving}
          busy={state.busy}
          canApply={Boolean(state.document && state.activePath)}
          canContinue={conflicts.length === 0 && Boolean(root && workspace)}
          canResolveWithAgent={conflicts.length > 0}
          disabled={state.disabled}
          onAbort={actions.abort}
          onAcceptCurrent={actions.acceptCurrent}
          onAcceptIncoming={actions.acceptIncoming}
          onApply={actions.apply}
          onContinue={actions.continueGit}
          onResolveWithAgent={onResolveWithAgent}
        />
      </DialogContent>
    </Dialog>
  )
}

function ConflictHeader({ conflicts }: { conflicts: GitStatusFile[] }) {
  return (
    <DialogHeader className="border-b px-5 py-4">
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangleIcon className="size-4 shrink-0 text-amber-500" />
        <DialogTitle>Merge conflicts</DialogTitle>
        <Badge variant="outline">{conflicts.length} remaining</Badge>
      </div>
      <DialogDescription>
        Select current or incoming lines, then apply the resolved file.
      </DialogDescription>
    </DialogHeader>
  )
}

function ConflictFileList({
  conflicts,
  onSelect,
  selectedPath,
}: {
  conflicts: GitStatusFile[]
  onSelect(path: string): void
  selectedPath?: string
}) {
  return (
    <aside className="min-h-0 overflow-auto border-b bg-muted/20 lg:border-r lg:border-b-0">
      <div className="grid gap-1 p-3">
        {conflicts.length === 0 ? <ResolvedConflictState /> : null}
        {conflicts.map((file) => (
          <ConflictFileButton
            file={file}
            key={file.path}
            selected={selectedPath === file.path}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  )
}

function ConflictFileButton({
  file,
  onSelect,
  selected,
}: {
  file: GitStatusFile
  onSelect(path: string): void
  selected: boolean
}) {
  return (
    <button
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted",
        selected && "bg-muted"
      )}
      type="button"
      onClick={() => onSelect(file.path)}
    >
      <span className="min-w-0 flex-1 truncate">{file.path}</span>
      <Badge className="shrink-0" variant="outline">
        {conflictStatusLabel(file)}
      </Badge>
    </button>
  )
}

function ConflictResolutionView({
  choices,
  document,
  file,
  loading,
  onSelectLine,
}: {
  choices: Record<string, MergeChoice>
  document?: MergeDocument
  file?: GitStatusFile
  loading: boolean
  onSelectLine(row: MergeRow, choice: MergeChoice): void
}) {
  if (!file) return <AllResolvedState />
  if (loading || !document) return <ConflictLoadingState file={file} />

  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <MergeTitle file={file} />
      <MergeEditor
        choices={choices}
        document={document}
        path={file.path}
        onSelectLine={onSelectLine}
      />
    </section>
  )
}

function MergeTitle({ file }: { file: GitStatusFile }) {
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

function MergeEditor({
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

function ConflictFooter({
  agentResolving,
  busy,
  canApply,
  canContinue,
  canResolveWithAgent,
  disabled,
  onAbort,
  onAcceptCurrent,
  onAcceptIncoming,
  onApply,
  onContinue,
  onResolveWithAgent,
}: {
  agentResolving: boolean
  busy?: string
  canApply: boolean
  canContinue: boolean
  canResolveWithAgent: boolean
  disabled: boolean
  onAbort(): void
  onAcceptCurrent(): void
  onAcceptIncoming(): void
  onApply(): void
  onContinue(): void
  onResolveWithAgent(): void
}) {
  const actionDisabled = disabled || agentResolving
  return (
    <DialogFooter className="mx-0 mb-0 items-center gap-2 rounded-none bg-muted/30 px-5 py-3">
      <div className="mr-auto flex min-w-0 items-center gap-2">
        <Button
          disabled={actionDisabled || !canApply}
          type="button"
          variant="outline"
          onClick={onAcceptCurrent}
        >
          Accept current
        </Button>
        <Button
          disabled={actionDisabled || !canApply}
          type="button"
          variant="outline"
          onClick={onAcceptIncoming}
        >
          Accept incoming
        </Button>
        {busy || agentResolving ? (
          <span className="truncate text-xs text-muted-foreground">
            {agentResolving ? "Resolving with AI" : busy}
          </span>
        ) : null}
      </div>
      <Button
        disabled={actionDisabled}
        type="button"
        variant="destructive"
        onClick={onAbort}
      >
        <XCircleIcon />
        Abort
      </Button>
      <Button
        disabled={actionDisabled || !canResolveWithAgent}
        type="button"
        variant="outline"
        onClick={onResolveWithAgent}
      >
        <BotIcon />
        Resolve with AI
      </Button>
      <Button
        disabled={actionDisabled || !canApply}
        type="button"
        onClick={onApply}
      >
        <CheckCircle2Icon />
        Apply
      </Button>
      <Button
        disabled={!canContinue || Boolean(busy) || agentResolving}
        type="button"
        onClick={onContinue}
      >
        <GitMergeIcon />
        Continue
      </Button>
    </DialogFooter>
  )
}

function useConflictDialogState({
  conflicts,
  onError,
  open,
  root,
  workspace,
}: {
  conflicts: GitStatusFile[]
  onError(message: string): void
  open: boolean
  root?: string
  workspace?: WorkspaceClient
}) {
  const [busy, setBusy] = React.useState<string>()
  const [choices, setChoices] = React.useState<Record<string, MergeChoice>>({})
  const [conflict, setConflict] = React.useState<GitConflictFile>()
  const [selectedPath, setSelectedPath] = React.useState<string>()
  const activePath = activeConflictPath(conflicts, selectedPath)
  const selectedFile = conflicts.find((file) => file.path === activePath)
  const activeConflict = conflict?.path === activePath ? conflict : undefined
  const document = React.useMemo(
    () => (activeConflict ? parseMergeDocument(activeConflict) : undefined),
    [activeConflict]
  )
  const loading = Boolean(open && activePath && !activeConflict)
  const disabled = Boolean(busy) || loading || !root || !workspace

  useLoadConflict({
    activePath,
    onError,
    open,
    root,
    setChoices,
    setConflict,
    workspace,
  })

  return {
    activePath,
    busy,
    choices,
    disabled,
    document,
    loading,
    selectedFile,
    selectLine: selectMergeLine(setChoices),
    setBusy,
    setChoices,
    setSelectedPath,
  }
}

function useLoadConflict({
  activePath,
  onError,
  open,
  root,
  setChoices,
  setConflict,
  workspace,
}: {
  activePath?: string
  onError(message: string): void
  open: boolean
  root?: string
  setChoices(value: Record<string, MergeChoice>): void
  setConflict(value: GitConflictFile): void
  workspace?: WorkspaceClient
}) {
  React.useEffect(() => {
    if (!open || !root || !workspace || !activePath) return
    let cancelled = false
    workspace
      .gitConflictFile({ root, path: activePath })
      .then((nextConflict) => {
        if (cancelled) return
        setConflict(nextConflict)
        setChoices(initialMergeChoices(parseMergeDocument(nextConflict)))
      })
      .catch((error) => {
        if (!cancelled) reportConflictError(error, onError)
      })
    return () => {
      cancelled = true
    }
  }, [activePath, onError, open, root, setChoices, setConflict, workspace])
}

function useConflictActions({
  choices,
  document,
  onError,
  onOpenChange,
  onRefresh,
  root,
  selectedPath,
  setBusy,
  setChoices,
  workspace,
}: {
  choices: Record<string, MergeChoice>
  document?: MergeDocument
  onError(message: string): void
  onOpenChange(open: boolean): void
  onRefresh(): Promise<void> | void
  root?: string
  selectedPath?: string
  setBusy(value: string | undefined): void
  setChoices(value: React.SetStateAction<Record<string, MergeChoice>>): void
  workspace?: WorkspaceClient
}) {
  const apply = () => {
    if (!document || !root || !workspace || !selectedPath) return
    void runConflictAction(
      "Applying resolution",
      () =>
        workspace.gitResolveConflictFile({
          root,
          path: selectedPath,
          content: mergeDocumentContent(document, choices),
        }),
      false,
      onError,
      onOpenChange,
      onRefresh,
      setBusy
    )
  }
  return conflictActionHandlers({
    apply,
    document,
    onError,
    onOpenChange,
    onRefresh,
    root,
    setBusy,
    setChoices,
    workspace,
  })
}

function conflictActionHandlers(input: {
  apply(): void
  document?: MergeDocument
  onError(message: string): void
  onOpenChange(open: boolean): void
  onRefresh(): Promise<void> | void
  root?: string
  setBusy(value: string | undefined): void
  setChoices(value: React.SetStateAction<Record<string, MergeChoice>>): void
  workspace?: WorkspaceClient
}) {
  return {
    abort: gitOperationAction(input, "Aborting Git operation", "abort", true),
    acceptCurrent: () =>
      setAllChoices(input.document, input.setChoices, "current"),
    acceptIncoming: () =>
      setAllChoices(input.document, input.setChoices, "incoming"),
    apply: input.apply,
    continueGit: gitOperationAction(
      input,
      "Continuing Git operation",
      "continue",
      true
    ),
  }
}

function gitOperationAction(
  input: {
    onError(message: string): void
    onOpenChange(open: boolean): void
    onRefresh(): Promise<void> | void
    root?: string
    setBusy(value: string | undefined): void
    workspace?: WorkspaceClient
  },
  label: string,
  command: "abort" | "continue",
  close: boolean
) {
  return () => {
    if (!input.root || !input.workspace) return
    void runConflictAction(
      label,
      () =>
        command === "abort"
          ? input.workspace!.gitAbortConflict({ root: input.root! })
          : input.workspace!.gitContinueConflict({ root: input.root! }),
      close,
      input.onError,
      input.onOpenChange,
      input.onRefresh,
      input.setBusy
    )
  }
}

async function runConflictAction(
  label: string,
  action: () => Promise<unknown>,
  close: boolean,
  onError: (message: string) => void,
  onOpenChange: (open: boolean) => void,
  onRefresh: () => Promise<void> | void,
  setBusy: (value: string | undefined) => void
) {
  setBusy(label)
  try {
    await action()
    await onRefresh()
    toast.success(actionSuccess(label))
    if (close) onOpenChange(false)
  } catch (error) {
    reportConflictError(error, onError)
  } finally {
    setBusy(undefined)
  }
}

function AllResolvedState() {
  return (
    <div className="flex min-h-0 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <CheckCircle2Icon className="size-8 text-emerald-500" />
      <div>All conflicts are resolved.</div>
    </div>
  )
}

function ConflictLoadingState({ file }: { file: GitStatusFile }) {
  return (
    <div className="flex min-h-0 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <RotateCcwIcon className="size-7 animate-spin" />
      <div>Loading {file.path}</div>
    </div>
  )
}

function ResolvedConflictState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      <CheckCircle2Icon className="size-7 text-emerald-500" />
      <div>No unresolved files.</div>
    </div>
  )
}

function reportConflictError(
  error: unknown,
  onError: (message: string) => void
) {
  const message = error instanceof Error ? error.message : "Git conflict error"
  onError(message)
  toast.error(message)
}

function conflictStatusLabel(file: GitStatusFile) {
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

function actionSuccess(label: string) {
  if (label.endsWith("ing")) return `${label.slice(0, -3)}ed.`
  return `${label}.`
}
