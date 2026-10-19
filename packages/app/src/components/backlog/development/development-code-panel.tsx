import * as React from "react"
import type { VcsFileDiff } from "@/components/backlog/development/development-workspace"
import { FileDiffIcon, FolderIcon, ServerOffIcon } from "lucide-react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { DevelopmentFileTree } from "@/components/backlog/development/development-file-tree"
import { DevelopmentTabs } from "@/components/backlog/development/development-tabs"
import {
  buildDiffKinds,
  useDevelopmentWorkspace,
  type DevelopmentFileTab,
} from "@/components/backlog/development/development-workspace"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"

export function DevelopmentCodePanel({
  fallbackToProjectRoot,
  initialDiffPath,
  initialFilePath,
  mode,
  selectedDiffs,
  userStory,
}: {
  fallbackToProjectRoot?: boolean
  initialDiffPath?: string
  initialFilePath?: string
  mode: "files" | "diff"
  selectedDiffs?: VcsFileDiff[]
  userStory?: UserStory
}) {
  const workspace = useDevelopmentWorkspace(userStory, fallbackToProjectRoot)
  const workspaceAvailable = workspace.available
  const workspaceLoadDiffs = workspace.loadDiffs
  const workspaceReloadKey = workspace.reloadKey
  const workspaceRoot = workspace.root
  const [diffs, setDiffs] = React.useState<VcsFileDiff[]>(selectedDiffs ?? [])
  const [diffLoading, setDiffLoading] = React.useState(
    mode === "diff" && !selectedDiffs
  )
  const [diffError, setDiffError] = React.useState<string>()
  const [tabs, setTabs] = React.useState<DevelopmentFileTab[]>(
    initialFilePath ? [{ path: initialFilePath }] : []
  )
  const [activeTab, setActiveTab] = React.useState(
    initialFilePath ?? (mode === "diff" ? "review" : "empty")
  )
  const initialDiffLoad = React.useRef(true)

  React.useEffect(() => {
    initialDiffLoad.current = true
  }, [workspaceRoot])

  React.useEffect(() => {
    if (!workspaceAvailable || fallbackToProjectRoot || selectedDiffs) return
    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined
        if (initialDiffLoad.current) setDiffLoading(true)
        setDiffError(undefined)
        return workspaceLoadDiffs()
      })
      .then((next) => {
        if (!cancelled && next) setDiffs(next)
      })
      .catch((error) => {
        if (!cancelled) {
          setDiffError(
            error instanceof Error ? error.message : "Unable to load changes"
          )
        }
      })
      .finally(() => {
        initialDiffLoad.current = false
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    fallbackToProjectRoot,
    workspaceAvailable,
    workspaceLoadDiffs,
    workspaceReloadKey,
    selectedDiffs,
  ])

  const diffByPath = React.useMemo(
    () => new Map(diffs.map((diff) => [diff.file, diff])),
    [diffs]
  )
  const kinds = React.useMemo(() => buildDiffKinds(diffs), [diffs])
  const openFile = React.useCallback((path: string) => {
    setTabs((current) =>
      current.some((tab) => tab.path === path)
        ? current
        : [...current, { path }]
    )
    setActiveTab(path)
  }, [])

  const closeTab = React.useCallback(
    (path: string) => {
      setTabs((current) => {
        const next = current.filter((tab) => tab.path !== path)
        setActiveTab((active) => nextActiveTab(active, path, next, mode))
        return next
      })
    },
    [mode]
  )

  if (!workspace.hasServer) {
    return (
      <DevelopmentEmptyState
        description="File inspection will be restored through the Cline runtime."
        icon={ServerOffIcon}
        title="Backend unavailable"
      />
    )
  }

  if (!workspaceRoot) {
    return (
      <DevelopmentEmptyState
        description={
          fallbackToProjectRoot
            ? "Open a project to inspect its files."
            : "This user story does not have a worktree yet."
        }
        icon={FolderIcon}
        title={fallbackToProjectRoot ? "No project" : "No worktree"}
      />
    )
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[18rem_minmax(0,1fr)] overflow-hidden bg-background">
      <div className="flex min-h-0 flex-col border-r bg-muted/20">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm font-medium">
          {mode === "files" ? (
            <FolderIcon className="size-4" />
          ) : (
            <FileDiffIcon className="size-4" />
          )}
          <span>
            {mode === "files" ? "All files" : `${diffs.length} Changes`}
          </span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {diffError ? (
            <div className="p-3 text-sm text-muted-foreground">{diffError}</div>
          ) : mode === "diff" && diffLoading ? (
            <TreeLoading />
          ) : (
            <DevelopmentFileTree
              active={activeTab}
              allowed={
                mode === "diff" ? diffs.map((diff) => diff.file) : undefined
              }
              kinds={kinds}
              listDirectory={workspace.listDirectory}
              modified={diffs.map((diff) => diff.file)}
              reloadKey={workspace.reloadKey}
              searchFiles={workspace.searchFiles}
              onFileClick={openFile}
            />
          )}
        </ScrollArea>
      </div>
      <div className="min-h-0 min-w-0">
        <DevelopmentTabs
          activeTab={activeTab}
          diffByPath={diffByPath}
          diffs={diffs}
          mode={mode}
          initialReviewFilePath={initialDiffPath}
          readFile={workspace.readFile}
          reloadKey={workspace.reloadKey}
          reviewLoading={diffLoading}
          tabs={tabs}
          onActiveTabChange={setActiveTab}
          onCloseTab={closeTab}
          onOpenFile={openFile}
        />
      </div>
    </div>
  )
}

function DevelopmentEmptyState({
  description,
  icon: Icon,
  title,
}: {
  description: string
  icon: React.ComponentType<{ className?: string }>
  title: string
}) {
  return (
    <div className="flex h-full min-h-96 flex-col items-center justify-center gap-3 rounded-lg bg-muted/20 p-8 text-center">
      <Icon className="size-8 text-muted-foreground" />
      <div>
        <h3 className="font-heading text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function TreeLoading() {
  return (
    <div className="flex flex-col gap-3 p-3">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-5 w-1/2" />
      <Separator />
      <Skeleton className="h-5 w-4/5" />
      <Skeleton className="h-5 w-2/3" />
    </div>
  )
}

function nextActiveTab(
  active: string,
  closed: string,
  tabs: DevelopmentFileTab[],
  mode: "files" | "diff"
) {
  if (active !== closed) return active
  return tabs.at(-1)?.path ?? (mode === "diff" ? "review" : "empty")
}
