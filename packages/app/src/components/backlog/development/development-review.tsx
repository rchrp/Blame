import * as React from "react"
import type { VcsFileDiff } from "@/components/backlog/development/development-workspace"
import { ChevronDownIcon, ChevronRightIcon, FileDiffIcon } from "lucide-react"
import { Collapsible } from "radix-ui"

import { DiffStats } from "@/components/backlog/development/development-diff-stats"
import { DevelopmentDiffView } from "@/components/backlog/development/development-diff-view"
import {
  DevelopmentGraph,
  reviewSurfaceClassName,
} from "@/components/backlog/development/development-graph"
import { DevelopmentFileIcon } from "@/components/backlog/development/development-file-icon"
import { DevelopmentScrollArea } from "@/components/backlog/development/development-scroll-area"
import {
  diffKindClassName,
  filename,
} from "@/components/backlog/development/development-workspace"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function DevelopmentReview({
  diffs,
  initialOpenFilePath,
  loading,
  onOpenFile,
}: {
  diffs: VcsFileDiff[]
  initialOpenFilePath?: string
  loading: boolean
  onOpenFile: (path: string) => void
}) {
  if (loading) return <ReviewSkeleton />

  if (diffs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <FileDiffIcon className="size-8 text-muted-foreground" />
        <div>
          <h3 className="font-heading text-lg font-semibold">
            No local changes
          </h3>
          <p className="text-sm text-muted-foreground">
            The worktree matches its local HEAD.
          </p>
        </div>
      </div>
    )
  }

  return (
    <DevelopmentScrollArea className="h-full">
      <div className="flex min-w-0 flex-col gap-3 p-3">
        <DevelopmentGraph diffs={diffs} onOpenFile={onOpenFile} />
        {diffs.map((diff) => (
          <ReviewDiffCard
            defaultOpen={diff.file === initialOpenFilePath}
            diff={diff}
            key={diff.file}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </DevelopmentScrollArea>
  )
}

function ReviewDiffCard({
  defaultOpen,
  diff,
  onOpenFile,
}: {
  defaultOpen: boolean
  diff: VcsFileDiff
  onOpenFile: (path: string) => void
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const cardRef = React.useRef<HTMLDivElement>(null)
  const kind =
    diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

  React.useEffect(() => {
    if (!defaultOpen) return
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [defaultOpen])

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Card
        className={reviewSurfaceClassName("min-w-0 scroll-mt-3 gap-0 py-0")}
        ref={cardRef}
        size="sm"
      >
        <CardHeader className="min-w-0 px-0">
          <Collapsible.Trigger asChild>
            <button
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50"
              type="button"
            >
              <div className="flex min-w-0 items-center gap-2">
                {open ? (
                  <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <DevelopmentFileIcon
                  className="shrink-0"
                  node={{ path: diff.file, type: "file" }}
                />
                <div className="min-w-0">
                  <CardTitle className="truncate">
                    {filename(diff.file)}
                  </CardTitle>
                  <CardDescription className="truncate text-xs">
                    {diff.file}
                  </CardDescription>
                </div>
              </div>
              <CardAction className="static row-auto flex items-center gap-2 self-center justify-self-end">
                <Badge
                  className={cn("shrink-0", diffKindClassName(kind))}
                  variant="outline"
                >
                  {diff.status ?? "modified"}
                </Badge>
                <DiffStats diff={diff} />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenFile(diff.file)
                  }}
                >
                  Open
                </Button>
              </CardAction>
            </button>
          </Collapsible.Trigger>
        </CardHeader>
        <Collapsible.Content>
          <CardContent className="min-w-0 overflow-hidden border-t p-4">
            <DevelopmentScrollArea className="max-h-[60vh] w-full max-w-full min-w-0">
              <div className="w-max min-w-full">
                <DevelopmentDiffView diff={diff} scroll={false} />
              </div>
            </DevelopmentScrollArea>
          </CardContent>
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>
  )
}

function ReviewSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-44" />
        <Button disabled size="sm" variant="outline">
          Loading
        </Button>
      </div>
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}
