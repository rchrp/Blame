import type { GitStatusFile, WorkspaceClient } from "@/context/platform"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  GitMergeIcon,
  RotateCcwIcon,
  BotIcon,
  XCircleIcon,
} from "lucide-react"

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
import type { MergeChoice, MergeDocument, MergeRow } from "./git-merge-document"
import {
  conflictStatusLabel,
  MergeEditor,
  MergeTitle,
} from "./git-merge-editor"
import {
  useConflictActions,
  useConflictDialogState,
} from "./use-git-conflict-dialog"

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
