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
      {label ? (
        <SidebarGroupLabel className="h-7 text-[11px] font-semibold">
          {label}
        </SidebarGroupLabel>
      ) : null}
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {items.map((item) =>
            item.url === "/orchestrator" ? (
              <SidebarMenuItem key={item.url} className="mb-3">
                <SidebarMenuButton
                  asChild
                  isActive={pathname === item.url}
                  tooltip={`${item.title} · ${routeShortcutLabel(item.url)}`}
                  className="justify-center border border-foreground/8 bg-popover/70 font-semibold shadow-xs data-active:border-sidebar-primary/20 data-active:bg-sidebar-primary/8 data-active:text-sidebar-primary dark:data-active:bg-sidebar-primary/12"
                >
                  <AppLink
                    href={item.url}
                    aria-label={item.title}
                    aria-current={pathname === item.url ? "page" : undefined}
                  >
                    {item.icon}
                    <span className="group-data-[collapsible=icon]:hidden">
                      {item.title}
                    </span>
                  </AppLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  tooltip={item.title}
                  className="gap-2.5 border border-transparent text-sidebar-foreground/80 data-active:border-sidebar-primary/15 data-active:bg-sidebar-primary/8 data-active:font-semibold data-active:text-sidebar-primary data-active:hover:bg-sidebar-primary/12 dark:data-active:bg-sidebar-primary/12 dark:data-active:hover:bg-sidebar-primary/16"
                  isActive={
                    pathname === item.url &&
                    (item.url !== "/chat" || !quickChats.activeId) &&
                    (item.url !== "/backlog" || !selectedStoryId)
                  }
                >
                  <AppLink
                    href={item.url}
                    aria-current={
                      pathname === item.url ? "location" : undefined
                    }
                    onClick={() => {
                      if (item.url === "/chat") {
                        quickChats.setActiveId(undefined)
                        window.dispatchEvent(new Event(quickChatSelectedEvent))
                      }
                      if (item.url === "/backlog") selectBacklogStory(undefined)
                    }}
                  >
                    {item.icon}
                    <span className="min-w-0 truncate">{item.title}</span>
                    {item.status ? (
                      <span className="ml-auto inline-flex shrink-0 items-center">
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
            )
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
