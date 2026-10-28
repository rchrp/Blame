import * as React from "react"

import { usePlatform } from "@/context/platform"

export function useProjectMenuActions({
  onNewProject,
  onOpenProject,
}: {
  onNewProject(): void
  onOpenProject(): void
}) {
  const { projectWindows } = usePlatform()
  const handleAction = React.useEffectEvent((action: "new" | "open") => {
    if (action === "new") onNewProject()
    else onOpenProject()
  })

  React.useEffect(
    () => projectWindows?.onMenuAction?.(handleAction),
    [projectWindows],
  )
}
