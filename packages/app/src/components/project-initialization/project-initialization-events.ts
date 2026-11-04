const projectInitializationUpdatedEvent = "project-initialization:updated"

export function notifyProjectInitializationUpdated(projectId: string) {
  window.dispatchEvent(
    new CustomEvent(projectInitializationUpdatedEvent, { detail: projectId })
  )
}

export function subscribeProjectInitializationUpdated(
  projectId: string,
  callback: () => void
) {
  const handleUpdate = (event: Event) => {
    if ((event as CustomEvent<string>).detail === projectId) callback()
  }
  window.addEventListener(projectInitializationUpdatedEvent, handleUpdate)
  return () =>
    window.removeEventListener(projectInitializationUpdatedEvent, handleUpdate)
}

const projectInitializationRunRequestedEvent =
  "project-initialization:run-requested"

type RunRequest = {
  projectId: string
  /** A database mode chosen up front: the run does not ask for it. */
  databaseMode?: "compose" | "existing"
}

/** Asks the mounted initialization runner to run this project again. */
export function requestProjectInitializationRun(
  projectId: string,
  options: { databaseMode?: "compose" | "existing" } = {}
) {
  window.dispatchEvent(
    new CustomEvent<RunRequest>(projectInitializationRunRequestedEvent, {
      detail: { projectId, ...options },
    })
  )
}

export function subscribeProjectInitializationRunRequested(
  callback: (projectId: string, options: Omit<RunRequest, "projectId">) => void
) {
  const handleRequest = (event: Event) => {
    const { projectId, ...options } = (event as CustomEvent<RunRequest>).detail
    callback(projectId, options)
  }
  window.addEventListener(projectInitializationRunRequestedEvent, handleRequest)
  return () =>
    window.removeEventListener(
      projectInitializationRunRequestedEvent,
      handleRequest
    )
}

const projectInitializationCancelRequestedEvent =
  "project-initialization:cancel-requested"

/** Asks the mounted initialization runner to cancel this project's run. */
export function requestProjectInitializationCancel(projectId: string) {
  window.dispatchEvent(
    new CustomEvent<string>(projectInitializationCancelRequestedEvent, {
      detail: projectId,
    })
  )
}

export function subscribeProjectInitializationCancelRequested(
  callback: (projectId: string) => void
) {
  const handleRequest = (event: Event) =>
    callback((event as CustomEvent<string>).detail)
  window.addEventListener(
    projectInitializationCancelRequestedEvent,
    handleRequest
  )
  return () =>
    window.removeEventListener(
      projectInitializationCancelRequestedEvent,
      handleRequest
    )
}
