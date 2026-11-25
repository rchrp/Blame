import type { GitLogCommitRef } from "@/context/platform"
import { gitRefClassName, visibleGitRefs } from "@/components/git/git-format"
import { CloudIcon, GitBranchIcon, TagIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export function GitRefLabels({
  className,
  max,
  refs,
}: {
  className?: string
  max: number
  refs: readonly GitLogCommitRef[]
}) {
  if (refs.length === 0) return null
  const { hidden, visible } = visibleGitRefs(refs, max)

  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {visible.map((ref) => (
        <GitRefLabel key={`${ref.type}:${ref.name}`} gitRef={ref} />
      ))}
      {hidden > 0 ? (
        <span
          className="inline-flex h-5 shrink-0 items-center rounded-md bg-foreground/8 px-1.5 text-[11px] font-medium text-muted-foreground"
          title={refs.map((ref) => ref.name).join(", ")}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  )
}

function GitRefLabel({ gitRef }: { gitRef: GitLogCommitRef }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-32 min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium",
        gitRefClassName(gitRef.type)
      )}
      title={gitRef.name}
    >
      <GitRefIcon type={gitRef.type} />
      <span className="truncate">{gitRef.name}</span>
    </span>
  )
}

function GitRefIcon({ type }: { type: GitLogCommitRef["type"] }) {
  if (type === "tag") return <TagIcon className="size-3 shrink-0" />
  if (type === "remote") return <CloudIcon className="size-3 shrink-0" />
  if (type === "head" || type === "branch")
    return <GitBranchIcon className="size-3 shrink-0" />
  return null
}
