import * as React from "react"
import type {
  PreviewManifest,
  ProjectRunConfiguration,
} from "@blame/agent-runtime"

import type { Project } from "@/lib/projects"

export type GeneratedProjectInitialization = {
  previewManifest: PreviewManifest
  setupScript: string
  dockerCompose: string
  runConfigurations: ProjectRunConfiguration[]
  clineSessionId?: string
}

export type ProjectContextValue = {
  activeProject?: Project
  recentProjects: Project[]
  opening: boolean
  openProject(path: string): Promise<Project>
  openGeneratedProject(
    path: string,
    initialization: GeneratedProjectInitialization
  ): Promise<void>
  chooseProject(): Promise<void>
  removeRecentProject(path: string): void
  // Opens a project from the open one: asks for a new window or this one.
  switchProject(path: string): Promise<void>
}

export const ProjectContext = React.createContext<
  ProjectContextValue | undefined
>(undefined)

export function useProjects() {
  const context = React.useContext(ProjectContext)
  if (!context)
    throw new Error("useProjects must be used within ProjectProvider")
  return context
}
