import { MonitorIcon } from "lucide-react"

import {
  projectRunConfigurationPreviewKey,
  projectRunConfigurationPreviewUrl,
} from "@/components/backlog/board/project-run-configuration"
import { useSharedProjectRunner } from "@/components/backlog/board/project-runner-context"
import { ProjectRunnerControls } from "@/components/backlog/board/project-runner-controls"
import { UserStoryPreview } from "@/components/backlog/drawer/user-story-preview"

// The preview of a story working directly in the project folder: the usual
// story preview, but its app is the project's own, started and stopped with
// the same runner as the header's controls.
export function DirectStoryPreview({
  onCapture,
  visible,
}: {
  onCapture?: (file: File) => void
  visible: boolean
}) {
  const runner = useSharedProjectRunner()
  const selected = runner?.selected
  if (!runner || !selected) return <NoRunConfiguration />
  const status = runner.sessionFor(selected.id)?.status ?? "stopped"
  const previewUrl =
    status === "running"
      ? projectRunConfigurationPreviewUrl(selected)
      : undefined
  const session = runner.activeSession
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
        controls: ({ onMenuOpenChange }) => (
          <ProjectRunnerControls
            configurations={runner.configurations}
            disabled={!runner.projectPath || !runner.terminal}
            pending={runner.pendingOperation}
            selectedId={selected.id}
            statusFor={(id) => runner.sessionFor(id)?.status ?? "stopped"}
            onMenuOpenChange={onMenuOpenChange}
            onSelect={runner.select}
            onStart={runner.start}
            onStop={runner.stop}
          />
        ),
        logs: {
          content: session?.logs ?? "",
          items: runner.sessions.map((item) => ({
            id: item.configurationId,
            label: item.name,
            status: item.status,
          })),
          selected: session?.configurationId,
          onSelect: runner.selectSession,
        },
      }}
      visible={visible}
      onCapture={onCapture}
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
