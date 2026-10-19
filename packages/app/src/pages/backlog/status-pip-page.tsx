import * as React from "react"

import { UserStoryCard } from "@/components/backlog/board/user-story-card"
import type {
  BacklogAction,
  BacklogColumnId,
  UserStory,
} from "@/components/backlog/data/backlog-data"
import type {
  RejectChoice,
  StopAgentChoice,
} from "@/components/backlog/actions/story-action-dialogs"
import type { DrawerTarget } from "@/components/backlog/shared/backlog-types"
import { AnimatePresence, motion } from "motion/react"

import { ScrollArea } from "@/components/ui/scroll-area"
import { usePlatform, type BacklogStatusPipSnapshot } from "@/context/platform"
import { hasModKey, isEditableTarget } from "@/lib/keyboard"
import { isBoolean, useUiMemory } from "@/lib/ui-memory"
import {
  StatusPipCompactRow,
  StatusPipHeader,
} from "@/pages/backlog/status-pip-chrome"

const activeStatuses = new Set<BacklogColumnId>(["in-progress", "in-review"])
const pageTitle = "Active User Stories"
const compactHeaderHeightPx = 41
const initialSnapshot: BacklogStatusPipSnapshot = {
  authStatus: "loading",
  hasActiveProject: false,
  loading: true,
  stories: [],
}

export function BacklogStatusPipPage() {
  const platform = usePlatform()
  const pip = platform.backlogStatusPip
  const [snapshot, setSnapshot] =
    React.useState<BacklogStatusPipSnapshot>(initialSnapshot)
  const [compact, setCompact] = useUiMemory(
    "status-pip-compact",
    false,
    isBoolean
  )
  const compactListRef = React.useRef<HTMLDivElement>(null)
  const activeStories = React.useMemo(
    () => snapshot.stories.filter(activeStory).sort(compareActiveStories),
    [snapshot.stories]
  )
  const status = statusText(
    snapshot.authStatus,
    snapshot.hasActiveProject,
    activeStories.length
  )
  const empty = emptyText(
    snapshot.authStatus,
    snapshot.hasActiveProject,
    snapshot.loading
  )
  const toggleCompact = React.useCallback(
    () => setCompact((current) => !current),
    [setCompact]
  )
  const close = pip?.close

  React.useEffect(() => {
    document.title = pageTitle
  }, [])

  React.useEffect(() => {
    return pip?.onSnapshot(setSnapshot)
  }, [pip])

  useStatusPipWindowSize(pip, compact, compactListRef)

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasModKey(event) || event.altKey) return
      if (isEditableTarget(event.target)) return
      if (event.key === "Escape" && close) close()
      else if (event.key.toLowerCase() === "c") toggleCompact()
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [close, toggleCompact])

  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <StatusPipHeader
        compact={compact}
        count={activeStories.length}
        onClose={close}
        onToggleCompact={pip?.setMode ? toggleCompact : undefined}
        status={
          snapshot.authStatus === "authenticated" && snapshot.hasActiveProject
            ? undefined
            : status
        }
      />
      <AnimatePresence initial={false} mode="popLayout">
        {compact ? (
          <motion.div
            key="compact"
            className="min-h-0 flex-1 overflow-y-auto"
            {...modeTransition}
          >
            <div ref={compactListRef} className="p-1">
              {activeStories.length ? (
                <ul className="flex flex-col">
                  <AnimatePresence initial={false}>
                    {activeStories.map((story, index) => (
                      <StatusPipCompactRow
                        key={story.id}
                        index={index}
                        story={story}
                        onOpen={(story) =>
                          requestStoryDrawer(platform, drawerTarget(story))
                        }
                      />
                    ))}
                  </AnimatePresence>
                </ul>
              ) : (
                <p className="px-2 py-2.5 text-xs text-muted-foreground">
                  {empty}
                </p>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="cards"
            className="flex min-h-0 flex-1 flex-col"
            {...modeTransition}
          >
            <ScrollArea className="min-h-0 flex-1 bg-foreground/5 dark:bg-background">
              <div className="flex flex-col gap-3 p-3">
                {activeStories.map((story) => (
                  <StatusPipStoryCard
                    key={story.id}
                    platform={platform}
                    story={story}
                  />
                ))}
                {!activeStories.length && (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {empty}
                  </div>
                )}
              </div>
            </ScrollArea>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  )
}

const modeTransition = {
  initial: { opacity: 0, scale: 0.98, filter: "blur(4px)" },
  animate: {
    opacity: 1,
    scale: 1,
    filter: "blur(0px)",
    transition: { duration: 0.24, ease: [0.16, 1, 0.3, 1] },
    transitionEnd: { filter: "none" },
  },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.12 } },
} as const

