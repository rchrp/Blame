import * as React from "react"
import type { EpicState } from "@blame/agent-runtime/engine-protocol"
import {
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  Loader2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import type { Epic } from "@/components/orchestrator/data/epic-data"
import {
  epicReadyForReview,
  type EpicBoardGroup,
} from "@/components/orchestrator/data/epic-board"
import { usePlatform } from "@/context/platform"

type Action = "merge" | "pull-request"

/**
 * The person's review of a finished epic (docs/orchestrator.md, "The
 * review"): its branch merged into the target, or its pull request opened.
 * Once merged it says so; an opened pull request stays linked.
 */
export function EpicReview({
  epic,
  groups,
  state,
  onReviewed,
}: {
  epic: Epic
  groups: readonly EpicBoardGroup[]
  state: EpicState | undefined
  onReviewed: () => Promise<unknown>
}) {
  const platform = usePlatform()
  const [running, setRunning] = React.useState<Action>()
  const target = epic.targetBranch ?? "the target branch"
  const pullRequestUrl =
    typeof epic.settings.pullRequestUrl === "string"
      ? epic.settings.pullRequestUrl
      : undefined

  if (epic.status === "completed")
    return (
      <p className="mx-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground sm:mx-10">
        <GitMergeIcon className="size-3.5 shrink-0" />
        <span>
          Merged into {target}
          {epic.mergeCommit ? ` · ${epic.mergeCommit.slice(0, 7)}` : ""}
        </span>
      </p>
    )
  if (
    epic.status === "discarded" ||
    state?.conversation === "working" ||
    !epicReadyForReview(groups)
  )
    return null

  async function review(action: Action) {
    const engine = platform.engine
    if (!engine || running) return
    setRunning(action)
    try {
      const result = await engine.call("epicReview", {
        epicId: epic.id,
        action,
      })
      await onReviewed().catch(() => undefined)
      if (result.action === "merge")
        toast.success(`Merged into ${result.targetBranch}`, {
          description: `Commit ${result.mergeCommit.slice(0, 7)}`,
          position: "bottom-right",
        })
      else
        toast.success(
          result.created ? "Pull request opened" : "Pull request found",
          { description: result.url, position: "bottom-right" }
        )
    } catch (error) {
      toast.error(
        action === "merge"
          ? `Couldn't merge into ${target}`
          : "Couldn't open the pull request",
        {
          description: error instanceof Error ? error.message : String(error),
          position: "bottom-right",
        }
      )
    } finally {
      setRunning(undefined)
    }
  }

  return (
    <div className="mt-auto min-w-0 px-2 text-sm sm:px-10">
      <div
        className="grid gap-2 rounded-xl border border-border/70 px-4 py-3"
        role="group"
        aria-label="Review the epic"
      >
        <p className="text-sm leading-relaxed text-muted-foreground">
          Every story is merged into{" "}
          <code className="text-foreground">{epic.branch}</code>. Review it,
          then merge it into {target} or open a pull request.
        </p>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Button
            size="sm"
            type="button"
            disabled={Boolean(running) || !platform.engine}
            className="h-auto min-h-7 bg-foreground whitespace-normal text-background hover:bg-foreground/85"
            onClick={() => void review("merge")}
          >
            {running === "merge" ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <GitMergeIcon />
            )}
            Merge into {target}
          </Button>
          {pullRequestUrl ? (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              className="h-auto min-h-7"
              onClick={() => platform.openExternalLink?.(pullRequestUrl)}
            >
              <ExternalLinkIcon /> View pull request
            </Button>
          ) : (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              disabled={Boolean(running) || !platform.engine}
              className="h-auto min-h-7"
              onClick={() => void review("pull-request")}
            >
              {running === "pull-request" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <GitPullRequestIcon />
              )}
              Open pull request
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
