import { PreviewSurface } from "./preview-surface"
import { isHostWindowConfiguration } from "./surfaces/host-window-kind"
import { MonitorIcon } from "lucide-react"

import { useSharedProjectRunner } from "@/components/backlog/board/project-runner-context"
import { useProjectRunPreview } from "@/components/backlog/drawer/project-run-preview"
import { UserStoryPreview } from "@/components/backlog/drawer/user-story-preview"
import { useProjects } from "@/context/projects"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"

// The preview of a story working directly in the project folder: the usual
// story preview, but its app is the project's own, started and stopped with
// the same runner as the header's controls, or found already running.
export function DirectStoryPreview({
  onCapture,
  onReadyChange,
  visible,
  storyId,
}: {
  storyId: string
  onCapture?: (file: File) => void
  onReadyChange?: (ready: boolean) => void
  visible: boolean
}) {
  const runner = useSharedProjectRunner()
  const project = useProjects().activeProject
  const initialization = useProjectInitialization()?.initialization
  const preview = useProjectRunPreview(runner)
  const selected = runner?.selected
  if (!runner || !selected || !preview) return <NoRunConfiguration />
  const status = runner.statusFor(selected.id)
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
      previewSessionKey={preview.sessionKey}
      previewTitle={preview.title}
      previewUrl={preview.previewUrl}
      projectRun={preview.projectRun}
      visible={visible}
      onCapture={onCapture}
      onReadyChange={onReadyChange}
    />
  )
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
