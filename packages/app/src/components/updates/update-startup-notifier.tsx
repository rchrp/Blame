import * as React from "react"
import { toast } from "sonner"

import { openSettings } from "@/pages/settings/settings-section"
import { usePlatform } from "@/context/platform"

export function UpdateStartupNotifier() {
  const platform = usePlatform()
  const notifiedVersionRef = React.useRef<string | undefined>(undefined)

  React.useEffect(() => {
    const updates = platform.updates
    if (!updates) return

    return updates.onStatus((status) => {
      if (status.phase !== "available") return
      if (!status.latestVersion) return
      if (notifiedVersionRef.current === status.latestVersion) return

      notifiedVersionRef.current = status.latestVersion
      toast.info("Update available", {
        description: `Version ${status.latestVersion} is ready to download.`,
        action: {
          label: "Open Settings",
          onClick: () => openSettings("desktop"),
        },
      })
    })
  }, [platform.updates])

  return null
}