// Compact mode sizes the window to its rows; leaving it brings back the
// size the window had before.
function useStatusPipWindowSize(
  pip: ReturnType<typeof usePlatform>["backlogStatusPip"],
  compact: boolean,
  compactListRef: React.RefObject<HTMLDivElement | null>
) {
  const wasCompact = React.useRef(false)
  React.useEffect(() => {
    const setMode = pip?.setMode
    if (!setMode) return
    if (!compact) {
      if (wasCompact.current) void setMode({ compact: false })
      wasCompact.current = false
      return
    }
    wasCompact.current = true
    let sent = 0
    const send = () => {
      const list = compactListRef.current
      if (!list) return
      const contentHeight = compactHeaderHeightPx + Math.ceil(list.offsetHeight)
      if (contentHeight === sent) return
      sent = contentHeight
      void setMode({ compact: true, contentHeight })
    }
    // Wait for the compact list to mount before measuring it.
    const frame = requestAnimationFrame(send)
    const observer = new ResizeObserver(send)
    const observe = requestAnimationFrame(() => {
      if (compactListRef.current) observer.observe(compactListRef.current)
    })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(observe)
      observer.disconnect()
    }
  }, [compact, compactListRef, pip])
}

function StatusPipStoryCard({
  platform,
  story,
}: {
  platform: ReturnType<typeof usePlatform>
  story: UserStory
}) {
  return (
    <UserStoryCard
      onAction={async (story, action) => {
        await requestStoryAction(platform, story, action)
      }}
      onDeleteUserStory={async (story) => {
        await requestStoryAction(platform, story, "Delete Permanently")
      }}
      onOpenDrawer={(target) => requestStoryDrawer(platform, target)}
      onOpenWorktree={async (story) => {
        await requestStoryAction(platform, story, "Open Worktree")
      }}
      onReject={(story, choice) => requestRejectChoice(platform, story, choice)}
      onStopAgent={(story, choice) => requestStopChoice(platform, story, choice)}
      onUnpauseAgent={(story) =>
        requestStoryAction(platform, story, "Unpause Agent").then(() => story)
      }
      story={story}
    />
  )
}

function drawerTarget(story: UserStory): DrawerTarget {
  return story.status === "in-review"
    ? {
        initialDevelopmentTab: "diff",
        initialTab: "development",
        mode: "view",
        userStory: story,
      }
    : { initialTab: "user-story", mode: "view", userStory: story }
}

function requestStoryAction(
  platform: ReturnType<typeof usePlatform>,
  story: UserStory,
  action: BacklogAction
) {
  return (
    platform.backlogStatusPip?.request({ action, storyId: story.id }) ??
    Promise.resolve(false)
  )
}

function requestStoryDrawer(
  platform: ReturnType<typeof usePlatform>,
  target: DrawerTarget
) {
  if (!target.userStory) return
  void platform.backlogStatusPip?.request({
    drawer: {
      focusComment: target.focusComment,
      initialDevelopmentTab: target.initialDevelopmentTab,
      initialTab: target.initialTab,
    },
    storyId: target.userStory.id,
  })
}

async function requestRejectChoice(
  platform: ReturnType<typeof usePlatform>,
  story: UserStory,
  choice: RejectChoice
) {
  await platform.backlogStatusPip?.request({
    rejectChoice: choice,
    storyId: story.id,
  })
  return story
}

async function requestStopChoice(
  platform: ReturnType<typeof usePlatform>,
  story: UserStory,
  choice: StopAgentChoice
) {
  await platform.backlogStatusPip?.request({
    stopChoice: choice,
    storyId: story.id,
  })
  return story
}

function activeStory(story: UserStory) {
  return activeStatuses.has(story.status)
}

function compareActiveStories(left: UserStory, right: UserStory) {
  return activeStoryRank(left) - activeStoryRank(right)
}

function activeStoryRank(story: UserStory) {
  if (story.status === "in-review") return 0
  return 1
}

function statusText(
  authStatus: BacklogStatusPipSnapshot["authStatus"],
  hasActiveProject: boolean,
  activeCount: number
) {
  if (authStatus === "loading") return "Loading session"
  if (authStatus === "unauthenticated") return "Sign in to sync backlog"
  if (!hasActiveProject) return "Open a project to track active stories"
  return `${activeCount} active ${activeCount === 1 ? "story" : "stories"}`
}

function emptyText(
  authStatus: BacklogStatusPipSnapshot["authStatus"],
  hasActiveProject: boolean,
  loading: boolean
) {
  if (authStatus === "loading" || loading) return "Loading user stories."
  if (authStatus === "unauthenticated") return "Sign in to view active stories."
  if (!hasActiveProject) return "Open a project to load user stories."
  return "No user story is currently in progress or in review."
}
