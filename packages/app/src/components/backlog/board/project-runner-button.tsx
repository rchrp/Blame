import * as React from "react"
import { createPortal } from "react-dom"

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
import { useLatestCallback } from "@/lib/use-latest-callback"

type RunnerDrawer = { open: boolean; view: PreviewView }

// The header's controls for the open project's app. The runner itself is
// shared (ProjectRunnerProvider), so a story running in the project folder
// drives the same processes from its preview. Its preview and logs open in
// a panel laid out as a story's preview tab, which these same controls
// drive from above it: one set of controls on screen, not two.
export function ProjectRunnerButton() {
  const runner = useSharedProjectRunner()
  const [drawer, setDrawer] = React.useState<RunnerDrawer>({
    open: false,
    view: "preview",
  })
  const [menuOpen, setMenuOpen] = React.useState(false)
  // A start from here, or an install to look into, opens the logs.
  const shown: RunnerDrawer = runner?.logsOpen
    ? { open: true, view: "setup-log" }
    : drawer
  const show = (next: RunnerDrawer) => {
    runner?.setLogsOpen(false)
    setDrawer(next)
  }
  // The view showing closes the drawer; another one switches to it.
  const toggle = (view: PreviewView) =>
    show({ open: !(shown.open && shown.view === view), view })
  if (!runner?.selected) return null
  const previewUrl = projectRunConfigurationPreviewUrl(runner.selected)
  const views: RunnerView[] = [
    {
      id: "preview",
      active: shown.open && shown.view === "preview",
      ready: Boolean(
        previewUrl && runner.statusFor(runner.selected.id) === "running"
      ),
      unavailable: previewUrl ? undefined : "This app has no preview",
      onSelect: () => toggle("preview"),
    },
    {
      id: "logs",
      active: shown.open && shown.view === "setup-log",
      onSelect: () => toggle("setup-log"),
    },
  ]
  return (
    <>
      <div data-project-runner="">
        <ProjectRunnerControls
          configurations={runner.configurations}
          disabled={!runner.projectPath || !runner.terminal}
          pending={runner.pendingOperation}
          selectedId={runner.selected.id}
          runningOutside={runningOutside(runner, runner.selected.id)}
          startBlocked={startBlocked(runner, runner.selected.id)}
          statusFor={runner.statusFor}
          views={views}
          onMenuOpenChange={setMenuOpen}
          onSelect={runner.select}
          onStart={(id) => runner.start(id)}
          onStop={runner.stop}
        />
      </div>
      <RunnerPanel
        open={shown.open}
        title={runner.selected.name}
        onClose={() => show({ ...shown, open: false })}
      >
        <RunnerDrawerPreview
          covered={menuOpen}
          runner={runner}
          view={shown.view}
          visible={shown.open}
          onViewChange={(view) => show({ ...shown, view })}
        />
      </RunnerPanel>
    </>
  )
}

// A panel docked to the bottom of the window, not a modal drawer: the
// header's controls above it stay usable. Escape, or a press outside both,
// closes it.
function RunnerPanel({
  children,
  open,
  title,
  onClose,
}: {
  children: React.ReactNode
  open: boolean
  title: string
  onClose: () => void
}) {
  const panelRef = React.useRef<HTMLElement>(null)
  const [present, setPresent] = React.useState(open)
  // Mounted while open, and while it slides away.
  if (open && !present) setPresent(true)
  const close = useLatestCallback(onClose)
  React.useEffect(() => {
    if (open || !present) return
    const unmount = window.setTimeout(() => setPresent(false), 350)
    return () => window.clearTimeout(unmount)
  }, [open, present])
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close()
    }
    const onPointerDown = (event: PointerEvent) => {
      // A menu or dialog above the app takes that press for itself.
      if (document.body.style.pointerEvents === "none") return
      const target = event.target
      if (
        target instanceof Node &&
        (panelRef.current?.contains(target) ||
          (target instanceof Element &&
            target.closest(
              "[data-project-runner], [data-sonner-toaster], [data-radix-popper-content-wrapper]"
            )))
      )
        return
      close()
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown, true)
    }
  }, [close, open])
  if (!present) return null
  return createPortal(
    <section
      ref={panelRef}
      aria-label={title}
      className="fixed inset-x-0 bottom-0 z-40 flex h-[min(80vh,calc(100vh-6rem))] flex-col overflow-hidden rounded-t-xl border-t bg-popover text-sm text-popover-foreground shadow-[0_-12px_32px_-16px_rgb(0_0_0/0.35)] transition-transform duration-300 ease-out data-[state=closed]:translate-y-full motion-reduce:transition-none starting:translate-y-full"
      data-state={open ? "open" : "closed"}
    >
      {children}
    </section>,
    document.body
  )
}

function RunnerDrawerPreview({
  covered,
  runner,
  view,
  visible,
  onViewChange,
}: {
  covered: boolean
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
      covered={covered}
      previewSessionKey={preview.sessionKey}
      previewTitle={preview.title}
      previewUrl={preview.previewUrl}
      projectRun={{
        ...preview.projectRun,
        // The header's controls drive this drawer.
        controls: undefined,
        surface: web ? preview.projectRun.surface : undefined,
      }}
      view={view}
      visible={visible}
      onViewChange={onViewChange}
    />
  )
}
