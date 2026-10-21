import * as React from "react"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { NewProjectDialog } from "@/components/new-project/new-project-dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { useProjects } from "@/context/projects"
import type { Project } from "@/lib/projects"
import {
  ChevronDownIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"

export function ProjectSelector() {
  const projects = useProjects()
  const [open, setOpen] = React.useState(false)
  const [newProjectOpen, setNewProjectOpen] = React.useState(false)

  async function openProject() {
    setOpen(false)
    await projects.chooseProject()
  }

  function openNewProject() {
    setNewProjectOpen(true)
    setOpen(false)
  }

  function selectProject(path: string) {
    setOpen(false)
    void projects.switchProject(path)
  }

  function removeRecentProject(path: string) {
    projects.removeRecentProject(path)
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <SidebarMenuButton
            className="h-9 justify-between px-1.5 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            tooltip={projects.activeProject?.name ?? "Open Project"}
          >
            <ProjectTrigger project={projects.activeProject} />
            <ChevronDownIcon className="ml-auto size-4 text-muted-foreground" />
          </SidebarMenuButton>
        </PopoverTrigger>
        <ProjectSelectorContent
          activeProject={projects.activeProject}
          recentProjects={projects.recentProjects}
          opening={projects.opening}
          onNewProject={openNewProject}
          onOpenProject={openProject}
          onSelectProject={selectProject}
          onRemoveRecentProject={removeRecentProject}
        />
      </Popover>
      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
      />
    </>
  )
}

function ProjectTrigger({ project }: { project?: Project }) {
  if (!project) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <FolderOpenIcon className="size-5" />
        <span className="truncate font-medium">Open Project</span>
      </span>
    )
  }

  return (
    <span className="flex min-w-0 items-center gap-2">
      <ProjectMark project={project} />
      <span className="truncate font-medium">{project.name}</span>
    </span>
  )
}

function ProjectSelectorContent({
  activeProject,
  recentProjects,
  opening,
  onNewProject,
  onOpenProject,
  onSelectProject,
  onRemoveRecentProject,
}: {
  activeProject?: Project
  recentProjects: Project[]
  opening: boolean
  onNewProject: () => void
  onOpenProject: () => Promise<void>
  onSelectProject: (path: string) => void
  onRemoveRecentProject: (path: string) => void
}) {
  return (
    <PopoverContent align="start" className="w-80 p-1">
      <Command>
        <CommandList>
          <ProjectActions
            opening={opening}
            onNewProject={onNewProject}
            onOpenProject={onOpenProject}
          />
          {activeProject && (
            <>
              <CommandSeparator />
              <ProjectGroup
                heading="Open Project"
                projects={[activeProject]}
                selectedPath={activeProject.path}
                onSelect={onSelectProject}
              />
            </>
          )}
          <RecentProjects
            activeProject={activeProject}
            recentProjects={recentProjects}
            onSelect={onSelectProject}
            onRemove={onRemoveRecentProject}
          />
        </CommandList>
      </Command>
    </PopoverContent>
  )
}

function ProjectActions({
  opening,
  onNewProject,
  onOpenProject,
}: {
  opening: boolean
  onNewProject: () => void
  onOpenProject: () => Promise<void>
}) {
  return (
    <CommandGroup>
      <CommandItem onSelect={onNewProject}>
        <PlusIcon />
        <span>New Project...</span>
      </CommandItem>
      <CommandItem disabled={opening} onSelect={() => void onOpenProject()}>
        <FolderOpenIcon />
        <span>{opening ? "Opening Project..." : "Open Project..."}</span>
      </CommandItem>
      <CommandItem>
        <GitBranchPlusIcon />
        <span>Clone Repository...</span>
      </CommandItem>
    </CommandGroup>
  )
}

function RecentProjects({
  activeProject,
  recentProjects,
  onSelect,
  onRemove,
}: {
  activeProject?: Project
  recentProjects: Project[]
  onSelect: (path: string) => void
  onRemove: (path: string) => void
}) {
  const visibleRecentProjects = activeProject
    ? recentProjects.filter((project) => project.path !== activeProject.path)
    : recentProjects

  if (visibleRecentProjects.length === 0) {
    if (activeProject) return null
    return <CommandEmpty>No project opened yet</CommandEmpty>
  }

  return (
    <>
      <CommandSeparator />
      <ProjectGroup
        heading="Recent Projects"
        projects={visibleRecentProjects}
        selectedPath={activeProject?.path}
        onSelect={onSelect}
        onRemove={onRemove}
      />
    </>
  )
}

function ProjectGroup({
  heading,
  projects,
  selectedPath,
  onSelect,
  onRemove,
}: {
  heading: string
  projects: Project[]
  selectedPath?: string
  onSelect: (path: string) => void
  onRemove?: (path: string) => void
}) {
  return (
    <CommandGroup heading={heading}>
      {projects.map((project) => (
        <ProjectItem
          key={project.path}
          project={project}
          selected={selectedPath === project.path}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
    </CommandGroup>
  )
}

function ProjectItem({
  project,
  selected,
  onSelect,
  onRemove,
}: {
  project: Project
  selected: boolean
  onSelect: (path: string) => void
  onRemove?: (path: string) => void
}) {
  return (
    <CommandItem
      value={project.path}
      data-checked={selected}
      onSelect={() => onSelect(project.path)}
      className="items-start gap-2"
    >
      <ProjectMark project={project} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate font-medium">{project.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {project.path}
        </span>
        <ProjectBranch branch={project.branch} />
      </span>
      {onRemove && (
        <RemoveRecentProjectButton project={project} onRemove={onRemove} />
      )}
    </CommandItem>
  )
}

function RemoveRecentProjectButton({
  project,
  onRemove,
}: {
  project: Project
  onRemove: (path: string) => void
}) {
  function removeProject(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    onRemove(project.path)
  }

  return (
    <CommandShortcut className="tracking-normal opacity-0 group-hover/command-item:opacity-100">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${project.name} from recent projects`}
        onClick={removeProject}
      >
        <XIcon />
      </Button>
    </CommandShortcut>
  )
}

function ProjectBranch({ branch }: { branch?: string }) {
  if (!branch) return null

  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <GitBranchIcon className="size-3" />
      <span className="truncate">{branch}</span>
    </span>
  )
}

function ProjectMark({ project }: { project: Project }) {
  return (
    <span
      className={`${project.color} flex size-5 shrink-0 items-center justify-center rounded-sm text-xs font-medium text-white`}
    >
      {project.initials}
    </span>
  )
}
