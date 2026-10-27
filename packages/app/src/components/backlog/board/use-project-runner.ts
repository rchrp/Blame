import type { ProjectRunConfiguration } from "@blame/agent-runtime"
import * as React from "react"
import { toast } from "sonner"

import type {
  ProjectRunnerControlStatus,
  ProjectRunnerPendingOperation,
} from "@/components/backlog/board/project-runner-types"
import { usePlatform, type TerminalClient } from "@/context/platform"
import { writeProjectCommand } from "./project-runner-terminal"

export type ProjectRunSession = {
  configurationId: string
  logs: string
  name: string
  sessionId?: string
  status: ProjectRunnerControlStatus
}

type SessionRuntime = {
  sessionId: string
  unsubscribe: () => void
}

export function useProjectRunner(
  configurations: ProjectRunConfiguration[],
  projectPath?: string
) {
  const terminal = usePlatform().terminal
  const [selectedId, setSelectedId] = React.useState(
    () => defaultConfiguration(configurations)?.id
  )
  const [activeSessionId, setActiveSessionId] = React.useState<string>()
  const [logsOpen, setLogsOpen] = React.useState(false)
  const [sessions, setSessions] = React.useState<ProjectRunSession[]>([])
  const [pendingOperation, setPendingOperation] =
    React.useState<ProjectRunnerPendingOperation>()
  const runtimesRef = React.useRef(new Map<string, SessionRuntime>())
  useRunnerCleanup(terminal, runtimesRef)
  const selected = selectedConfiguration(configurations, selectedId)
  const selectedSession = sessionFor(sessions, selected?.id)
  const activeSession =
    sessionFor(sessions, activeSessionId) ?? selectedSession ?? sessions[0]
  return {
    activeSession,
    logsOpen,
    pendingOperation,
    runningCount: sessions.filter((session) => session.status === "running")
      .length,
    selected,
    selectedSession,
    sessions,
    terminal,
    select: (id: string) => {
      setSelectedId(id)
      if (sessionFor(sessions, id)) setActiveSessionId(id)
    },
    selectSession: setActiveSessionId,
    sessionFor: (id: string) => sessionFor(sessions, id),
    setLogsOpen,
    // revealLogs: false when the caller shows the logs itself (a story's
    // preview tab) instead of the runner's logs drawer.
    start: (id: string, options?: ProjectRunnerStartOptions) =>
      void startConfiguration(
        configurations.find((configuration) => configuration.id === id),
        projectPath,
        terminal,
        runnerActions(),
        options
      ),
    stop: (id: string) => void stopConfiguration(id, terminal, runnerActions()),
  }

  function runnerActions(): RunnerActions {
    return {
      runtimes: runtimesRef.current,
      setActiveSessionId,
      setLogsOpen,
      setPendingOperation,
      setSessions,
    }
  }
}

type RunnerActions = {
  runtimes: Map<string, SessionRuntime>
  setActiveSessionId: React.Dispatch<React.SetStateAction<string | undefined>>
  setLogsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setPendingOperation: React.Dispatch<
    React.SetStateAction<ProjectRunnerPendingOperation | undefined>
  >
  setSessions: React.Dispatch<React.SetStateAction<ProjectRunSession[]>>
}

export type ProjectRunnerStartOptions = { revealLogs?: boolean }

async function startConfiguration(
  configuration: ProjectRunConfiguration | undefined,
  projectPath: string | undefined,
  terminal: TerminalClient | undefined,
  actions: RunnerActions,
  options: ProjectRunnerStartOptions = {}
) {
  if (!configuration || !projectPath || !terminal) return
  actions.setPendingOperation({
    action: actions.runtimes.has(configuration.id) ? "restart" : "start",
    configurationId: configuration.id,
  })
  if (actions.runtimes.has(configuration.id)) {
    await stopConfiguration(configuration.id, terminal, actions, false)
  }
  openSession(configuration, projectPath, actions, options.revealLogs ?? true)
  try {
    await launchConfiguration(configuration, projectPath, terminal, actions)
  } catch (error) {
    await handleStartFailure(
      configuration,
      projectPath,
      terminal,
      actions,
      error
    )
  } finally {
    actions.setPendingOperation(undefined)
  }
}

async function launchConfiguration(
  configuration: ProjectRunConfiguration,
  projectPath: string,
  terminal: TerminalClient,
  actions: RunnerActions
) {
  const session = await terminal.start({
    cwd: configurationPath(projectPath, configuration.cwd),
  })
  const unsubscribe = subscribeToOutput(
    configuration.id,
    session.id,
    terminal,
    actions
  )
  actions.runtimes.set(configuration.id, { sessionId: session.id, unsubscribe })
  updateSession(actions, configuration.id, { sessionId: session.id })
  await writeProjectCommand(terminal, session.id, configuration.command)
  updateSession(actions, configuration.id, { status: "running" })
}

