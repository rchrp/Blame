import type { ProjectRunConfiguration } from "@blame/agent-runtime"
import * as React from "react"

import { projectRunConfigurationPreviewUrl } from "@/components/backlog/board/project-run-configuration"
import { ProjectRunConfigurationPreviewWarmup } from "@/components/backlog/board/project-run-preview-warmup"
import { useProjectRunner } from "@/components/backlog/board/use-project-runner"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import { useProjects } from "@/context/projects"

// One runner for the open project's app, shared by the header's controls
// and the preview of stories that run directly in the project folder: the
// same processes, logs and status wherever they are started or stopped.

export type SharedProjectRunner = Omit<
  ReturnType<typeof useProjectRunner>,
  "start"
> & {
  configurations: ProjectRunConfiguration[]
  projectPath?: string
  start(id: string): void
}

export const ProjectRunnerContext = React.createContext<
  SharedProjectRunner | undefined
>(undefined)

const noConfigurations: ProjectRunConfiguration[] = []

export function ProjectRunnerProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const projects = useProjects()
  const projectInitialization = useProjectInitialization()
  const configurations =
    projectInitialization?.initialization?.runConfigurations ?? noConfigurations
  const projectPath = projects.activeProject?.path
  const runner = useProjectRunner(configurations, projectPath)
  const [warmup, setWarmup] = React.useState<{
    configurationId: string
    trigger: number
  }>()
  const warmupConfiguration = configurations.find(
    (configuration) => configuration.id === warmup?.configurationId
  )
  const runnerStart = runner.start
  // Starting an app with a preview also gets its preview page ready.
  const start = React.useCallback(
    (id: string) => {
      const configuration = configurations.find((item) => item.id === id)
      if (configuration && projectRunConfigurationPreviewUrl(configuration)) {
        setWarmup((current) => ({
          configurationId: id,
          trigger: (current?.trigger ?? 0) + 1,
        }))
      }
      runnerStart(id)
    },
    [configurations, runnerStart]
  )
  const value = { ...runner, configurations, projectPath, start }
  return (
    <ProjectRunnerContext.Provider value={value}>
      {children}
      <ProjectRunConfigurationPreviewWarmup
        configuration={warmupConfiguration}
        scope={projectPath}
        trigger={warmup?.trigger}
      />
    </ProjectRunnerContext.Provider>
  )
}

export function useSharedProjectRunner() {
  return React.useContext(ProjectRunnerContext)
}
