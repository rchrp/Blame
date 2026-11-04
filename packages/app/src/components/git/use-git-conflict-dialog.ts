import * as React from "react"
import type {
  GitConflictFile,
  GitStatusFile,
  WorkspaceClient,
} from "@/context/platform"
import { toast } from "sonner"

import {
  activeConflictPath,
  initialMergeChoices,
  type MergeChoice,
  type MergeDocument,
  mergeDocumentContent,
  parseMergeDocument,
  selectMergeLine,
  setAllChoices,
} from "./git-merge-document"

export function useConflictDialogState({
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

export function useConflictActions({
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

function reportConflictError(
  error: unknown,
  onError: (message: string) => void
) {
  const message = error instanceof Error ? error.message : "Git conflict error"
  onError(message)
  toast.error(message)
}

function actionSuccess(label: string) {
  if (label.endsWith("ing")) return `${label.slice(0, -3)}ed.`
  return `${label}.`
}
