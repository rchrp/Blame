import * as React from "react"
import type { GitLogCommit } from "@/context/platform"
import type { GitSelection } from "@/components/git/git-types"
import { gitCommitSelection, gitSelectionKey } from "@/components/git/git-types"
import {
  gitDateLabel,
  gitRelativeDate,
  shortGitHash,
} from "@/components/git/git-format"
import {
  GitCommitGraphCell,
  gitGraphRowHeight,
  gitGraphWidth,
  type GitCommitNodeKind,
} from "@/components/git/git-commit-graph"
import {
  layoutGitGraph,
  type GitGraphRow,
} from "@/components/git/git-graph-layout"
import { GitRefLabels } from "@/components/git/git-ref-label"
import { GitCommitIcon, SearchIcon, XIcon } from "lucide-react"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function GitHistoryPanel({
  commits,
  commitTotal,
  hasMoreCommits,
  loading,
  loadingMore,
  onCommitSelect,
  onLoadMore,
  onQueryChange,
  query,
  selected,
}: {
  commits: GitLogCommit[]
  commitTotal?: number
  hasMoreCommits: boolean
  loading: boolean
  loadingMore: boolean
  onCommitSelect(selection: GitSelection): void
  onLoadMore(): void
  onQueryChange(value: string): void
  query: string
  selected?: GitSelection
}) {
  const filtered = filterCommits(commits, query)
  const searching = Boolean(query.trim())
  const canLoadMoreHistory = hasMoreCommits && !searching
  const graph = React.useMemo(() => layoutGitGraph(commits), [commits])
  const graphRows = React.useMemo(
    () =>
      new Map(commits.map((commit, index) => [commit.hash, graph.rows[index]])),
    [commits, graph]
  )
  // A search breaks the history apart: its results keep their lane color but
  // drop the lines that would link unrelated commits.
  const graphWidth = gitGraphWidth(searching ? 1 : graph.laneCount)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const scrollGuardRef = React.useRef<HistoryScrollGuard>({
    frame: 0,
    triggeredCommitCount: -1,
  })

  React.useEffect(() => {
    return watchHistoryScroll(
      scrollAreaRef,
      canLoadMoreHistory,
      commits.length,
      loadingMore,
      onLoadMore,
      scrollGuardRef
    )
  }, [canLoadMoreHistory, commits.length, loadingMore, onLoadMore])

  return (
    <main className="relative flex min-h-[34rem] min-w-0 flex-col xl:min-h-0">
      <div className="absolute top-0 right-3 left-0 z-10 overflow-hidden pb-8 surface-fade-top">
        <div className="relative">
          <HistoryToolbar
            loadedCount={commits.length}
            matchCount={searching ? filtered.length : undefined}
            total={commitTotal}
            hasMore={canLoadMoreHistory}
            query={query}
            onQueryChange={onQueryChange}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 pt-14" ref={scrollAreaRef}>
        {loading && commits.length === 0 ? <HistorySkeleton /> : null}
        {!loading && !loadingMore && filtered.length === 0 ? (
          <HistoryEmpty query={query} />
        ) : null}
        {filtered.length > 0 ? (
          // A zero-minimum grid track: Radix's table viewport would
          // otherwise widen to the longest message instead of truncating it.
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] px-2 pt-1 pb-3">
            {filtered.map((commit) => (
              <CommitRow
                commit={commit}
                graphRow={visibleGraphRow(
                  graphRows.get(commit.hash),
                  searching
                )}
                graphWidth={graphWidth}
                key={commit.hash}
                selected={selected}
                onSelect={onCommitSelect}
              />
            ))}
            {loadingMore ? <HistoryLoadingMore /> : null}
          </div>
        ) : loadingMore ? (
          <HistoryLoadingMore />
        ) : null}
      </ScrollArea>
    </main>
  )
}

function HistoryToolbar({
  hasMore,
  loadedCount,
  matchCount,
  onQueryChange,
  query,
  total,
}: {
  hasMore: boolean
  loadedCount: number
  // Commits matching the search among the loaded ones, while searching.
  matchCount?: number
  onQueryChange(value: string): void
  query: string
  total?: number
}) {
  return (
    <div className="px-2 py-2">
      <InputGroup className="h-10 rounded-xl border-transparent bg-muted/60 shadow-none ring-1 ring-foreground/10 dark:bg-muted/50">
        <InputGroupAddon className="pl-3.5">
          <SearchIcon className="size-4" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search commits by message, author, hash or branch"
          placeholder="Search message, author, hash, branch"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <InputGroupAddon align="inline-end" className="gap-1 pr-2">
          {query ? (
            <InputGroupButton
              aria-label="Clear commit search"
              className="text-muted-foreground hover:text-foreground"
              size="icon-xs"
              onClick={() => onQueryChange("")}
            >
              <XIcon className="size-3.5" />
            </InputGroupButton>
          ) : null}
          <span className="pr-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {matchCount === undefined
              ? historyCountLabel(total, loadedCount, hasMore)
              : `${matchCount.toLocaleString()} ${matchCount === 1 ? "match" : "matches"}`}
          </span>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

type HistoryScrollGuard = {
  frame: number
  triggeredCommitCount: number
}

function watchHistoryScroll(
  scrollAreaRef: React.RefObject<HTMLDivElement | null>,
  canLoadMoreHistory: boolean,
  loadedCommitCount: number,
  loadingMore: boolean,
  onLoadMore: () => void,
  scrollGuardRef: React.RefObject<HistoryScrollGuard>
) {
  const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
    "[data-slot='scroll-area-viewport']"
  )
  if (!viewport) return
  const handleScroll = () =>
    scheduleHistoryScrollCheck(
      viewport,
      canLoadMoreHistory,
      loadedCommitCount,
      loadingMore,
      onLoadMore,
      scrollGuardRef
    )
  viewport.addEventListener("scroll", handleScroll)
  return () => {
    cancelHistoryScrollCheck(scrollGuardRef)
    viewport.removeEventListener("scroll", handleScroll)
  }
}

