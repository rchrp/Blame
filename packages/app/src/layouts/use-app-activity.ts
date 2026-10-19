import * as React from "react"

import { selectBacklogStory } from "@/components/backlog/data/backlog-navigation"
import { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { quickChatSelectedEvent } from "@/components/chat/data/quick-chat-data"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { navigate } from "@/components/navigation/navigation"
import { usePlatform, type NotificationTarget } from "@/context/platform"

// Keeps Blame's presence outside its window in step with the agents: a live
// window title, a dock/taskbar badge while agents work, an attention request
// when one finishes in the background, and notifications that open the
// right story or chat when clicked.
export function useAppActivity() {
  const platform = usePlatform()
  const backlog = useBacklogStore()
  const quickChats = useQuickChatStore()
  const running = runningAgents(backlog.stories, quickChats.chats)
  const previousRunning = React.useRef(running)
  const setActiveChat = quickChats.setActiveId

  React.useEffect(() => {
    const previous = previousRunning.current
    previousRunning.current = running
    document.title = running ? `● Blame — ${agentsLabel(running)}` : "Blame"
    void platform.appStatus?.setActivity({ running }).catch(() => undefined)
    if (running < previous && !document.hasFocus()) {
      void platform.appStatus?.requestAttention().catch(() => undefined)
    }
  }, [platform.appStatus, running])

  React.useEffect(() => {
    return platform.systemNotifications?.onClick?.((target) =>
      openNotificationTarget(target, setActiveChat)
    )
  }, [platform.systemNotifications, setActiveChat])
}

export function runningAgents(
  stories: readonly { agentStatus?: string | null }[],
  chats: readonly { agentStatus?: string | null }[]
) {
  return (
    stories.filter((story) => story.agentStatus === "Running").length +
    chats.filter((chat) => chat.agentStatus === "Running").length
  )
}

function agentsLabel(count: number) {
  return count === 1 ? "1 agent working" : `${count} agents working`
}

function openNotificationTarget(
  target: NotificationTarget,
  setActiveChat: (id: string | undefined) => void
) {
  navigate(target.pathname)
  if (target.storyId) {
    // Wait for the backlog page to mount before asking it to open the drawer.
    const storyId = target.storyId
    window.setTimeout(
      () => selectBacklogStory(storyId, target.tab === "diff" ? "View Diff" : undefined),
      0
    )
  }
  if (target.chatId) {
    setActiveChat(target.chatId)
    window.dispatchEvent(new Event(quickChatSelectedEvent))
  }
}
