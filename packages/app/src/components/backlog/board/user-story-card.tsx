import * as React from "react"
import type { PullRequestAvailability } from "@blame/agent-runtime"
import { LoaderCircleIcon, ShieldCheckIcon } from "lucide-react"

import {
  type BacklogAction,
  type UserStory,
  userStoryDisplayId,
} from "@/components/backlog/data/backlog-data"
import type {
  RejectChoice,
  StopAgentChoice,
} from "@/components/backlog/actions/story-action-dialogs"
import {
  storyDetail,
  storyStatus,
} from "@/components/backlog/shared/backlog-helpers"
import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import { StoryStatusBadge } from "@/components/backlog/shared/backlog-status-badge"
import { UserStoryTitleCloud } from "@/components/backlog/shared/user-story-title-cloud"
import type { OpenDrawer } from "@/components/backlog/shared/backlog-types"
import { equalUserStoryCardStory } from "@/components/backlog/board/user-story-card-equality"
import { StoryActions } from "@/components/backlog/actions/story-actions"
import { StoryContributors } from "@/components/backlog/shared/story-contributors"
import { StoryRunModeIcon } from "@/components/backlog/shared/story-run-mode-icon"
import { storyStartFailure } from "@/components/backlog/shared/story-start-failure"
import {
  storyWaitText,
  useStoryWait,
} from "@/components/backlog/data/story-queue-waits"
import { PlanProgressLine } from "@/components/chat/plan/plan-progress-line"
import { usePlanProgress } from "@/components/chat/plan/plan-progress-store"
import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"
import { useAnimatedBorderEffect } from "@/hooks/use-animated-border-effect"
import { recordPerformanceCount } from "@/lib/performance-diagnostics"
import { storyLocation } from "@/pages/backlog/story-engine"
import { isSecurityStory } from "@/components/security/data/security-remediation"
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

type UserStoryCardBodyProps = {
  cleanup?: boolean
  interactive?: boolean
  onOpenDrawer?: OpenDrawer
  setupInitializing?: boolean
  story: UserStory
  titleGenerating?: boolean
}

const storyCardClassName =
  "group/user-story relative z-1 rounded-lg bg-popover shadow-xs ring-foreground/10 dark:bg-neutral-800"

type UserStoryCardProps = {
  cleanup?: boolean
  diffStats?: UserStoryDiffStats
  onAction: (
    story: UserStory,
    action: BacklogAction
  ) => Promise<UserStory | void>
  onCheckPullRequest?: () => Promise<PullRequestAvailability>
  onDeleteUserStory: (story: UserStory) => Promise<void>
  onOpenDrawer: OpenDrawer
  onOpenWorktree: (story: UserStory) => Promise<void>
  onReject: (story: UserStory, choice: RejectChoice) => Promise<UserStory>
  onStopAgent: (story: UserStory, choice: StopAgentChoice) => Promise<UserStory>
  onUnpauseAgent: (story: UserStory) => Promise<UserStory>
  reviewDiffEmpty?: boolean
  setupInitializing?: boolean
  story: UserStory
  titleGenerating?: boolean
}

export const UserStoryCard = React.memo(function UserStoryCard({
  diffStats,
  onAction,
  onCheckPullRequest,
  onDeleteUserStory,
  onOpenDrawer,
  onOpenWorktree,
  onReject,
  reviewDiffEmpty,
  onStopAgent,
  onUnpauseAgent,
  cleanup,
  setupInitializing,
  story,
  titleGenerating,
}: UserStoryCardProps) {
  recordPerformanceCount("backlog.card.render")
  const stateEffectRef = useUserStoryStateEffect(story.status)
  return (
    <div
      ref={stateEffectRef}
      className="user-story-state-effect"
      data-story-id={story.id}
      data-story-state={story.status}
    >
      <Card size="sm" className={storyCardClassName}>
        <UserStoryCardBody
          cleanup={cleanup}
          onOpenDrawer={onOpenDrawer}
          setupInitializing={setupInitializing}
          story={story}
          titleGenerating={titleGenerating}
        />
        <CardFooter className="border-foreground/8 bg-transparent group-data-[size=sm]/card:px-3 group-data-[size=sm]/card:py-2">
          <StoryActions
            diffStats={diffStats}
            onAction={onAction}
            onCheckPullRequest={onCheckPullRequest}
            onDeleteUserStory={onDeleteUserStory}
            onOpenDrawer={onOpenDrawer}
            onOpenWorktree={onOpenWorktree}
            onReject={onReject}
            reviewDiffEmpty={reviewDiffEmpty}
            onStopAgent={onStopAgent}
            onUnpauseAgent={onUnpauseAgent}
            story={story}
          />
        </CardFooter>
      </Card>
    </div>
  )
}, equalUserStoryCardProps)

