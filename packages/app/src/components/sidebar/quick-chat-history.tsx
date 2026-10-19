import * as React from "react"
import { XIcon } from "lucide-react"

import {
  quickChatSelectedEvent,
  type QuickChat,
} from "@/components/chat/data/quick-chat-data"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { undoable } from "@/lib/undoable"
import { AppLink } from "@/components/navigation/app-link"
import {
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

const initialChatCount = 3
const chatPageStep = 5

export function QuickChatHistory({ pathname }: { pathname: string }) {
  const quickChats = useQuickChatStore()
  const [pagination, setPagination] = React.useState({
    count: initialChatCount,
    projectId: quickChats.projectId,
  })
  // Conversations deleted but still undoable: hidden until the toast closes.
  const [pendingDeletes, setPendingDeletes] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const chats = React.useMemo(
    () =>
      [...quickChats.chats]
        .filter((chat) => !pendingDeletes.has(chat.id))
        .sort(compareChatsByMostRecent),
    [pendingDeletes, quickChats.chats]
  )
  const visibleCount =
    pagination.projectId === quickChats.projectId
      ? pagination.count
      : initialChatCount
  const visibleChats = chats.slice(0, visibleCount)

  function setVisibleCount(update: (current: number) => number) {
    setPagination({
      count: update(visibleCount),
      projectId: quickChats.projectId,
    })
  }

  function setPending(chatId: string, pending: boolean) {
    setPendingDeletes((current) => {
      const next = new Set(current)
      if (pending) next.add(chatId)
      else next.delete(chatId)
      return next
    })
  }

  function deleteChat(chat: QuickChat) {
    const wasActive = quickChats.activeId === chat.id
    setPending(chat.id, true)
    if (wasActive) {
      quickChats.setActiveId(undefined)
      window.dispatchEvent(new Event(quickChatSelectedEvent))
    }
    undoable({
      message: `Deleted “${chat.title}”`,
      undo: () => {
        setPending(chat.id, false)
        if (wasActive) {
          quickChats.setActiveId(chat.id)
          window.dispatchEvent(new Event(quickChatSelectedEvent))
        }
      },
      commit: async () => {
        await quickChats.remove(chat)
        setPending(chat.id, false)
      },
    })
  }

  if (!quickChats.loading && !chats.length) return null

  return (
    <>
      <SidebarMenuSub className="gap-0.5 pb-1">
        {quickChats.loading && !chats.length ? (
          <SidebarMenuSubItem className="px-2 py-1 text-xs text-muted-foreground">
            Loading chats…
          </SidebarMenuSubItem>
        ) : null}
        {visibleChats.map((chat) => (
          <SidebarMenuSubItem className="group/chat" key={chat.id}>
            <SidebarMenuButton
              asChild
              className="h-8 pr-12 pl-2 text-sm"
              isActive={
                pathname === "/chat" && quickChats.activeId === chat.id
              }
              tooltip={chat.title}
            >
              <AppLink
                href="/chat"
                onClick={() => {
                  quickChats.setActiveId(chat.id)
                  window.dispatchEvent(new Event(quickChatSelectedEvent))
                }}
              >
                <span className="truncate">{chat.title}</span>
              </AppLink>
            </SidebarMenuButton>
            <time
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs leading-none text-muted-foreground tabular-nums transition-opacity group-focus-within/chat:opacity-0 group-hover/chat:opacity-0"
              dateTime={chat.updatedAt ?? chat.createdAt}
              title={exactTimeLabel(chat.updatedAt ?? chat.createdAt)}
            >
              {relativeTimeLabel(chat.updatedAt ?? chat.createdAt)}
            </time>
            <button
              aria-label={`Delete ${chat.title}`}
              className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity outline-none group-focus-within/chat:opacity-100 group-hover/chat:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              onClick={() => deleteChat(chat)}
              title={`Delete ${chat.title}`}
              type="button"
            >
              <XIcon className="size-4" />
            </button>
          </SidebarMenuSubItem>
        ))}
        {chats.length > initialChatCount ? (
          <SidebarMenuSubItem className="flex items-center gap-1 px-1 pt-1">
            {visibleCount < chats.length ? (
              <button
                className="rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                onClick={() =>
                  setVisibleCount((current) =>
                    Math.min(current + chatPageStep, chats.length)
                  )
                }
                type="button"
              >
                Show more
              </button>
            ) : null}
            {visibleCount > initialChatCount ? (
              <button
                className="rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                onClick={() =>
                  setVisibleCount((current) =>
                    Math.max(initialChatCount, current - chatPageStep)
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
    </>
  )
}

function compareChatsByMostRecent(left: QuickChat, right: QuickChat) {
  return chatTimestamp(right) - chatTimestamp(left)
}

function chatTimestamp(chat: QuickChat) {
  return new Date(chat.updatedAt ?? chat.createdAt).getTime() || 0
}

function relativeTimeLabel(value: string) {
  const diffMs = Date.now() - new Date(value).getTime()
  if (Number.isNaN(diffMs) || diffMs < 60_000) return "now"
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function exactTimeLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}
