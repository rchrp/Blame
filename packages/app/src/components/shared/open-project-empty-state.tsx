import { FolderOpenIcon } from "lucide-react"

import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { useProjects } from "@/context/projects"

export function OpenProjectEmptyState({ description }: { description: string }) {
  const projects = useProjects()
  const recent = projects.recentProjects.slice(0, 3)
  return (
    <EmptyState
      icon={<FolderOpenIcon />}
      title="No project open"
      description={description}
      action={
        <>
          <Button
            type="button"
            disabled={projects.opening}
            onClick={() => void projects.chooseProject()}
          >
            <FolderOpenIcon /> Open a project
          </Button>
          {recent.map((project) => (
            <Button
              key={project.path}
              type="button"
              variant="outline"
              disabled={projects.opening}
              title={project.path}
              onClick={() => void projects.switchProject(project.path)}
            >
              {project.name}
            </Button>
          ))}
        </>
      }
    />
  )
}
