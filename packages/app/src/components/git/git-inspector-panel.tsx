import * as React from "react"
import type {
  GitLogCommit,
  GitStatusFile,
  GitStatusResult,
} from "@/context/platform"
import type { GitSelection } from "@/components/git/git-types"
import {
  gitDateLabel,
  gitStatusName,
  gitStatusTextClassName,
  shortGitHash,
} from "@/components/git/git-format"
import {
  normalizeDiffs,
  parseGitDiff,
} from "@/components/backlog/development/development-workspace"
import { totalDiffStats } from "@/components/backlog/development/development-diff-stats-data"
import { DevelopmentDiffSection } from "@/components/backlog/development/development-diff-section"
import { GitHubRepositoryCard } from "@/components/git/git-github-repository-card"
import { GitRefLabels } from "@/components/git/git-ref-label"
import { DevelopmentFileIcon } from "@/components/backlog/development/development-file-icon"
import { GitBranchIcon, GitCommitIcon, GitMergeIcon } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function GitInspectorPanel({
  commits,
  diff,
  diffLoading,
  selected,
  status,
}: {
  commits: GitLogCommit[]
  diff?: string
  diffLoading: boolean
  selected?: GitSelection
  status?: GitStatusResult
}) {
  const diffs = React.useMemo(
    () => normalizeDiffs(parseGitDiff(diff ?? "")),
    [diff]
  )

  return (
    <aside className="flex min-h-[34rem] min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-xl ring-1 shadow-black/10 ring-foreground/10 xl:min-h-0">
      <InspectorHeader
        commits={commits}
        diffLoading={diffLoading}
        diffs={diffs}
        selected={selected}
        status={status}
      />
      <div className="min-h-0 flex-1">
        {diffLoading ? <DiffSkeleton /> : null}
        {!diffLoading && selected ? (
          <DiffStack diffs={diffs} singleFile={selected.type === "file"} />
        ) : null}
        {!diffLoading && !selected ? (
          <RepositoryOverview status={status} />
        ) : null}
      </div>
    </aside>
  )
}

function InspectorHeader({
  commits,
  diffLoading,
  diffs,
  selected,
  status,
}: {
  commits: GitLogCommit[]
  diffLoading: boolean
  diffs: ReturnType<typeof parseGitDiff>
  selected?: GitSelection
  status?: GitStatusResult
}) {
  if (selected?.type === "commit") {
    const commit = commits.find((item) => item.hash === selected.hash)
    return (
      <CommitHeader commit={commit} diffLoading={diffLoading} diffs={diffs} />
    )
  }
  if (selected?.type === "file") {
    const file = status?.files.find((item) => item.path === selected.path)
    return (
      <FileHeader
        diffLoading={diffLoading}
        diffs={diffs}
        file={file}
        selected={selected}
      />
    )
  }
  return <OverviewHeader status={status} />
}

function CommitHeader({
  commit,
  diffLoading,
  diffs,
}: {
  commit?: GitLogCommit
  diffLoading: boolean
  diffs: ReturnType<typeof parseGitDiff>
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 border-b px-3 py-3">
      <HeaderIcon>
        {commit && commit.parents.length > 1 ? (
          <GitMergeIcon className="size-4" />
        ) : (
          <GitCommitIcon className="size-4" />
        )}
      </HeaderIcon>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span
          className="line-clamp-2 text-sm leading-5 font-medium break-words"
          title={commit?.message}
        >
          {commit?.message ?? "Commit"}
        </span>
        {commit ? <CommitMeta commit={commit} /> : null}
        <DiffSummary diffLoading={diffLoading} diffs={diffs} />
      </div>
    </div>
  )
}

function CommitMeta({ commit }: { commit: GitLogCommit }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 rounded-md bg-foreground/8 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
          {shortGitHash(commit.hash)}
        </span>
        <span className="min-w-0 truncate">{commit.authorName}</span>
        <span aria-hidden className="text-muted-foreground/50">
          ·
        </span>
        <span className="shrink-0">{gitDateLabel(commit.date)}</span>
      </div>
      <GitRefLabels className="flex-wrap" max={3} refs={commit.refs} />
    </div>
  )
}

