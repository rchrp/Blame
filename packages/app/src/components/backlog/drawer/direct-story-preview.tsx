import { PreviewSurface } from "./preview-surface"
import { isHostWindowConfiguration } from "./surfaces/host-window-kind"
import { CircleAlertIcon, MonitorIcon } from "lucide-react"
import * as React from "react"

import { portOwnerLabel } from "@/components/backlog/board/project-app-port"
import {
  projectRunConfigurationPreviewKey,
  projectRunConfigurationPreviewUrl,
} from "@/components/backlog/board/project-run-configuration"
import {
  runningOutside,
  startBlocked,
} from "@/components/backlog/board/project-runner-button"
import {
  type SharedProjectRunner,
  useSharedProjectRunner,
} from "@/components/backlog/board/project-runner-context"
import { ProjectRunnerControls } from "@/components/backlog/board/project-runner-controls"
import { UserStoryPreview } from "@/components/backlog/drawer/user-story-preview"
import { Button } from "@/components/ui/button"
import { useProjects } from "@/context/projects"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"

// The preview of a story working directly in the project folder: the usual
// story preview, but its app is the project's own, started and stopped with
// the same runner as the header's controls, or found already running.
export function DirectStoryPreview({
  onCapture,
  visible,
  storyId,
}: {
  storyId: string
  onCapture?: (file: File) => void
  visible: boolean
}) {
  const runner = useSharedProjectRunner()
  const project = useProjects().activeProject
  const initialization = useProjectInitialization()?.initialization
  const [startRequest, setStartRequest] = React.useState(0)
  const selected = runner?.selected
  if (!runner || !selected) return <NoRunConfiguration />
  const status = runner.statusFor(selected.id)
  // The page waits in a loading state until the started app answers.
  const previewUrl =
    status === "running" || status === "starting"
      ? projectRunConfigurationPreviewUrl(selected)
      : undefined
  const outside = runningOutside(runner, selected.id)
  const session = runner.activeSession
  if (
    selected.previewTarget &&
    project &&
    runner.projectPath &&
    initialization?.previewManifest
  )
    return (
      <PreviewSurface
        device={{
          active: visible,
          running: false,
          scope: {
            storyId,
            projectId: project.id,
            title: selected.name,
            worktree: runner.projectPath,
            targetId: selected.previewTarget,
            workspaceMode: "direct",
            manifest: initialization.previewManifest,
          },
        }}
      />
    )
  if (isHostWindowConfiguration(selected))
    return (
      <PreviewSurface
        hostWindow={{
          mode: "direct",
          status,
          logs: runner.sessionFor(selected.id)?.logs,
          onStart: () => runner.start(selected.id, { revealLogs: false }),
          onStop: () => runner.stop(selected.id),
          onRestart: () => runner.start(selected.id, { revealLogs: false }),
        }}
      />
    )
  return (
    <UserStoryPreview
      // The same page as the header's preview: one app, one browser view.
      previewSessionKey={projectRunConfigurationPreviewKey(
        selected,
        runner.projectPath
      )}
      previewTitle={selected.name}
      previewUrl={previewUrl}
      projectRun={{
        surface: {
          configuration: selected,
          manifest: initialization?.previewManifest ?? undefined,
        },
        controls: ({ onMenuOpenChange }) => (
          <ProjectRunnerControls
            configurations={runner.configurations}
            disabled={!runner.projectPath || !runner.terminal}
            pending={runner.pendingOperation}
            runningOutside={outside}
            startBlocked={startBlocked(runner, selected.id)}
            selectedId={selected.id}
            statusFor={runner.statusFor}
            onMenuOpenChange={onMenuOpenChange}
            onSelect={runner.select}
            // Started here, the app's logs show in this preview, not in
            // the runner's logs drawer.
            onStart={(id) => {
              setStartRequest((request) => request + 1)
              runner.start(id, { revealLogs: false })
            }}
            onStop={runner.stop}
          />
        ),
        logs: {
          content:
            outside && runner.external.kind === "project"
              ? `${selected.name} is already running outside Blame (${portOwnerLabel(runner.external.owner)}). Its logs stay where it was started.`
              : (session?.logs ?? ""),
          items: runner.sessions.map((item) => ({
            id: item.configurationId,
            label: item.name,
            status: item.status,
          })),
          selected: session?.configurationId,
          onSelect: runner.selectSession,
        },
        runKey: runner.sessionFor(selected.id)?.sessionId,
        startRequest,
        notice:
          selected.id === runner.previewConfiguration?.id ? (
            <PortNotice runner={runner} />
          ) : undefined,
      }}
      visible={visible}
      onCapture={onCapture}
    />
  )
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
    <div className="pointer-events-auto flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
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

function NoRunConfiguration() {
  return (
    <div className="h-full min-h-0 p-6">
      <div className="flex h-full min-h-96 flex-col items-center justify-center gap-3 rounded-lg bg-muted/20 p-8 text-center">
        <MonitorIcon className="size-8 text-muted-foreground" />
        <div>
          <h3 className="font-heading text-lg font-semibold">Preview</h3>
          <p className="text-sm text-muted-foreground">
            This project has no run configuration yet. Once it has one, start
            the app here or from the header to see its preview.
          </p>
        </div>
      </div>
    </div>
  )
}
