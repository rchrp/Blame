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

/** Asks the mounted initialization runner to run this project again. */
export function requestProjectInitializationRun(projectId: string) {
  window.dispatchEvent(
    new CustomEvent(projectInitializationRunRequestedEvent, {
      detail: projectId,
    })
  )
}

export function subscribeProjectInitializationRunRequested(
  callback: (projectId: string) => void
) {
  const handleRequest = (event: Event) =>
    callback((event as CustomEvent<string>).detail)
  window.addEventListener(projectInitializationRunRequestedEvent, handleRequest)
  return () =>
    window.removeEventListener(
      projectInitializationRunRequestedEvent,
      handleRequest
    )
}
