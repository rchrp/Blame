import { AppLink } from "@/components/navigation/app-link"
import * as React from "react"
import {
  selectBacklogStory,
  selectedBacklogStoryId,
  subscribeToBacklogStorySelection,
} from "@/components/backlog/data/backlog-navigation"
import { quickChatSelectedEvent } from "@/components/chat/data/quick-chat-data"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { routeShortcutLabel } from "@/components/navigation/app-shortcuts"
import { QuickChatHistory } from "@/components/sidebar/quick-chat-history"
import { Kbd } from "@/components/ui/kbd"
import { ActiveBacklogStories } from "@/components/sidebar/active-backlog-stories"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function NavMain({
  items,
  label,
  pathname,
}: {
  items: {
    title: string
    url: string
    icon?: React.ReactNode
    status?: React.ReactNode
  }[]
  label?: string
  pathname: string
}) {
  const quickChats = useQuickChatStore()
  const selectedStoryId = React.useSyncExternalStore(
    subscribeToBacklogStorySelection,
    selectedBacklogStoryId
  )

  return (
    <SidebarGroup>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                tooltip={item.title}
                isActive={
                  pathname === item.url &&
                  (item.url !== "/chat" || !quickChats.activeId) &&
                  (item.url !== "/backlog" || !selectedStoryId)
                }
              >
                <AppLink
                  href={item.url}
                  onClick={() => {
                    if (item.url === "/chat") {
                      quickChats.setActiveId(undefined)
                      window.dispatchEvent(new Event(quickChatSelectedEvent))
                    }
                    if (item.url === "/backlog") selectBacklogStory(undefined)
                  }}
                >
                  {item.icon}
                  <span>{item.title}</span>
                  {item.status ? (
                    <span className="ml-auto inline-flex items-center">
                      {item.status}
                    </span>
                  ) : routeShortcutLabel(item.url) ? (
                    <Kbd className="ml-auto bg-transparent opacity-0 transition-opacity duration-150 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100">
                      {routeShortcutLabel(item.url)}
                    </Kbd>
                  ) : null}
                </AppLink>
              </SidebarMenuButton>
              {item.url === "/chat" ? (
                <QuickChatHistory pathname={pathname} />
              ) : null}
              {item.url === "/backlog" ? (
                <ActiveBacklogStories pathname={pathname} />
              ) : null}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