function equalUserStoryCardProps(
  previous: UserStoryCardProps,
  next: UserStoryCardProps
) {
  const keys = Object.keys(next) as (keyof UserStoryCardProps)[]
  return keys.every((key) => {
    if (key === "story")
      return equalUserStoryCardStory(previous.story, next.story)
    return previous[key] === next[key]
  })
}

export function ReadOnlyUserStoryCard({ story }: { story: UserStory }) {
  const stateEffectRef = useUserStoryStateEffect(story.status)
  return (
    <div
      ref={stateEffectRef}
      className="user-story-state-effect"
      data-story-id={story.id}
      data-story-state={story.status}
    >
      <Card size="sm" className={storyCardClassName}>
        <UserStoryCardBody interactive={false} story={story} />
      </Card>
    </div>
  )
}

function useUserStoryStateEffect(status: UserStory["status"]) {
  const effect =
    status === "in-progress"
      ? "story-progress"
      : status === "in-review"
        ? "story-review"
        : undefined
  return useAnimatedBorderEffect(effect)
}

function UserStoryCardBody({
  cleanup,
  interactive = true,
  onOpenDrawer,
  setupInitializing,
  story,
  titleGenerating,
}: UserStoryCardBodyProps) {
  return (
    <>
      <CardHeader className="gap-y-1.5 has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto]">
        <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          <StoryContributors story={story} />
          <span className="shrink-0">{userStoryLabel(story)}</span>
          <StoryRunModeIcon story={story} />
          {isSecurityStory(story.summary) ? (
            <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-300">
              <ShieldCheckIcon className="size-3" /> Security
            </span>
          ) : null}
        </p>
        {setupInitializing && (
          <StoryProgressLabel label="Initializing story setup" />
        )}
        {cleanup && <StoryProgressLabel label="Removing story worktree" />}
        <CardTitle className="min-w-0 text-base leading-snug">
          {interactive && onOpenDrawer ? (
            <Button
              type="button"
              variant="link"
              className="h-auto max-w-full min-w-0 shrink justify-start p-0 text-left text-base leading-snug font-medium break-words whitespace-normal text-card-foreground transition-colors group-hover/user-story:text-blue-600 hover:cursor-pointer dark:group-hover/user-story:text-blue-300"
              onClick={() => onOpenDrawer(drawerTarget(story))}
            >
              <UserStoryTitleCloud
                active={titleGenerating}
                className="block w-full"
              >
                <span className="block break-words">{story.title}</span>
              </UserStoryTitleCloud>
            </Button>
          ) : (
            <UserStoryTitleCloud
              active={titleGenerating}
              className="block w-full"
            >
              <span className="block break-words text-card-foreground">
                {story.title}
              </span>
            </UserStoryTitleCloud>
          )}
        </CardTitle>
        {storyStatus(story) && (
          <CardAction>
            <StoryStatusBadge status={storyStatus(story)} />
          </CardAction>
        )}
      </CardHeader>
      {storyDetail(story) && (
        <CardContent>
          <p className="text-xs font-medium text-muted-foreground">
            {storyDetail(story)}
          </p>
        </CardContent>
      )}
      <StoryPlanProgress story={story} />
      <StoryStartFailure story={story} />
    </>
  )
}

// How far the agent's plan is, while it works: the card reads a small event
// of its own, never the conversation.
function StoryPlanProgress({ story }: { story: UserStory }) {
  const platform = usePlatform()
  const running = story.agentStatus === "Running"
  const progress = usePlanProgress(
    running ? story.engineSessionId : undefined,
    storyLocation(story.workspaceMode ?? "direct", platform.platform)
  )
  if (!running || !progress || progress.finished) return null
  return (
    <CardContent>
      <PlanProgressLine progress={progress} step />
    </CardContent>
  )
}

function StoryStartFailure({ story }: { story: UserStory }) {
  const failure = storyStartFailure(story)
  if (!failure) return <StoryQueueWait story={story} />
  return (
    <CardContent>
      <p
        className="line-clamp-3 text-xs font-medium break-words text-destructive"
        title={failure}
      >
        {failure}
      </p>
    </CardContent>
  )
}

// Why a queued story does not start yet, as the story service says it.
function StoryQueueWait({ story }: { story: UserStory }) {
  const wait = useStoryWait(story.id)
  if (story.status !== "ready" || !wait) return null
  const text = storyWaitText(wait)
  return (
    <CardContent>
      <p
        className="line-clamp-3 text-xs font-medium break-words text-muted-foreground"
        title={text}
      >
        {text}
      </p>
    </CardContent>
  )
}

function StoryProgressLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <LoaderCircleIcon className="size-3 animate-spin" />
      {label}
    </div>
  )
}

function drawerTarget(story: UserStory) {
  return {
    userStory: story,
    mode:
      story.status === "backlog" || story.status === "discarded"
        ? "edit"
        : "view",
    initialTab: "user-story",
  } as const
}

function userStoryLabel(story: UserStory) {
  return userStoryDisplayId(story)
}
