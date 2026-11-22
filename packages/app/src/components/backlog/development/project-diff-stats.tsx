import * as React from "react"
import { useBacklogSelector } from "@/components/backlog/data/backlog-store"
import {
  useUserStoryDiffStats,
  type UserStoryDiffStats,
} from "./user-story-diff-stats"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"

const ProjectDiffStats = React.createContext<
  ReadonlyMap<string, UserStoryDiffStats>
>(new Map())

export function ProjectDiffStatsProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const stories = useBacklogSelector((backlog) => backlog.stories)
  const workspace = usePlatform().workspace
  const root = useProjects().activeProject?.path
  const stats = useUserStoryDiffStats(stories, workspace, root)
  return (
    <ProjectDiffStats.Provider value={stats}>
      {children}
    </ProjectDiffStats.Provider>
  )
}

export function useProjectDiffStats() {
  return React.useContext(ProjectDiffStats)
}
