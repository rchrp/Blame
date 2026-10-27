import * as React from "react"

import type {
  CloudProjectInitialization,
  CloudProjectInitializationStatus,
} from "@/context/cloud-auth"
import { useCloudAuth } from "@/context/cloud-auth"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"
import { subscribeProjectInitializationUpdated } from "@/components/project-initialization/project-initialization-events"
import {
  initializationRunningHere,
  projectInitializationAvailability,
  subscribeInitializationRunning,
} from "@/components/project-initialization/project-initialization-availability"

export function useProjectInitialization() {
  const auth = useCloudAuth()
  const projects = useProjects()
  const [snapshot, setSnapshot] =
    React.useState<ProjectInitializationStatusSnapshot>()
  const activeProjectId = projects.activeProject?.id
  const runningHere = React.useSyncExternalStore(
    subscribeInitializationRunning,
    () => Boolean(activeProjectId && initializationRunningHere(activeProjectId))
  )
  const currentSnapshot =
    auth.status === "authenticated" &&
    snapshot &&
    snapshot.projectId === activeProjectId
      ? {
          ...snapshot,
          availability: projectInitializationAvailability(
            snapshot.initialization,
            { runningHere }
          ),
        }
      : undefined

  React.useEffect(() => {
    const activeProject = projects.activeProject
    if (!activeProject || auth.status !== "authenticated") return
    let cancelled = false
    const cloud = createCloudApi(auth.apiConnection)
    const refresh = async () => {
      const snapshot = await cloud.projectInitialization(activeProject.id)
      if (cancelled) return
      const status = snapshot.initialization?.status ?? "pending"
      setSnapshot({
        initialization: snapshot.initialization ?? undefined,
        projectId: activeProject.id,
        status,
      })
    }
    void refresh().catch(() => {
      if (!cancelled) setSnapshot(undefined)
    })
    const unsubscribe = subscribeProjectInitializationUpdated(
      activeProject.id,
      () => void refresh().catch(() => undefined)
    )
    const unsubscribeRunning = subscribeInitializationRunning(
      () => void refresh().catch(() => undefined)
    )
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeRunning()
    }
  }, [auth, projects.activeProject])

  return currentSnapshot
}

type ProjectInitializationStatusSnapshot = {
  initialization?: CloudProjectInitialization
  projectId: string
  status: CloudProjectInitializationStatus
}
