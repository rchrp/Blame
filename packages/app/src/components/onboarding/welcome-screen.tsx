import {
  ClockIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  LoaderCircleIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"
import * as React from "react"
import { AnimatePresence, motion } from "motion/react"

import { BlameLogoMark } from "@/components/brand/blame-logo-mark"
import { NewProjectDialog } from "@/components/new-project/new-project-dialog"
import { GlassPanel } from "@/components/onboarding/stage/glass-panel"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { useCloudAuth } from "@/context/cloud-auth"
import type { HostDependencyReport } from "@/context/platform"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"
import { isKeyOwnedByTarget, useRovingFocus } from "@/lib/keyboard"
import { undoable } from "@/lib/undoable"
import { easeOutExpo, riseIn, staggerContainer } from "@/lib/motion"
import type { Project } from "@/lib/projects"
import { HostDependenciesDialog } from "@/pages/backlog/host-dependencies-dialog"

export function WelcomeScreen() {
  const projectOpening = useProjectOpening()
  const [newProjectOpen, setNewProjectOpen] = React.useState(false)
  // Removed projects stay hidden while their "Undo" toast is visible.
  const [pendingRemovals, setPendingRemovals] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const recentProjects = projectOpening.recentProjects
    .filter((project) => !pendingRemovals.has(project.path))
    .slice(0, 6)

  function setPendingRemoval(path: string, pending: boolean) {
    setPendingRemovals((current) => {
      const next = new Set(current)
      if (pending) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function removeRecentProject(path: string) {
    const project = projectOpening.recentProjects.find((item) => item.path === path)
    setPendingRemoval(path, true)
    undoable({
      message: `Removed ${project?.name ?? "project"} from recent projects`,
      undo: () => setPendingRemoval(path, false),
      commit: () => {
        projectOpening.removeRecentProject(path)
        setPendingRemoval(path, false)
      },
    })
  }

  useWelcomeShortcuts({
    enabled: !newProjectOpen && !projectOpening.hostDependenciesDialog.open,
    onNewProject: () => setNewProjectOpen(true),
    onOpenProject: () => void projectOpening.chooseProject(),
    onOpenRecent: (index) => {
      const project = recentProjects[index]
      if (project && !projectOpening.opening) void projectOpening.openProject(project.path)
    },
  })

  return (
    <>
      <section className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-7 px-6 pt-12 pb-16">
        <WelcomeHeader />
        <WelcomeActions
          opening={projectOpening.opening}
          onNewProject={() => setNewProjectOpen(true)}
          onOpenProject={() => void projectOpening.chooseProject()}
        />
        <RecentProjects
          projects={recentProjects}
          opening={projectOpening.opening}
          onOpen={projectOpening.openProject}
          onRemove={removeRecentProject}
        />
      </section>
      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
      />
      <HostDependenciesDialog {...projectOpening.hostDependenciesDialog} />
    </>
  )
}

// N: new project, O: open a folder, 1-6: open a recent project.
function useWelcomeShortcuts({
  enabled,
  onNewProject,
  onOpenProject,
  onOpenRecent,
}: {
  enabled: boolean
  onNewProject(): void
  onOpenProject(): void
  onOpenRecent(index: number): void
}) {
  const handlers = React.useRef({ onNewProject, onOpenProject, onOpenRecent })

  React.useEffect(() => {
    handlers.current = { onNewProject, onOpenProject, onOpenRecent }
  })

  React.useEffect(() => {
    if (!enabled) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isKeyOwnedByTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (key === "n") handlers.current.onNewProject()
      else if (key === "o") handlers.current.onOpenProject()
      else if (/^[1-6]$/.test(key)) handlers.current.onOpenRecent(Number(key) - 1)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [enabled])
}

function useProjectOpening() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const [hostDependenciesDialog, setHostDependenciesDialog] =
    React.useState<OpenProjectHostDependenciesDialogState>()
  const [checkingOpenDependencies, setCheckingOpenDependencies] =
    React.useState(false)

  async function chooseProject() {
    const result = await platform.openDirectoryPickerDialog?.({
      title: "Open Project",
    })
    const path = Array.isArray(result) ? result[0] : result
    if (path) await openProject(path)
  }

  async function openProject(path: string) {
    if (!(await checkOpenHostDependencies(path))) return
    const project = await projects.openProject(path)
    await checkProjectHostDependencies(project)
  }

  async function checkOpenHostDependencies(path: string) {
    if (!platform.workspace?.checkHostDependencies) return true
    setCheckingOpenDependencies(true)
    try {
      const report = await platform.workspace.checkHostDependencies({})
      if (report.ok) return true
      setHostDependenciesDialog({
        checking: false,
        pendingPath: path,
        report,
      })
      return false
    } finally {
      setCheckingOpenDependencies(false)
    }
  }

  async function checkProjectHostDependencies(project: Project) {
    try {
      const initialized = await projectInitialized(
        auth.apiConnection,
        project.id
      )
      if (!initialized || !platform.workspace?.checkHostDependencies) return
      const report = await platform.workspace.checkHostDependencies({})
      if (report.ok) return
      setHostDependenciesDialog({ checking: false, report })
    } catch {
      return
    }
  }

  async function recheckHostDependencies() {
    const current = hostDependenciesDialog
    if (!current || !platform.workspace?.checkHostDependencies) return
    setHostDependenciesDialog({ ...current, checking: true })
    try {
      const report = await platform.workspace.checkHostDependencies({})
      if (report.ok) {
        setHostDependenciesDialog(undefined)
        if (current.pendingPath) await openProject(current.pendingPath)
        return
      }
      setHostDependenciesDialog({ ...current, checking: false, report })
    } catch {
      setHostDependenciesDialog({ ...current, checking: false })
    }
  }

  return {
    ...projects,
    chooseProject,
    hostDependenciesDialog: {
      checking: Boolean(hostDependenciesDialog?.checking),
      onOpenChange(open: boolean) {
        if (!open) setHostDependenciesDialog(undefined)
      },
      onRecheck: recheckHostDependencies,
      open: Boolean(hostDependenciesDialog),
      report: hostDependenciesDialog?.report,
    },
    opening: projects.opening || checkingOpenDependencies,
    openProject,
  }
}

type OpenProjectHostDependenciesDialogState = {
  checking: boolean
  pendingPath?: string
  report: HostDependencyReport
}

async function projectInitialized(
  apiConnection: ReturnType<typeof useCloudAuth>["apiConnection"],
  projectId: string
) {
  const snapshot =
    await createCloudApi(apiConnection).projectInitialization(projectId)
  return snapshot.initialization?.status === "done"
}

function WelcomeHeader() {
  const auth = useCloudAuth()
  const firstName = auth.user?.fullName?.trim().split(/\s+/)[0]

  return (
    <motion.header
      className="grid justify-items-center gap-3 text-center"
      variants={staggerContainer(0.08)}
      initial="initial"
      animate="animate"
    >
      <motion.span variants={riseIn} className="block size-12">
        <BlameLogoMark className="size-full" />
      </motion.span>
      <motion.p variants={riseIn} className="text-sm font-medium text-foreground/60">
        {greeting()}
        {firstName ? `, ${firstName}` : ""}
      </motion.p>
      <motion.h1
        variants={riseIn}
        className="font-heading text-4xl font-bold tracking-[-0.03em]"
      >
        What are we building today?
      </motion.h1>
    </motion.header>
  )
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 5) return "Burning the midnight oil"
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

function WelcomeActions({
  opening,
  onNewProject,
  onOpenProject,
}: {
  opening: boolean
  onNewProject(): void
  onOpenProject(): void
}) {
  const handleKeyDown = useRovingFocus(3)

  return (
    <motion.div
      role="group"
      aria-label="Start"
      className="grid gap-2.5 md:grid-cols-3"
      variants={staggerContainer(0.07, 0.2)}
      initial="initial"
      animate="animate"
      onKeyDown={handleKeyDown}
    >
      <WelcomeAction
        autoFocus
        icon={<PlusIcon />}
        label="New Project"
        description="Start from a template."
        shortcut="N"
        onClick={onNewProject}
      />
      <WelcomeAction
        disabled={opening}
        icon={
          opening ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <FolderOpenIcon />
          )
        }
        label={opening ? "Opening" : "Open Project"}
        description="Choose a folder."
        shortcut="O"
        onClick={onOpenProject}
      />
      <WelcomeAction
        disabled
        icon={<GitBranchPlusIcon />}
        label="Clone Repository"
        description="Coming soon."
      />
    </motion.div>
  )
}

function WelcomeAction({
  autoFocus,
  description,
  disabled,
  icon,
  label,
  onClick,
  shortcut,
}: {
  autoFocus?: boolean
  description: string
  disabled?: boolean
  icon: React.ReactNode
  label: string
  onClick?(): void
  shortcut?: string
}) {
  return (
    <motion.button
      type="button"
      data-roving-item
      autoFocus={autoFocus}
      variants={riseIn}
      whileHover={disabled ? undefined : { y: -3 }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      disabled={disabled}
      className="group relative flex items-center gap-3 rounded-2xl border border-white/70 bg-white/60 p-3.5 text-left shadow-[0_10px_30px_-18px_rgba(28,36,120,0.45)] backdrop-blur-xl outline-none transition-[background-color,box-shadow,border-color] duration-200 hover:bg-white/85 hover:shadow-[0_18px_36px_-18px_var(--primary)] focus-visible:border-primary/50 focus-visible:ring-3 focus-visible:ring-primary/25 disabled:pointer-events-none disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:hover:bg-white/[0.09]"
      onClick={onClick}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground transition-[background-color,color,transform] duration-300 group-hover:scale-105 group-hover:bg-primary group-hover:text-primary-foreground group-focus-visible:bg-primary group-focus-visible:text-primary-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-sm font-semibold">{label}</span>
        <span className="truncate text-xs text-foreground/55">
          {description}
        </span>
      </span>
      {shortcut ? <Kbd className="bg-foreground/[0.06]">{shortcut}</Kbd> : null}
    </motion.button>
  )
}

function RecentProjects({
  onOpen,
  onRemove,
  opening,
  projects,
}: {
  onOpen(path: string): void
  onRemove(path: string): void
  opening: boolean
  projects: Project[]
}) {
  const handleKeyDown = useRovingFocus(1)

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35, duration: 0.6, ease: easeOutExpo }}
    >
      <GlassPanel className="p-3">
        <div className="flex items-center justify-between px-2 pt-1 pb-2">
          <SectionTitle icon={<ClockIcon />} title="Recent projects" />
          {projects.length > 0 ? (
            <span className="text-xs text-foreground/45">
              <Kbd className="bg-foreground/[0.06]">↑</Kbd>{" "}
              <Kbd className="bg-foreground/[0.06]">↓</Kbd> to browse
            </span>
          ) : null}
        </div>
        {projects.length > 0 ? (
          <motion.ul
            className="grid gap-0.5"
            onKeyDown={handleKeyDown}
            variants={staggerContainer(0.05, 0.45)}
            initial="initial"
            animate="animate"
          >
            <AnimatePresence initial={false}>
              {projects.map((project, index) => (
                <RecentProject
                  key={project.path}
                  index={index}
                  project={project}
                  disabled={opening}
                  onOpen={onOpen}
                  onRemove={onRemove}
                />
              ))}
            </AnimatePresence>
          </motion.ul>
        ) : (
          <EmptyRecentProjects />
        )}
      </GlassPanel>
    </motion.section>
  )
}

function RecentProject({
  disabled,
  index,
  onOpen,
  onRemove,
  project,
}: {
  disabled: boolean
  index: number
  onOpen(path: string): void
  onRemove(path: string): void
  project: Project
}) {
  return (
    <motion.li
      layout
      variants={riseIn}
      exit={{ opacity: 0, x: -16, transition: { duration: 0.2 } }}
      className="group flex min-w-0 items-center gap-1 rounded-xl transition-colors duration-150 focus-within:bg-foreground/[0.05] hover:bg-foreground/[0.05]"
    >
      <button
        type="button"
        data-roving-item
        disabled={disabled}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpen(project.path)}
        onKeyDown={(event) => {
          if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault()
            onRemove(project.path)
          }
        }}
      >
        <ProjectMark project={project} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-semibold">{project.name}</span>
          <span className="flex min-w-0 items-center gap-2 text-xs text-foreground/55">
            <span className="truncate">{project.path}</span>
            <ProjectBranch branch={project.branch} />
          </span>
        </span>
        <Kbd className="bg-foreground/[0.06] opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {index + 1}
        </Kbd>
      </button>
      <RemoveRecentProject project={project} onRemove={onRemove} />
    </motion.li>
  )
}

