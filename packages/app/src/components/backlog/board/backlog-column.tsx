import * as React from "react"
import { InfoIcon, LoaderCircleIcon, PlusIcon } from "lucide-react"

import {
  type BacklogAction,
  backlogColumns,
  type BacklogColumnId,
  type UserStory,
} from "@/components/backlog/data/backlog-data"
import type { OpenDrawer } from "@/components/backlog/shared/backlog-types"
import { UserStoryCard } from "@/components/backlog/board/user-story-card"
import { equalUserStoryCardStory } from "@/components/backlog/board/user-story-card-equality"
import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import type {
  RejectChoice,
  StopAgentChoice,
} from "@/components/backlog/actions/story-action-dialogs"
import { StoryCardSkeleton } from "@/components/shared/skeletons"
import { Button } from "@/components/ui/button"
import {
  KanbanColumn,
  KanbanColumnHeader,
} from "@/components/shared/kanban-board"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { recordPerformanceCount } from "@/lib/performance-diagnostics"

const storiesPageSize = 20
const storiesLoadAheadPx = 240

const columnColors = {
  backlog: "border-emerald-500",
  ready: "border-blue-500",
  "in-progress": "border-amber-500",
  "in-review": "border-violet-500",
  done: "border-orange-500",
  discarded: "border-rose-500",
} satisfies Record<BacklogColumnId, string>

type BacklogColumnProps = {
  column: (typeof backlogColumns)[number]
  diffStats?: (story: UserStory) => UserStoryDiffStats | undefined
  onAction: (
    story: UserStory,
    action: BacklogAction
  ) => Promise<UserStory | void>
  onCreateUserStory: () => void
  onDeleteUserStory: (story: UserStory) => Promise<void>
  onOpenDrawer: OpenDrawer
  onOpenWorktree: (story: UserStory) => Promise<void>
  onReject: (story: UserStory, choice: RejectChoice) => Promise<UserStory>
  reviewDiffEmpty?: (story: UserStory) => boolean
  onStopAgent: (story: UserStory, choice: StopAgentChoice) => Promise<UserStory>
  onUnpauseAgent: (story: UserStory) => Promise<UserStory>
  queueInitializing?: boolean
  storyCleanup?: (story: UserStory) => boolean
  storySetupInitializing?: (story: UserStory) => boolean
  storyTitleGenerating?: (story: UserStory) => boolean
  stories: UserStory[]
  loading?: boolean
}

export const BacklogColumn = React.memo(function BacklogColumn({
  column,
  diffStats,
  onAction,
  onCreateUserStory,
  onDeleteUserStory,
  onOpenDrawer,
  onOpenWorktree,
  onReject,
  reviewDiffEmpty,
  onStopAgent,
  onUnpauseAgent,
  queueInitializing,
  storyCleanup,
  storySetupInitializing,
  storyTitleGenerating,
  stories,
  loading,
}: BacklogColumnProps) {
  recordPerformanceCount("backlog.column.render")
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const loadMoreRef = React.useRef<HTMLDivElement>(null)
  const [visibleStoryCount, setVisibleStoryCount] =
    React.useState(storiesPageSize)
  const sortedStories = React.useMemo(
    () => [...stories].sort(compareStoriesByRecency),
    [stories]
  )
  const visibleStories = React.useMemo(
    () => sortedStories.slice(0, visibleStoryCount),
    [sortedStories, visibleStoryCount]
  )
  const hasMoreStories = visibleStoryCount < sortedStories.length
  const loadMoreStories = React.useCallback(() => {
    setVisibleStoryCount((current) =>
      Math.min(current + storiesPageSize, sortedStories.length)
    )
  }, [sortedStories.length])

  React.useEffect(() => {
    if (!hasMoreStories) return
    const viewport = viewportRef.current
    const sentinel = loadMoreRef.current
    if (!viewport || !sentinel) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) loadMoreStories()
      },
      {
        root: viewport,
        rootMargin: `0px 0px ${storiesLoadAheadPx}px`,
      }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreStories, loadMoreStories])

  return (
    <KanbanColumn
      viewportRef={viewportRef}
      header={
        <BacklogColumnHeader
          column={column}
          count={stories.length}
          queueInitializing={queueInitializing}
        />
      }
    >
      {visibleStories.map((story) => (
        <UserStoryCard
          key={story.id}
          cleanup={storyCleanup?.(story)}
          diffStats={diffStats?.(story)}
          onAction={onAction}
          onDeleteUserStory={onDeleteUserStory}
          onOpenDrawer={onOpenDrawer}
          onOpenWorktree={onOpenWorktree}
          onReject={onReject}
          reviewDiffEmpty={reviewDiffEmpty?.(story)}
          onStopAgent={onStopAgent}
          onUnpauseAgent={onUnpauseAgent}
          setupInitializing={
            storySetupInitializing?.(story) || queueInitializing
          }
          story={story}
          titleGenerating={storyTitleGenerating?.(story)}
        />
      ))}
      {hasMoreStories && <div ref={loadMoreRef} className="h-px" />}
      {loading && !stories.length
        ? Array.from({ length: skeletonCounts[column.id] }, (_, index) => (
            <StoryCardSkeleton key={index} lines={(index % 2) + 1} />
          ))
        : null}
      {!loading && !stories.length && column.id !== "backlog" ? (
        <p className="px-4 py-6 text-center text-xs text-pretty text-muted-foreground">
          {emptyColumnHints[column.id]}
        </p>
      ) : null}
      {column.id === "backlog" && (
        <Button
          type="button"
          variant="ghost"
          className="flex h-8 items-center justify-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={onCreateUserStory}
        >
          <PlusIcon className="size-4" />
          New User Story
        </Button>
      )}
    </KanbanColumn>
  )
}, equalBacklogColumnProps)

