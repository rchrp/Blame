import * as React from "react"

import { projectRunConfigurationPreviewUrl } from "@/components/backlog/board/project-run-configuration"
import {
  type SharedProjectRunner,
  useSharedProjectRunner,
} from "@/components/backlog/board/project-runner-context"
import {
  ProjectRunnerControls,
  type RunnerView,
} from "@/components/backlog/board/project-runner-controls"
import {
  runningOutside,
  startBlocked,
  useProjectRunPreview,
} from "@/components/backlog/drawer/project-run-preview"
import {
  UserStoryPreview,
  type PreviewView,
} from "@/components/backlog/drawer/user-story-preview"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"

type RunnerDrawer = { open: boolean; view: PreviewView }

// The header's controls for the open project's app. The runner itself is
// shared (ProjectRunnerProvider), so a story running in the project folder
// drives the same processes from its preview. Its preview and logs open in
// one drawer, laid out as a story's preview tab.
export function ProjectRunnerButton() {
  const runner = useSharedProjectRunner()
  const [drawer, setDrawer] = React.useState<RunnerDrawer>({
    open: false,
    view: "preview",
  })
  // A start from here, or an install to look into, opens the logs.
  const shown: RunnerDrawer = runner?.logsOpen
    ? { open: true, view: "setup-log" }
    : drawer
  const show = (next: RunnerDrawer) => {
    runner?.setLogsOpen(false)
    setDrawer(next)
  }
  if (!runner?.selected) return null
  const previewUrl = projectRunConfigurationPreviewUrl(runner.selected)
  const views: RunnerView[] = [
    {
      id: "preview",
      active: shown.open && shown.view === "preview",
      unavailable: previewUrl ? undefined : "This app has no preview",
      onSelect: () => show({ open: true, view: "preview" }),
    },
    {
      id: "logs",
      active: shown.open && shown.view === "setup-log",
      onSelect: () => show({ open: true, view: "setup-log" }),
    },
  ]
  return (
    <>
      <ProjectRunnerControls
        configurations={runner.configurations}
        disabled={!runner.projectPath || !runner.terminal}
        pending={runner.pendingOperation}
        selectedId={runner.selected.id}
        runningOutside={runningOutside(runner, runner.selected.id)}
        startBlocked={startBlocked(runner, runner.selected.id)}
        statusFor={runner.statusFor}
        views={views}
        onSelect={runner.select}
        onStart={(id) => runner.start(id)}
        onStop={runner.stop}
      />
      <Drawer
        direction="bottom"
        open={shown.open}
        onOpenChange={(open) => show({ ...shown, open })}
      >
        {/* The preview lays two muted/20 veils over the drawer: its handle's
            band gets the same, so the drawer reads as one surface. */}
        <DrawerContent className="h-[80vh] overflow-hidden bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--muted)_36%,transparent)_1.25rem,transparent_1.25rem)] p-0">
          <DrawerTitle className="sr-only">{runner.selected.name}</DrawerTitle>
          <RunnerDrawerPreview
            runner={runner}
            view={shown.view}
            visible={shown.open}
            onViewChange={(view) => show({ ...shown, view })}
          />
        </DrawerContent>
      </Drawer>
    </>
  )
}

function RunnerDrawerPreview({
  runner,
  view,
  visible,
  onViewChange,
}: {
  runner: SharedProjectRunner
  view: PreviewView
  visible: boolean
  onViewChange: (view: PreviewView) => void
}) {
  const preview = useProjectRunPreview(runner)
  if (!preview) return null
  // Host windows and devices show in a story only: here, their logs.
  const web = Boolean(projectRunConfigurationPreviewUrl(runner.selected))
  return (
    <UserStoryPreview
      previewSessionKey={preview.sessionKey}
      previewTitle={preview.title}
      previewUrl={preview.previewUrl}
      projectRun={
        web ? preview.projectRun : { ...preview.projectRun, surface: undefined }
      }
      view={view}
      visible={visible}
      onViewChange={onViewChange}
    />
  )
}
