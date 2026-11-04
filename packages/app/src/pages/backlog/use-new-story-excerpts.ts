import * as React from "react"
import type { DrawerTarget } from "@/components/backlog/shared/backlog-types"
import {
  subscribeToNewUserStoryExcerpts,
  takeNewUserStoryExcerpts,
} from "@/components/backlog/shared/excerpt-actions"

/**
 * "Add to new user story" on selected code or conversation text opens the
 * create drawer with the excerpts attached. They wait for an open project
 * when the page starts with them.
 */
export function useNewUserStoryExcerpts(
  projectPath: string | undefined,
  openCreateDrawer: (initialDraft: DrawerTarget["initialDraft"]) => void
) {
  React.useEffect(() => {
    const openWithExcerpts = () => {
      if (!projectPath) return
      const excerpts = takeNewUserStoryExcerpts()
      if (excerpts.length) openCreateDrawer({ codeSelectionAttachments: excerpts })
    }
    openWithExcerpts()
    return subscribeToNewUserStoryExcerpts(openWithExcerpts)
  }, [openCreateDrawer, projectPath])
}
