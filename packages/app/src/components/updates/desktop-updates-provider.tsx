import * as React from "react"

import { usePlatform } from "@/context/platform"
import { createDesktopUpdateStore } from "./desktop-update-store"

const DesktopUpdatesContext = React.createContext<
  ReturnType<typeof createDesktopUpdateStore> | undefined
>(undefined)

export function DesktopUpdatesProvider({
  children,
  enabled = true,
}: {
  children: React.ReactNode
  enabled?: boolean
}) {
  const { updates } = usePlatform()
  const client = enabled ? updates : undefined
  const store = React.useMemo(() => createDesktopUpdateStore(client), [client])
  React.useEffect(() => store.connect(), [store])

  return (
    <DesktopUpdatesContext.Provider value={store}>
      {children}
    </DesktopUpdatesContext.Provider>
  )
}

export function useDesktopUpdates() {
  const store = React.useContext(DesktopUpdatesContext)
  if (!store) throw new Error("DesktopUpdatesProvider is missing")
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  return {
    ...state,
    download: store.download,
    restart: store.restart,
    retry: store.retry,
  }
}