async function handleStartFailure(
  configuration: ProjectRunConfiguration,
  projectPath: string,
  terminal: TerminalClient,
  actions: RunnerActions,
  error: unknown
) {
  const runtime = actions.runtimes.get(configuration.id)
  runtime?.unsubscribe()
  if (runtime) await terminal.stop(runtime.sessionId)
  actions.runtimes.delete(configuration.id)
  updateSession(actions, configuration.id, {
    logs: `${initialLogs(configuration, projectPath)}\n${errorText(error)}\n`,
    status: "error",
  })
  toast.error(`Unable to start ${configuration.name}`, {
    description: errorText(error),
    position: "bottom-right",
  })
}

function openSession(
  configuration: ProjectRunConfiguration,
  projectPath: string,
  actions: RunnerActions,
  revealLogs: boolean
) {
  const session: ProjectRunSession = {
    configurationId: configuration.id,
    logs: initialLogs(configuration, projectPath),
    name: configuration.name,
    status: "starting",
  }
  actions.setSessions((sessions) => replaceSession(sessions, session))
  actions.setActiveSessionId(configuration.id)
  if (revealLogs) actions.setLogsOpen(true)
}

async function stopConfiguration(
  configurationId: string,
  terminal: TerminalClient | undefined,
  actions: RunnerActions,
  trackPending = true
) {
  const runtime = actions.runtimes.get(configurationId)
  if (!runtime || !terminal) return
  if (trackPending) {
    actions.setPendingOperation({ action: "stop", configurationId })
  }
  updateSession(actions, configurationId, { status: "stopping" })
  runtime.unsubscribe()
  actions.runtimes.delete(configurationId)
  try {
    await terminal.stop(runtime.sessionId)
    appendLogs(actions, configurationId, "\n[stopped by user]\n", "stopped")
  } catch (error) {
    updateSession(actions, configurationId, { status: "error" })
    toast.error("Unable to stop configuration", {
      description: errorText(error),
      position: "bottom-right",
    })
  } finally {
    if (trackPending) actions.setPendingOperation(undefined)
  }
}

function subscribeToOutput(
  configurationId: string,
  sessionId: string,
  terminal: TerminalClient,
  actions: RunnerActions
) {
  return terminal.onEvent(sessionId, (event) => {
    if (event.type !== "exit") {
      appendLogs(actions, configurationId, event.data)
      return
    }
    appendLogs(
      actions,
      configurationId,
      `\n[process exited ${event.data}]\n`,
      "stopped"
    )
    actions.runtimes.get(configurationId)?.unsubscribe()
    actions.runtimes.delete(configurationId)
  })
}

function useRunnerCleanup(
  terminal: TerminalClient | undefined,
  runtimesRef: React.RefObject<Map<string, SessionRuntime>>
) {
  React.useEffect(
    () => () => {
      for (const runtime of runtimesRef.current.values()) {
        runtime.unsubscribe()
        void terminal?.stop(runtime.sessionId)
      }
      runtimesRef.current.clear()
    },
    [runtimesRef, terminal]
  )
}

function appendLogs(
  actions: RunnerActions,
  configurationId: string,
  output: string,
  status?: ProjectRunSession["status"]
) {
  actions.setSessions((sessions) =>
    sessions.map((session) =>
      session.configurationId === configurationId
        ? {
            ...session,
            logs: `${session.logs}${output}`,
            status: status ?? session.status,
          }
        : session
    )
  )
}

function updateSession(
  actions: RunnerActions,
  configurationId: string,
  update: Partial<ProjectRunSession>
) {
  actions.setSessions((sessions) =>
    sessions.map((session) =>
      session.configurationId === configurationId
        ? { ...session, ...update }
        : session
    )
  )
}

function replaceSession(
  sessions: ProjectRunSession[],
  session: ProjectRunSession
) {
  return [
    ...sessions.filter(
      (item) => item.configurationId !== session.configurationId
    ),
    session,
  ]
}

function sessionFor(sessions: ProjectRunSession[], configurationId?: string) {
  return sessions.find((session) => session.configurationId === configurationId)
}

function selectedConfiguration(
  configurations: ProjectRunConfiguration[],
  selectedId: string | undefined
) {
  return (
    configurations.find((configuration) => configuration.id === selectedId) ??
    defaultConfiguration(configurations)
  )
}

function defaultConfiguration(configurations: ProjectRunConfiguration[]) {
  return (
    configurations.find((configuration) => configuration.default) ??
    configurations[0]
  )
}

function initialLogs(
  configuration: ProjectRunConfiguration,
  projectPath: string
) {
  return `$ cd ${configurationPath(projectPath, configuration.cwd)}\n$ ${configuration.command}\n`
}

function configurationPath(projectPath: string, cwd: string) {
  if (cwd === ".") return projectPath
  return `${projectPath.replace(/[\\/]+$/, "")}/${cwd}`
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
