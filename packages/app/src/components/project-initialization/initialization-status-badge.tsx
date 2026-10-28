import { Badge } from "@/components/ui/badge"
import type { CloudProjectInitialization } from "@/context/cloud-auth"
import { cn } from "@/lib/utils"
import type { ProjectInitializationAvailability } from "./project-initialization-availability"

export function InitializationStatusBadge({
  availability,
  initialization,
}: {
  availability: ProjectInitializationAvailability
  initialization?: CloudProjectInitialization
}) {
  const status = environmentStatus(availability, initialization)

  return (
    <Badge
      variant={status.failed ? "destructive" : "secondary"}
      className={cn("h-4 px-1.5 text-[10px] leading-none", status.color)}
      role="status"
      aria-label={`Preview environment: ${status.description}`}
      title={status.description}
    >
      {status.label}
    </Badge>
  )
}

function environmentStatus(
  availability: ProjectInitializationAvailability,
  initialization?: CloudProjectInitialization
): { label: string; description: string; color?: string; failed?: boolean } {
  if (availability === "running")
    return {
      label: "Analyzing",
      description: "Analyzing the project",
      color: "bg-blue-500/15 text-blue-800 dark:text-blue-300",
    }
  if (availability === "ready" && initialization) {
    const risks = initialization.previewManifest?.risks?.length ?? 0
    return {
      label: "Ready",
      description: risks
        ? risks === 1
          ? "Ready, with one point to check"
          : `Ready, with ${risks} points to check`
        : "Ready",
      color: risks
        ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
        : "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
    }
  }
  if (initialization?.status === "error")
    return {
      label: "Failed",
      description: "The last analysis failed",
      failed: true,
      color:
        "bg-rose-500/15 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
    }
  if (initialization?.status === "running")
    return {
      label: "Interrupted",
      description: "The last analysis stopped before it finished",
      color: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
    }
  return {
    label: "Not analyzed",
    description: "This project has not been analyzed yet",
  }
}
