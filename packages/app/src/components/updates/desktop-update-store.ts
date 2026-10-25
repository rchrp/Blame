import type {
  DesktopUpdatesClient,
  DesktopUpdateStatus,
} from "@/context/platform"

type UpdateAction = "download" | "restart"

export type DesktopUpdateState = {
  status: DesktopUpdateStatus
  pending?: UpdateAction
  failure?: { action: UpdateAction; message: string }
}

const unsupportedStatus: DesktopUpdateStatus = {
  channel: "stable",
  currentVersion: "development",
  phase: "unsupported",
}

// Both entry points use one subscription and one in-flight action. Electron
// remains authoritative, including downloads started from Settings or another window.
export function createDesktopUpdateStore(client?: DesktopUpdatesClient) {
  let state: DesktopUpdateState = { status: unsupportedStatus }
  let revision = 0
  let running: Promise<void> | undefined
  const listeners = new Set<() => void>()

  function publish(next: DesktopUpdateState) {
    state = next
    listeners.forEach((listener) => listener())
  }

  function receive(status: DesktopUpdateStatus) {
    revision += 1
    const updating =
      state.pending ||
      state.failure ||
      state.status.phase === "downloading" ||
      state.status.phase === "downloaded"
    const failed = status.phase === "error" && updating
    publish({
      ...state,
      status,
      pending: failed ? undefined : state.pending,
      failure: failed
        ? {
            // Native errors invalidate the prepared update. Fetch it again;
            // only an IPC/shutdown rejection can retry the restart directly.
            action: "download",
            message: status.error ?? "Unable to update Blame.",
          }
        : undefined,
    })
  }

  async function request(action: () => Promise<DesktopUpdateStatus>) {
    const startedAt = revision
    const next = await action()
    // An event can arrive before an older IPC response. Never roll it back.
    if (revision === startedAt) receive(next)
    return state.status
  }

  function run(action: UpdateAction): Promise<void> {
    if (!client || state.pending || running) return running ?? Promise.resolve()
    if (action === "restart" && state.status.phase !== "downloaded")
      return Promise.resolve()
    if (
      action === "download" &&
      (state.status.phase === "downloading" ||
        state.status.phase === "downloaded")
    )
      return Promise.resolve()

    publish({ ...state, pending: action, failure: undefined })
    running = Promise.resolve().then(async () => {
      try {
        if (action === "restart") {
          await request(() => client.install())
        } else {
          if (state.status.phase !== "available")
            await request(() => client.check())
          if (state.status.phase === "available")
            await request(() => client.download())
        }
        if (state.status.phase === "error")
          throw new Error(state.status.error ?? "Unable to update Blame.")
      } catch (error) {
        publish({
          ...state,
          pending: undefined,
          failure: state.failure ?? {
            action,
            message:
              error instanceof Error
                ? error.message
                : "Unable to update Blame.",
          },
        })
      } finally {
        running = undefined
        // A successful restart stays busy until Electron closes the window.
        if (action === "download") publish({ ...state, pending: undefined })
      }
    })
    return running
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    connect() {
      if (!client) return () => {}
      let active = true
      const startedAt = revision
      const unsubscribe = client.onStatus((next) => {
        if (active) receive(next)
      })
      void client.getStatus().then(
        (next) => {
          if (active && revision === startedAt) receive(next)
        },
        () => {
          /* The next status event can recover a failed initial read. */
        }
      )
      return () => {
        active = false
        unsubscribe()
      }
    },
    download: () => run("download"),
    restart: () => run("restart"),
    retry: () => run(state.failure?.action ?? "download"),
  }
}