// Roughly how a typical board fills up, so loading looks like the real thing.
const skeletonCounts = {
  backlog: 3,
  ready: 2,
  "in-progress": 2,
  "in-review": 1,
  done: 2,
  discarded: 1,
} satisfies Record<BacklogColumnId, number>

const emptyColumnHints = {
  backlog: "",
  ready: "Stories queued for an agent wait here.",
  "in-progress": "Agents at work show up here, live.",
  "in-review": "Finished work waits here for your review.",
  done: "Merged stories land here.",
  discarded: "Nothing set aside.",
} satisfies Record<BacklogColumnId, string>

function compareStoriesByRecency(left: UserStory, right: UserStory) {
  const createdAtDifference =
    Date.parse(right.createdAt) - Date.parse(left.createdAt)
  if (Number.isFinite(createdAtDifference) && createdAtDifference !== 0)
    return createdAtDifference
  if (right.storyNumber !== left.storyNumber)
    return right.storyNumber - left.storyNumber
  return right.id.localeCompare(left.id)
}

function equalBacklogColumnProps(
  previous: BacklogColumnProps,
  next: BacklogColumnProps
) {
  const keys = Object.keys(next) as (keyof BacklogColumnProps)[]
  return keys.every((key) => {
    if (key === "stories")
      return equalStoryReferences(previous.stories, next.stories)
    return previous[key] === next[key]
  })
}

function equalStoryReferences(previous: UserStory[], next: UserStory[]) {
  return (
    previous.length === next.length &&
    previous.every((story, index) => {
      const nextStory = next[index]
      return Boolean(nextStory && equalUserStoryCardStory(story, nextStory))
    })
  )
}

export function BacklogColumnHeader({
  column,
  count,
  queueInitializing,
}: {
  column: BacklogColumnHeaderColumn
  count: number
  queueInitializing?: boolean
}) {
  return (
    <KanbanColumnHeader
      title={column.title}
      description={column.description}
      count={count}
      color={columnColors[column.id]}
    >
      {queueInitializing && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3 animate-spin" />
          Project initialization in progress
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Project initialization details"
              >
                <InfoIcon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-64 text-pretty">
              Blame is analyzing the project runtime and preview setup. This
              only happens the first time the project is opened; afterwards, the
              result is saved.
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </KanbanColumnHeader>
  )
}

type BacklogColumnHeaderColumn = {
  description: string
  id: BacklogColumnId
  title: string
}
