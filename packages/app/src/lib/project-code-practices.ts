import type { useCloudAuth } from "@/context/cloud-auth"
import type { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"
import { effectiveProjectCodePractices } from "@/lib/project-code-practice-preferences"

export function projectCodePractices(
  auth: ReturnType<typeof useCloudAuth>,
  projects: ReturnType<typeof useProjects>
) {
  if (!projects.activeProject) return Promise.resolve([])
  return createCloudApi(auth.apiConnection)
    .projectInitialization(projects.activeProject.id)
    .then((snapshot) => effectiveProjectCodePractices(snapshot.practices))
    // The API being out of reach must not stop a message: the defaults apply.
    .catch(() => effectiveProjectCodePractices([]))
}
