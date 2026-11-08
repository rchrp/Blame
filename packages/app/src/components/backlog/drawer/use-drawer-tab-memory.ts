import * as React from "react"

import type {
  UserStoryDevelopmentTab,
  UserStoryDrawerTab,
} from "@/components/backlog/shared/backlog-types"
import { recallForItem, rememberForItem } from "@/lib/ui-memory"

const drawerTabsMemoryKey = "story-drawer-tabs"
const drawerTabs = new Set<string>(["user-story", "preview", "development"])
const developmentTabs = new Set<string>(["files", "diff", "terminal"])

// The tabs a story's drawer was last left on.
export function recallDrawerTabs(storyId: string) {
  return recallForItem(drawerTabsMemoryKey, storyId, isRememberedDrawerTabs)
}

// Remembers the tabs a story's drawer shows, to open it there next time.
export function useDrawerTabMemory(
  storyId: string | undefined,
  tab: UserStoryDrawerTab,
  developmentTab: UserStoryDevelopmentTab
) {
  React.useEffect(() => {
    if (!storyId) return
    rememberForItem(drawerTabsMemoryKey, storyId, {
      developmentTab,
      tab,
    })
  }, [developmentTab, storyId, tab])
}

function isRememberedDrawerTabs(value: unknown): value is {
  developmentTab: UserStoryDevelopmentTab
  tab: UserStoryDrawerTab
} {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    typeof record.tab === "string" &&
    drawerTabs.has(record.tab) &&
    typeof record.developmentTab === "string" &&
    developmentTabs.has(record.developmentTab)
  )
}
