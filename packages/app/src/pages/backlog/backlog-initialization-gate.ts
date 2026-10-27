import { toast } from "sonner"

import type { StoryRunMode } from "@/lib/runtime-preference"
import { navigate } from "@/components/navigation/navigation"
import {
  initializationRunningHere,
  projectInitializationAvailability,
  storyInitializationDecision,
} from "@/components/project-initialization/project-initialization-availability"
import type { CloudProjectInitialization } from "@/context/cloud-auth"

export function storyInitializationGate(
  initialization: CloudProjectInitialization | null | undefined,
  projectId: string,
  mode: StoryRunMode
) {
  return storyInitializationDecision(
    projectInitializationAvailability(initialization, {
      runningHere: initializationRunningHere(projectId),
    }),
    mode
  )
}

const notifiedProjects = new Set<string>()

/** Tells once per project why its stories now run Direct. */
export function notifyDirectFallback(projectId: string, storyTitle: string) {
  if (notifiedProjects.has(projectId)) return
  notifiedProjects.add(projectId)
  toast.warning("Running in Direct mode", {
    description: `This project has no working initialization, so “${storyTitle}” runs in your project folder with your own setup. Previews come back once the initialization works.`,
    action: {
      label: "Open initialization",
      onClick: () => navigate("/initialization"),
    },
    duration: 15_000,
    id: `project-initialization-direct-${projectId}`,
    position: "bottom-right",
  })
}