function FileHeader({
  diffLoading,
  diffs,
  file,
  selected,
}: {
  diffLoading: boolean
  diffs: ReturnType<typeof parseGitDiff>
  file?: GitStatusFile
  selected: Extract<GitSelection, { type: "file" }>
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 border-b px-3 py-3">
      <HeaderIcon>
        <DevelopmentFileIcon
          className="size-4"
          node={{ path: selected.path, type: "file" }}
        />
      </HeaderIcon>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="truncate text-sm font-medium" title={selected.path}>
          {selected.path}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {file ? (
            <span
              className={cn("font-medium", gitStatusTextClassName(file.status))}
            >
              {gitStatusName(file.status)}
            </span>
          ) : null}
          {file ? (
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
          ) : null}
          <span>{selected.staged ? "Staged diff" : "Workspace diff"}</span>
        </div>
        <DiffSummary diffLoading={diffLoading} diffs={diffs} />
      </div>
    </div>
  )
}

function OverviewHeader({ status }: { status?: GitStatusResult }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 border-b px-3 py-3">
      <HeaderIcon>
        <GitBranchIcon className="size-4" />
      </HeaderIcon>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {status?.branch.current ?? "Repository"}
        </div>
        <div className="text-xs text-muted-foreground">Workspace overview</div>
      </div>
    </div>
  )
}

function HeaderIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground ring-1 ring-foreground/8">
      {children}
    </span>
  )
}

function RepositoryOverview({ status }: { status?: GitStatusResult }) {
  const staged = status?.files.filter((file) => file.staged).length ?? 0
  const changed = status?.files.filter((file) => file.unstaged).length ?? 0

  return (
    <div className="grid gap-3 p-3">
      <GitHubRepositoryCard remote={status?.remote} />
      <OverviewMetric label="Staged files" value={staged} />
      <OverviewMetric label="Workspace changes" value={changed} />
      <OverviewMetric label="Ahead" value={status?.branch.ahead ?? 0} />
      <OverviewMetric label="Behind" value={status?.branch.behind ?? 0} />
    </div>
  )
}

function OverviewMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-foreground/4 px-3 py-2 ring-1 ring-foreground/8">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-medium">{value}</span>
    </div>
  )
}

function DiffStack({
  diffs,
  singleFile,
}: {
  diffs: ReturnType<typeof parseGitDiff>
  singleFile: boolean
}) {
  if (diffs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No diff available.
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 divide-y divide-foreground/10 overflow-y-auto bg-muted/50 dark:bg-neutral-900">
      {diffs.map((diff) => (
        <DevelopmentDiffSection
          diff={diff}
          hideHeader={singleFile && diffs.length === 1}
          key={diff.file}
        />
      ))}
    </div>
  )
}

function DiffSummary({
  diffLoading,
  diffs,
}: {
  diffLoading: boolean
  diffs: ReturnType<typeof parseGitDiff>
}) {
  if (diffLoading) {
    return <div className="text-xs text-muted-foreground">Loading diff</div>
  }
  const summary = diffSummary(diffs)
  if (!summary) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">
      <span>{summary.files}</span>
      <span className="font-medium text-emerald-600 dark:text-emerald-400">
        +{summary.additions}
      </span>
      <span className="font-medium text-red-600 dark:text-red-400">
        −{summary.deletions}
      </span>
    </div>
  )
}

function diffSummary(diffs: ReturnType<typeof parseGitDiff>) {
  if (diffs.length === 0) return undefined
  const { additions, deletions, files: fileCount } = totalDiffStats(diffs)
  const files =
    fileCount === 1 ? "1 file changed" : `${fileCount} files changed`
  return { additions, deletions, files }
}

function DiffSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-3">
      <Skeleton className="h-8 w-3/4" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-36 w-full" />
    </div>
  )
}
