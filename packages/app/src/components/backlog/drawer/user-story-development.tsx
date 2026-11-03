import * as React from "react"
import {
  FolderTreeIcon,
  GitCompareArrowsIcon,
  SquareTerminalIcon,
} from "lucide-react"

import type {
  BacklogColumnId,
  UserStory,
} from "@/components/backlog/data/backlog-data"
import { DevelopmentCodePanel } from "@/components/backlog/development/development-code-panel"
import { DiffStats } from "@/components/backlog/development/development-diff-stats"
import { DevelopmentTerminal } from "@/components/backlog/development/development-terminal"
import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import type { VcsFileDiff } from "@/components/backlog/development/development-workspace"
import {
  InsetSwitch,
  insetSwitchGroupClassName,
  useElementWidth,
} from "@/components/backlog/shared/inset-switch"
import type { UserStoryDevelopmentTab } from "@/components/backlog/shared/backlog-types"
import { TooltipProvider } from "@/components/ui/tooltip"

const developmentTabs = [
  {
    id: "files",
    icon: FolderTreeIcon,
    label: "Files",
    tooltip: "Show the files",
  },
  {
    id: "diff",
    icon: GitCompareArrowsIcon,
    label: "Changes",
    tooltip: "Show the changes",
  },
  {
    id: "terminal",
    icon: SquareTerminalIcon,
    label: "Terminal",
    tooltip: "Open a terminal",
  },
] satisfies {
  id: UserStoryDevelopmentTab
  icon: typeof FolderTreeIcon
  label: string
  tooltip: string
}[]

const rootDevelopmentStatuses = new Set<BacklogColumnId>(["backlog", "ready"])

// A story's code, laid out as its preview: views over the drawer's own
// background, switched from the right end of their toolbar.
export function DevelopmentContent({
  diffStats,
  initialDiffPath,
  initialFilePath,
  onTabChange,
  selectedDiffs,
  status,
  tab,
  userStory,
}: {
  diffStats?: UserStoryDiffStats
  initialDiffPath?: string
  initialFilePath?: string
  onTabChange: (tab: UserStoryDevelopmentTab) => void
  selectedDiffs?: VcsFileDiff[]
  status: BacklogColumnId
  tab: UserStoryDevelopmentTab
  userStory?: UserStory
}) {
  const tabs = rootDevelopmentStatuses.has(status)
    ? developmentTabs.filter((item) => item.id === "files")
    : status === "done"
      ? developmentTabs.filter((item) => item.id === "diff")
      : developmentTabs

  const activeTab = tabs.some((item) => item.id === tab) ? tab : tabs[0].id
  const [actionsRef, actionsWidth] = useElementWidth<HTMLDivElement>()
  const hasChanges = Boolean(
    diffStats && (diffStats.additions || diffStats.deletions)
  )

  React.useEffect(() => {
    if (activeTab === tab) return
    onTabChange(activeTab)
  }, [activeTab, onTabChange, tab])

  return (
    <TooltipProvider>
      <div
        className="relative h-full min-h-0"
        style={
          {
            "--code-actions-space": actionsWidth
              ? `${actionsWidth + 8}px`
              : "0px",
          } as React.CSSProperties
        }
      >
        {/* One element whatever the view, so its knob slides between them:
            each view's toolbar leaves it room. As tall as the switch group
            (38px), like the search field beside it. */}
        {tabs.length > 1 || hasChanges ? (
          <div
            ref={actionsRef}
            className="absolute top-4 right-4 z-30 flex h-[2.375rem] items-center gap-2"
          >
            {hasChanges && diffStats ? (
              <span className="flex h-full items-center rounded-full border bg-background/95 px-3 shadow-sm backdrop-blur">
                <DiffStats compact diff={diffStats} />
              </span>
            ) : null}
            {tabs.length > 1 ? (
              <div className={insetSwitchGroupClassName}>
                <InsetSwitch
                  labeled
                  items={tabs.map((item) => ({
                    ...item,
                    active: item.id === activeTab,
                    onSelect: () => onTabChange(item.id),
                  }))}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {activeTab === "files" && (
          <DevelopmentCodePanel
            fallbackToProjectRoot={rootDevelopmentStatuses.has(status)}
            initialFilePath={initialFilePath}
            mode="files"
            userStory={userStory}
          />
        )}
        {activeTab === "diff" && (
          <DevelopmentCodePanel
            initialDiffPath={initialDiffPath}
            mode="diff"
            selectedDiffs={selectedDiffs}
            userStory={userStory}
          />
        )}
        {activeTab === "terminal" && (
          <DevelopmentTerminal userStory={userStory} />
        )}
      </div>
    </TooltipProvider>
  )
}
