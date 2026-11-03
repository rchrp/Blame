import * as React from "react"
import type { VcsFileDiff } from "@/components/backlog/development/development-workspace"
import { FolderIcon, SearchIcon, ServerOffIcon, XIcon } from "lucide-react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { DevelopmentFileTree } from "@/components/backlog/development/development-file-tree"
import {
  DevelopmentEditorContent,
  developmentEditorTabs,
} from "@/components/backlog/development/development-tabs"
import { AttachedTabs } from "@/components/backlog/shared/attached-tabs"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
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
  const [query, setQuery] = React.useState("")
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

  const editorTabs = developmentEditorTabs(mode, tabs, diffs.length)
  const shownTab = editorTabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : (editorTabs[0]?.id ?? "empty")

  // As a story's preview: a toolbar over the drawer's own background, the
  // tree beside a framed editor whose open files sit on it as tabs.
  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="flex h-12 shrink-0 items-start gap-3">
        <CodeSearchField
          placeholder={
            mode === "diff"
              ? `Search ${diffs.length} changed ${diffs.length === 1 ? "file" : "files"}`
              : "Search files"
          }
          value={query}
          onChange={setQuery}
        />
        <div className="min-w-0 flex-1 self-end">
          {editorTabs.length ? (
            <AttachedTabs
              items={editorTabs}
              label="Open files"
              surface="panel"
              value={shownTab}
              onClose={closeTab}
              onValueChange={setActiveTab}
            />
          ) : null}
        </div>
        <CodeActionsSpace />
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <ScrollArea className="min-h-0 w-72 shrink-0">
          {/* Without the diff the file tree still works, minus change marks. */}
          {mode === "diff" && diffError ? (
            <div className="p-3 text-sm text-muted-foreground">{diffError}</div>
          ) : mode === "diff" && diffLoading ? (
            <TreeLoading />
          ) : (
            <DevelopmentFileTree
              active={shownTab}
              allowed={
                mode === "diff" ? diffs.map((diff) => diff.file) : undefined
              }
              className="py-0"
              kinds={kinds}
              listDirectory={workspace.listDirectory}
              modified={diffs.map((diff) => diff.file)}
              query={query}
              reloadKey={workspace.reloadKey}
              searchFiles={workspace.searchFiles}
              onFileClick={openFile}
            />
          )}
        </ScrollArea>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background shadow-[0_16px_44px_rgb(0_0_0/0.18)]",
            // The first tab, selected, carries the panel's left edge up.
            editorTabs[0]?.id === shownTab && "rounded-tl-none"
          )}
        >
          <DevelopmentEditorContent
            active={shownTab}
            diffByPath={diffByPath}
            diffs={diffs}
            initialReviewFilePath={initialDiffPath}
            mode={mode}
            readFile={workspace.readFile}
            reloadKey={workspace.reloadKey}
            reviewLoading={diffLoading}
            onOpenFile={openFile}
          />
        </div>
      </div>
    </div>
  )
}

// Room for the Code tab's view switch, which stays over the toolbar's
// right end whatever the view (see DevelopmentContent).
export function CodeActionsSpace() {
  return (
    <span
      aria-hidden="true"
      className="h-full shrink-0"
      style={{ width: "var(--code-actions-space, 0px)" }}
    />
  )
}

function CodeSearchField({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex h-10 w-72 shrink-0 cursor-text items-center gap-2 rounded-full border bg-background/95 pr-1.5 pl-3.5 shadow-sm backdrop-blur focus-within:ring-2 focus-within:ring-ring/40">
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
      <input
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        placeholder={placeholder}
        spellCheck={false}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onChange("")
        }}
      />
      {value ? (
        <Button
          aria-label="Clear the search"
          className="size-7 shrink-0 rounded-full"
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => onChange("")}
        >
          <XIcon />
        </Button>
      ) : null}
    </label>
  )
}

// Nothing to show in the Code tab: said in the frame where the code goes,
// under its toolbar.
export function DevelopmentEmptyState({
  description,
  icon: Icon,
  title,
}: {
  description: string
  icon: React.ComponentType<{ className?: string }>
  title: string
}) {
  return (
    <div className="flex h-full min-h-0 flex-col p-4 pt-16">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border bg-background p-8 text-center">
        <Icon className="size-8 text-muted-foreground" />
        <div className="space-y-1">
          <h3 className="font-heading text-lg font-semibold">{title}</h3>
          <p className="text-sm text-pretty text-muted-foreground">
            {description}
          </p>
        </div>
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
