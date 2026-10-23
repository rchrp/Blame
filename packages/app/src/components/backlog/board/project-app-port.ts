import * as React from "react"

import type { SharedProjectRunner } from "@/components/backlog/board/project-runner-context"
import type {
  LocalPortOwner,
  ProjectAppClient,
  ProjectAppRequest,
  ProjectAppResult,
} from "@/context/platform"

// The project's app may already run outside Blame (started in a terminal,
// by the agent, by another tool). Its preview port tells: free, held by
// this project's app, by another app, or by one Blame cannot place.

const pollIntervalMs = 4_000

// The local port a preview address serves on, when it is on this computer.
export function localPreviewPort(previewUrl: string | undefined) {
  if (!previewUrl) return undefined
  try {
    const url = new URL(
      /^https?:\/\//.test(previewUrl) ? previewUrl : `http://${previewUrl}`
    )
    const local = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(
      url.hostname.toLowerCase()
    )
    if (!local) return undefined
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

// Watches who holds the port while Blame's own runner is not running the
// app there.
export function useLocalPortOwner({
  client,
  paused,
  port,
  projectPath,
}: {
  client?: ProjectAppClient
  paused: boolean
  port?: number
  projectPath?: string
}) {
  const key = port && projectPath ? `${projectPath}:${port}` : undefined
  const [state, setState] = React.useState<{
    key: string
    owner: LocalPortOwner
  }>()

  React.useEffect(() => {
    if (!client || !port || !projectPath || !key || paused) return
    let active = true
    const inspect = () => {
      if (document.visibilityState === "hidden") return
      void client
        .inspectPort({ port, projectPath })
        .then((owner) => {
          if (active) setState({ key, owner })
        })
        .catch(() => undefined)
    }
    inspect()
    const interval = window.setInterval(inspect, pollIntervalMs)
    window.addEventListener("focus", inspect)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener("focus", inspect)
    }
  }, [client, key, paused, port, projectPath])

  if (!key || paused || state?.key !== key) return undefined
  return state.owner
}

export type ExternalProjectApp =
  | { kind: "none" }
  | { kind: "project"; confirmed: boolean; owner: BusyPortOwner }
  | { kind: "other"; owner: BusyPortOwner }
  | { kind: "unknown"; owner: BusyPortOwner }

type BusyPortOwner = Extract<LocalPortOwner, { status: "busy" }>

// The person's answer for a port Blame could not place wins over the
// unknown.
export function externalProjectApp(
  owner: LocalPortOwner | undefined,
  answer: boolean | undefined
): ExternalProjectApp {
  if (!owner || owner.status === "free") return { kind: "none" }
  if (owner.owner === "project")
    return { kind: "project", confirmed: false, owner }
  if (owner.owner === "other") return { kind: "other", owner }
  if (answer === true) return { kind: "project", confirmed: true, owner }
  if (answer === false) return { kind: "other", owner }
  return { kind: "unknown", owner }
}

export function portOwnerLabel(owner: BusyPortOwner) {
  return owner.cwd ?? owner.processName ?? "another program"
}

// The answer to an agent working in the project folder: the app's state,
// or a start through the shared runner, as if the person clicked Start.
export function projectAppAnswer(
  runner: Pick<
    SharedProjectRunner,
    "external" | "previewConfiguration" | "sessionFor" | "start" | "terminal"
  > & { projectPath?: string },
  action: ProjectAppRequest["action"]
): ProjectAppResult {
  const configuration = runner.previewConfiguration
  if (!configuration || !runner.projectPath)
    return {
      status: "unavailable",
      message:
        "This project has no run configuration with a preview, so Blame cannot run its app.",
    }
  const previewUrl = configuration.previewUrl?.trim() || undefined
  const session = runner.sessionFor(configuration.id)
  const base = {
    configuration: configuration.name,
    ...(previewUrl ? { previewUrl } : {}),
    ...(session?.logs ? { logs: session.logs.slice(-6_000) } : {}),
  }
  if (session?.status === "running" || session?.status === "starting")
    return {
      ...base,
      status: session.status,
      message: `${configuration.name} is ${session.status} through Blame.`,
    }
  const external = runner.external
  if (external.kind === "project")
    return {
      ...base,
      status: "running",
      runningOutsideBlame: true,
      message: `${configuration.name} is already running outside Blame (${portOwnerLabel(external.owner)}).`,
    }
  if (external.kind === "other" || external.kind === "unknown")
    return {
      ...base,
      status: "conflict",
      owner: {
        kind: external.kind,
        ...(external.owner.cwd ? { folder: external.owner.cwd } : {}),
        ...(external.owner.processName
          ? { process: external.owner.processName }
          : {}),
      },
      message:
        external.kind === "other"
          ? `Its port is held by another app (${portOwnerLabel(external.owner)}). Ask the user to stop it.`
          : `Something Blame cannot identify already listens on its port (${portOwnerLabel(external.owner)}). Ask the user whether it is this project's app: they can confirm it in the story's preview.`,
    }
  if (action === "status")
    return {
      ...base,
      status: session?.status === "error" ? "failed" : "stopped",
      message: `${configuration.name} is not running.`,
    }
  if (!runner.terminal)
    return {
      ...base,
      status: "unavailable",
      message: "Blame cannot run commands in this window.",
    }
  runner.start(configuration.id)
  return {
    ...base,
    status: "starting",
    message: `Starting ${configuration.name} through Blame.`,
  }
}
