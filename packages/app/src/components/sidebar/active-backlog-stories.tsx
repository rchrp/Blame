import { SidebarListSkeleton } from "@/components/shared/skeletons"
import * as React from "react"

import {
  useBacklogSelector,
  type useBacklogStore,
} from "@/components/backlog/data/backlog-store"
import {
  selectBacklogStory,
  selectedBacklogStoryId,
  subscribeToBacklogStorySelection,
} from "@/components/backlog/data/backlog-navigation"
import type { UserStory } from "@/components/backlog/data/backlog-data"
import { AppLink } from "@/components/navigation/app-link"
import {
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

const storyPageSize = 5

export function ActiveBacklogStories({ pathname }: { pathname: string }) {
  const backlog = useBacklogSelector(activeBacklog, sameActiveBacklog)
  const selectedStoryId = React.useSyncExternalStore(
    subscribeToBacklogStorySelection,
    selectedBacklogStoryId
  )
  const [pagination, setPagination] = React.useState({
    count: storyPageSize,
    projectId: backlog.projectId,
  })
  const stories = backlog.stories
  const visibleCount =
    pagination.projectId === backlog.projectId
      ? pagination.count
      : storyPageSize
  const visibleStories = stories.slice(0, visibleCount)

  function setVisibleCount(update: (current: number) => number) {
    setPagination({
      count: update(visibleCount),
      projectId: backlog.projectId,
    })
  }

  if (!backlog.loading && !stories.length) return null

  return (
    <SidebarMenuSub className="gap-0.5 pb-1">
      {backlog.loading && !stories.length ? (
        <SidebarMenuSubItem>
          <SidebarListSkeleton rows={2} />
        </SidebarMenuSubItem>
      ) : null}
      {visibleStories.map((story) => (
        <SidebarMenuSubItem key={story.id}>
          <SidebarMenuButton
            asChild
            className="h-8 pr-15 pl-2 text-sm"
            isActive={pathname === "/backlog" && selectedStoryId === story.id}
            tooltip={story.title}
          >
            <AppLink
              href="/backlog"
              onClick={() => selectBacklogStory(story.id)}
            >
              <span className="truncate">{story.title}</span>
              <span className="absolute right-2 text-xs text-muted-foreground">
                {story.status === "in-review" ? "Review" : "Progress"}
              </span>
            </AppLink>
          </SidebarMenuButton>
        </SidebarMenuSubItem>
      ))}
      {stories.length > storyPageSize ? (
        <SidebarMenuSubItem className="flex items-center gap-1 px-1 pt-1">
          {visibleCount < stories.length ? (
            <button
              className="rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              onClick={() =>
                setVisibleCount((current) =>
                  Math.min(current + storyPageSize, stories.length)
                )
              }
              type="button"
            >
              Show more
            </button>
          ) : null}
          {visibleCount > storyPageSize ? (
            <button
              className="rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              onClick={() =>
                setVisibleCount((current) =>
                  Math.max(storyPageSize, current - storyPageSize)
                )
              }
              type="button"
            >
              Show less
            </button>
          ) : null}
        </SidebarMenuSubItem>
      ) : null}
    </SidebarMenuSub>
  )
}

// What the list shows, which an agent saving its run does not change.
function activeBacklog(
  backlog: Pick<
    ReturnType<typeof useBacklogStore>,
    "loading" | "projectId" | "stories"
  >
) {
  return {
    loading: backlog.loading,
    projectId: backlog.projectId,
    stories: backlog.stories
      .filter(isActiveStory)
      .sort(compareStoriesByMostRecent)
      .map(({ id, status, title }) => ({ id, status, title })),
  }
}

function sameActiveBacklog(
  left: ReturnType<typeof activeBacklog>,
  right: ReturnType<typeof activeBacklog>
) {
  return (
    left.loading === right.loading &&
    left.projectId === right.projectId &&
    left.stories.length === right.stories.length &&
    left.stories.every(
      (story, index) =>
        story.id === right.stories[index].id &&
        story.status === right.stories[index].status &&
        story.title === right.stories[index].title
    )
  )
}

function isActiveStory(story: UserStory) {
  return story.status === "in-progress" || story.status === "in-review"
}

function compareStoriesByMostRecent(left: UserStory, right: UserStory) {
  return storyTimestamp(right) - storyTimestamp(left)
}

function storyTimestamp(story: UserStory) {
  return new Date(story.updatedAt ?? story.createdAt).getTime() || 0
}
