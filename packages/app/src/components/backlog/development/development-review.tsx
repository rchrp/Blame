import type { VcsFileDiff } from "@/components/backlog/development/development-workspace"
import { FileDiffIcon } from "lucide-react"

import { DevelopmentDiffSection } from "@/components/backlog/development/development-diff-section"
import { DevelopmentScrollArea } from "@/components/backlog/development/development-scroll-area"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

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
    <DevelopmentScrollArea className="h-full bg-muted/50 dark:bg-neutral-900">
      <div className="divide-y divide-foreground/10">
        {diffs.map((diff) => (
          <DevelopmentDiffSection
            defaultOpen={diff.file === initialOpenFilePath}
            diff={diff}
            key={`${diff.file}:${diff.file === initialOpenFilePath}`}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </DevelopmentScrollArea>
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
