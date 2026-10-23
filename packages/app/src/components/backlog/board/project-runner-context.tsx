import type { ProjectRunConfiguration } from "@blame/agent-runtime"
import * as React from "react"

import {
  type ExternalProjectApp,
  externalProjectApp,
  localPreviewPort,
  projectAppAnswer,
  useLocalPortOwner,
} from "@/components/backlog/board/project-app-port"
import {
  projectPreviewConfiguration,
  projectRunConfigurationPreviewUrl,
} from "@/components/backlog/board/project-run-configuration"
import { ProjectRunConfigurationPreviewWarmup } from "@/components/backlog/board/project-run-preview-warmup"
import type { ProjectRunnerControlStatus } from "@/components/backlog/board/project-runner-types"
import { useProjectRunner } from "@/components/backlog/board/use-project-runner"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import {
  usePlatform,
  type ProjectAppRequest,
  type ProjectAppResult,
} from "@/context/platform"
import { useProjects } from "@/context/projects"
import { useLatestCallback } from "@/lib/use-latest-callback"
import { useUiMemory } from "@/lib/ui-memory"

// One runner for the open project's app, shared by the header's controls
// and the preview of stories that run directly in the project folder: the
// same processes, logs and status wherever they are started or stopped.
// The app may also already run outside Blame: its preview port tells.

export type SharedProjectRunner = Omit<
  ReturnType<typeof useProjectRunner>,
  "start"
> & {
  // The person's answer when Blame cannot tell who holds the app's port.
  answerExternalApp(isThisProject: boolean): void
  configurations: ProjectRunConfiguration[]
  // Who holds the preview port while Blame's runner does not run the app.
  external: ExternalProjectApp
  // The configuration whose app the previews show.
  previewConfiguration?: ProjectRunConfiguration
  projectPath?: string
  start(id: string): void
  // Blame's own status, or running for the project's app outside Blame.
  statusFor(id: string): ProjectRunnerControlStatus
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
  const platform = usePlatform()
  const projects = useProjects()
  const projectInitialization = useProjectInitialization()
  const configurations =
    projectInitialization?.initialization?.runConfigurations ?? noConfigurations
  const projectPath = projects.activeProject?.path
  const runner = useProjectRunner(configurations, projectPath)
  const previewConfiguration = projectPreviewConfiguration(configurations)
  const previewUrl = projectRunConfigurationPreviewUrl(previewConfiguration)
  const port = localPreviewPort(previewUrl)
  const blameStatus = previewConfiguration
    ? runner.sessionFor(previewConfiguration.id)?.status
    : undefined
  const blameRunsApp = blameStatus === "running" || blameStatus === "starting"
  const portOwner = useLocalPortOwner({
    client: platform.projectApp,
    paused: blameRunsApp,
    port,
    projectPath,
  })
  const answerKey = port && projectPath ? `${projectPath}:${port}` : ""
  const [answers, setAnswers] = useUiMemory(
    "project-app-port-owners",
    {} as Record<string, boolean>,
    isAnswers
  )
  const external = externalProjectApp(
    portOwner,
    answerKey ? answers[answerKey] : undefined
  )
  const appRunning = blameRunsApp || external.kind === "project"
  const [warmup, setWarmup] = React.useState<{
    configurationId: string
    trigger: number
  }>()
  const warmupConfiguration = appRunning
    ? previewConfiguration
    : configurations.find(
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
  const statusFor = (id: string): ProjectRunnerControlStatus => {
    const status = runner.sessionFor(id)?.status
    if (status && status !== "stopped") return status
    if (id === previewConfiguration?.id && external.kind === "project")
      return "running"
    return status ?? "stopped"
  }
  const value: SharedProjectRunner = {
    ...runner,
    answerExternalApp: (isThisProject) => {
      if (answerKey)
        setAnswers((current) => ({ ...current, [answerKey]: isThisProject }))
    },
    configurations,
    external,
    previewConfiguration,
    projectPath,
    start,
    statusFor,
  }
  useAgentRequests(value)
  return (
    <ProjectRunnerContext.Provider value={value}>
      {children}
      {/* While the app runs, its page stays open for the agent's browser
          tools (a story in the project folder, quick chat). */}
      <ProjectRunConfigurationPreviewWarmup
        configuration={warmupConfiguration}
        devtoolsTarget={appRunning}
        scope={projectPath}
        trigger={warmup?.trigger}
      />
    </ProjectRunnerContext.Provider>
  )
}

export function useSharedProjectRunner() {
  return React.useContext(ProjectRunnerContext)
}

// An agent working in the project folder asks about the app, or starts it:
// this window answers with its runner, as if the person had clicked Start.
function useAgentRequests(runner: SharedProjectRunner) {
  const client = usePlatform().projectApp
  const answer = useLatestCallback(
    (request: ProjectAppRequest): ProjectAppResult =>
      projectAppAnswer(runner, request.action)
  )
  React.useEffect(() => {
    if (!client) return
    return client.onRequest((request) => {
      void client.respond(request.id, answer(request)).catch(() => undefined)
    })
  }, [answer, client])
}

function isAnswers(value: unknown): value is Record<string, boolean> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Object.values(value as object).every((item) => typeof item === "boolean")
  )
}
