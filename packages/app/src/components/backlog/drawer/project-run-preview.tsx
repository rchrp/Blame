import { CircleAlertIcon } from "lucide-react"
import * as React from "react"

import { portOwnerLabel } from "@/components/backlog/board/project-app-port"
import {
  projectRunConfigurationPreviewKey,
  projectRunConfigurationPreviewUrl,
} from "@/components/backlog/board/project-run-configuration"
import type { SharedProjectRunner } from "@/components/backlog/board/project-runner-context"
import { ProjectRunnerControls } from "@/components/backlog/board/project-runner-controls"
import {
  projectRunLogItems,
  runLogItemStopped,
} from "@/components/backlog/board/run-log-items"
import type { RunLogEmpty } from "@/components/backlog/board/run-log-panel"
import type { ProjectRunPreview } from "@/components/backlog/drawer/user-story-preview"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import { Button } from "@/components/ui/button"
import { useProjects } from "@/context/projects"

// The preview of the project's own app, started and stopped with the
// shared runner: in a story working directly in the project folder, and
// in the header's drawer. Both show the same page, controls and logs.
export function useProjectRunPreview(runner?: SharedProjectRunner) {
  const initialization = useProjectInitialization()?.initialization
  const [startRequest, setStartRequest] = React.useState(0)
  const selected = runner?.selected
  if (!runner || !selected) return undefined
  const status = runner.statusFor(selected.id)
  // Started here, the app's logs show in this preview, not in a drawer
  // of their own; the page then waits until the started app answers.
  const start = (id: string) => {
    setStartRequest((request) => request + 1)
    runner.start(id, { revealLogs: false })
  }
  const projectRun: ProjectRunPreview = {
    surface: {
      configuration: selected,
      manifest: initialization?.previewManifest ?? undefined,
    },
    controls: ({ onMenuOpenChange, views }) => (
      <ProjectRunnerControls
        configurations={runner.configurations}
        disabled={!runner.projectPath || !runner.terminal}
        pending={runner.pendingOperation}
        runningOutside={runningOutside(runner, selected.id)}
        startBlocked={startBlocked(runner, selected.id)}
        selectedId={selected.id}
        statusFor={runner.statusFor}
        views={views}
        onMenuOpenChange={onMenuOpenChange}
        onSelect={runner.select}
        onStart={start}
        onStop={runner.stop}
      />
    ),
    logs: projectRunLogs(runner, start),
    runKey: runner.sessionFor(selected.id)?.sessionId,
    startRequest,
    notice:
      selected.id === runner.previewConfiguration?.id ? (
        <PortNotice runner={runner} />
      ) : undefined,
  }
  return {
    projectRun,
    previewUrl:
      status === "running" || status === "starting"
        ? projectRunConfigurationPreviewUrl(selected)
        : undefined,
    // The same page wherever it shows: one app, one browser view.
    sessionKey: projectRunConfigurationPreviewKey(selected, runner.projectPath),
    title: selected.name,
  }
}

function projectRunLogs(
  runner: SharedProjectRunner,
  start: (id: string) => void
): ProjectRunPreview["logs"] {
  const items = projectRunLogItems(
    runner.configurations,
    runner.sessions,
    runner.statusFor
  )
  const picked = runner.activeSessionId
  const selected = items.some(({ id }) => id === picked)
    ? picked
    : (runner.activeSession?.configurationId ?? runner.selected?.id)
  const item = items.find(({ id }) => id === selected)
  return {
    content: runningOutside(runner, selected ?? "")
      ? ""
      : (runner.sessionFor(selected ?? "")?.logs ?? ""),
    empty: projectRunLogEmpty(runner, item, start),
    items,
    selected,
    onSelect: runner.selectSession,
  }
}

function projectRunLogEmpty(
  runner: SharedProjectRunner,
  item: ProjectRunPreview["logs"]["items"][number] | undefined,
  start: (id: string) => void
): RunLogEmpty {
  if (!item) return { title: "No output yet" }
  if (runningOutside(runner, item.id) && runner.external.kind === "project")
    return {
      title: "Running outside Blame",
      description: `${item.label} already runs outside Blame (${portOwnerLabel(runner.external.owner)}). Its logs stay where it was started.`,
    }
  if (!runLogItemStopped(item)) return { title: "No output yet" }
  const configuration = runner.configurations.find(({ id }) => id === item.id)
  const startable =
    configuration &&
    runner.projectPath &&
    runner.terminal &&
    !runner.pendingOperation &&
    !startBlocked(runner, item.id)
  return {
    title: "Not started",
    description: `Start ${item.label} to see its logs here.`,
    action: startable
      ? { label: `Start ${item.label}`, onClick: () => start(item.id) }
      : undefined,
  }
}

// The project's app already runs outside Blame: Blame can neither rerun
// nor stop it.
export function runningOutside(runner: SharedProjectRunner, id: string) {
  return (
    runner.external.kind === "project" &&
    id === runner.previewConfiguration?.id &&
    !["running", "starting"].includes(runner.sessionFor(id)?.status ?? "")
  )
}

// Why the app cannot start now: its port is held by another app.
export function startBlocked(runner: SharedProjectRunner, id: string) {
  if (id !== runner.previewConfiguration?.id) return undefined
  if (runner.external.kind === "other") return "Its port is used by another app"
  if (runner.external.kind === "unknown")
    return "Something already runs on its port"
  return undefined
}

// The app's port is already taken: by another app, or by one Blame cannot
// place (then the person tells, once for this project and port).
function PortNotice({ runner }: { runner: SharedProjectRunner }) {
  const projects = useProjects()
  const external = runner.external
  if (external.kind !== "other" && external.kind !== "unknown") return null
  const port = previewPortLabel(runner)
  const holder = portOwnerLabel(external.owner)
  return (
    <div className="pointer-events-auto flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <div className="grid min-w-0 flex-1 gap-1">
        {external.kind === "other" ? (
          <>
            <p className="font-medium">{port} is used by another app</p>
            <p className="text-pretty text-muted-foreground">
              {holder} holds it. Stop that app to run this project's here.
            </p>
          </>
        ) : (
          <>
            <p className="font-medium">Something already runs on {port}</p>
            <p className="text-pretty text-muted-foreground">
              Blame can't tell which app it is ({holder}). Is it{" "}
              {projects.activeProject?.name ?? "this project"}?
            </p>
          </>
        )}
      </div>
      {external.kind === "unknown" ? (
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => runner.answerExternalApp(false)}
          >
            No
          </Button>
          <Button
            size="sm"
            type="button"
            onClick={() => runner.answerExternalApp(true)}
          >
            Yes, use it
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function previewPortLabel(runner: SharedProjectRunner) {
  const url = projectRunConfigurationPreviewUrl(runner.previewConfiguration)
  try {
    const parsed = new URL(
      /^https?:\/\//.test(url ?? "") ? url! : `http://${url}`
    )
    return parsed.host
  } catch {
    return "Its port"
  }
}