function historyCountLabel(
  total: number | undefined,
  loadedCount: number,
  hasMore: boolean
) {
  const count = (total ?? loadedCount).toLocaleString()
  const suffix = total === undefined && hasMore ? "+" : ""
  return `${count}${suffix} ${total === 1 ? "commit" : "commits"}`
}

function scheduleHistoryScrollCheck(
  viewport: HTMLElement,
  canLoadMoreHistory: boolean,
  loadedCommitCount: number,
  loadingMore: boolean,
  onLoadMore: () => void,
  scrollGuardRef: React.RefObject<HistoryScrollGuard>
) {
  const guard = scrollGuardRef.current
  if (guard.frame) return
  guard.frame = window.requestAnimationFrame(() => {
    guard.frame = 0
    maybeLoadMoreHistory(
      viewport,
      canLoadMoreHistory,
      loadedCommitCount,
      loadingMore,
      onLoadMore,
      guard
    )
  })
}

function maybeLoadMoreHistory(
  viewport: HTMLElement,
  canLoadMoreHistory: boolean,
  loadedCommitCount: number,
  loadingMore: boolean,
  onLoadMore: () => void,
  guard: HistoryScrollGuard
) {
  if (!nearHistoryBottom(viewport) || !canLoadMoreHistory || loadingMore) return
  if (guard.triggeredCommitCount === loadedCommitCount) return
  guard.triggeredCommitCount = loadedCommitCount
  onLoadMore()
}

function cancelHistoryScrollCheck(
  scrollGuardRef: React.RefObject<HistoryScrollGuard>
) {
  const frame = scrollGuardRef.current.frame
  if (!frame) return
  window.cancelAnimationFrame(frame)
  scrollGuardRef.current.frame = 0
}

function nearHistoryBottom(viewport: HTMLElement) {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 260
  )
}

function CommitRow({
  commit,
  graphRow,
  graphWidth,
  onSelect,
  selected,
}: {
  commit: GitLogCommit
  graphRow: GitGraphRow
  graphWidth: number
  onSelect(selection: GitSelection): void
  selected?: GitSelection
}) {
  const selection = gitCommitSelection(commit.hash)
  const active = gitSelectionKey(selection) === gitSelectionKey(selected)
  const merge = commit.parents.length > 1

  return (
    <button
      className={cn(
        "flex w-full min-w-0 items-stretch rounded-lg pr-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50",
        active && "bg-muted hover:bg-muted"
      )}
      style={{ height: gitGraphRowHeight }}
      type="button"
      onClick={() => onSelect(selection)}
    >
      <GitCommitGraphCell
        node={commitNodeKind(commit, active)}
        row={graphRow}
        width={graphWidth}
      />
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-sm leading-5",
              merge ? "text-muted-foreground" : "font-medium text-foreground"
            )}
            title={commit.message}
          >
            {commit.message}
          </span>
          <GitRefLabels className="shrink-0" max={2} refs={commit.refs} />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80">
            {shortGitHash(commit.hash)}
          </span>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <span className="min-w-0 truncate">{commit.authorName}</span>
          <span
            className="ml-auto shrink-0 pl-2 tabular-nums"
            title={gitDateLabel(commit.date)}
          >
            {gitRelativeDate(commit.date)}
          </span>
        </span>
      </span>
    </button>
  )
}

function commitNodeKind(
  commit: GitLogCommit,
  active: boolean
): GitCommitNodeKind {
  if (active) return "selected"
  if (commit.refs.some((ref) => ref.type === "head")) return "head"
  return "commit"
}

function visibleGraphRow(
  row: GitGraphRow | undefined,
  searching: boolean
): GitGraphRow {
  if (!row) return { color: 0, column: 0, lines: [] }
  return searching ? { color: row.color, column: 0, lines: [] } : row
}

function HistoryEmpty({ query }: { query: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <GitCommitIcon className="size-8" />
      <div>
        {query.trim() ? "No commits match this search." : "No commits yet."}
      </div>
    </div>
  )
}

function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {Array.from({ length: 12 }).map((_, index) => (
        <Skeleton className="h-8 w-full" key={index} />
      ))}
    </div>
  )
}

function HistoryLoadingMore() {
  return (
    <div className="flex flex-col gap-2 p-2">
      {Array.from({ length: 3 }).map((_, index) => (
        <Skeleton className="h-10 w-full" key={index} />
      ))}
    </div>
  )
}

function filterCommits(commits: GitLogCommit[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return commits
  return commits.filter((commit) => commitMatchesQuery(commit, normalized))
}

function commitMatchesQuery(commit: GitLogCommit, query: string) {
  return [
    commit.hash,
    commit.message,
    commit.authorName,
    commit.authorEmail,
    ...commit.refs.map((ref) => ref.name),
  ]
    .join("\n")
    .toLowerCase()
    .includes(query)
}