function RemoveRecentProject({
  onRemove,
  project,
}: {
  onRemove(path: string): void
  project: Project
}) {
  function removeProject(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    onRemove(project.path)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      tabIndex={-1}
      aria-label={`Remove ${project.name} from recent projects`}
      className="mr-1 opacity-0 transition-opacity group-hover:opacity-100"
      onClick={removeProject}
    >
      <XIcon />
    </Button>
  )
}

function EmptyRecentProjects() {
  return (
    <div className="mx-2 mb-1 rounded-xl bg-foreground/[0.03] p-4 text-sm text-foreground/55">
      No recent projects yet. Open a folder or create a new project to pin it
      here.
    </div>
  )
}

function SectionTitle({
  icon,
  title,
}: {
  icon: React.ReactNode
  title: string
}) {
  return (
    <span className="flex items-center gap-2 text-sm font-semibold">
      <span className="text-foreground/60 [&_svg]:size-4">{icon}</span>
      {title}
    </span>
  )
}

function ProjectBranch({ branch }: { branch?: string }) {
  if (!branch) return null

  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-foreground/60">
      <GitBranchIcon className="size-3" />
      <span className="truncate">{branch}</span>
    </span>
  )
}

function ProjectMark({ project }: { project: Project }) {
  return (
    <span
      className={`${project.color} flex size-9 shrink-0 items-center justify-center rounded-md text-sm font-medium text-white`}
    >
      {project.initials}
    </span>
  )
}
