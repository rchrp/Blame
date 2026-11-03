import {
  ProjectRunnerControls,
  type RunnerView,
} from "@/components/backlog/board/project-runner-controls"
import type { ProjectRunnerControlStatus } from "@/components/backlog/board/project-runner-types"
import type {
  PreviewRunnerAction,
  UserStoryPreviewRunner,
} from "@/components/backlog/drawer/use-user-story-preview-runner"

export function UserStoryPreviewRunnerControls({
  onConfigurationChange,
  onMenuOpenChange,
  runner,
  views,
}: {
  onConfigurationChange?: (configurationId: string, previewUrl?: string) => void
  onMenuOpenChange?: (open: boolean) => void
  runner: UserStoryPreviewRunner
  views?: RunnerView[]
}) {
  if (!runner.runtime) return null
  const control = previewRunnerControl(runner, onConfigurationChange)
  return (
    <div className="pointer-events-auto shrink-0">
      <ProjectRunnerControls
        configurations={runner.runtime.configurations}
        pending={runner.pendingOperation}
        selectedId={runner.selectedId}
        statusFor={(id) => previewConfigurationStatus(runner, id)}
        views={views}
        onMenuOpenChange={onMenuOpenChange}
        onSelect={runner.select}
        onStart={(id, restart) =>
          void control(restart ? "restart" : "start", id)
        }
        onStop={(id) => void control("stop", id)}
      />
    </div>
  )
}

function previewRunnerControl(
  runner: UserStoryPreviewRunner,
  onChange?: (configurationId: string, previewUrl?: string) => void
) {
  return async (action: PreviewRunnerAction, configurationId: string) => {
    const next = await runner.control(action, configurationId)
    if (!next) return
    onChange?.(configurationId, action === "stop" ? undefined : next.previewUrl)
  }
}

function previewConfigurationStatus(
  runner: UserStoryPreviewRunner,
  configurationId: string
): ProjectRunnerControlStatus {
  return runner.runtime?.statuses[configurationId] ?? "stopped"
}
