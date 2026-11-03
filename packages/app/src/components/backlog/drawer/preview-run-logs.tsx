import * as React from "react"

import {
  runLogItemStopped,
  type RunLogItem,
} from "@/components/backlog/board/run-log-items"
import {
  RunLogPanel,
  type RunLogEmpty,
} from "@/components/backlog/board/run-log-panel"
import {
  useManagedPreviewLog,
  useProjectServiceLog,
} from "@/components/backlog/drawer/preview-service-logs"
import type { ProjectRunPreview } from "@/components/backlog/drawer/user-story-preview"

// The logs of the project's own apps, run from the shared runner.
export function ProjectRunLogPanel({
  actions,
  logs,
  notice,
}: {
  actions: React.ReactNode
  logs: ProjectRunPreview["logs"]
  notice?: React.ReactNode
}) {
  return (
    <RunLogPanel
      actions={actions}
      empty={logs.empty}
      items={logs.items}
      notice={notice}
      output={logs.content}
      placeholder="No apps to run yet"
      value={logs.selected}
      onValueChange={logs.onSelect}
    />
  )
}

// The logs of a story preview's services, one tab each, running first.
export function ServiceLogPanel({
  actions,
  items,
  managed,
  managedError,
  previewSessionId,
  service,
  worktree,
  onServiceChange,
}: {
  actions: React.ReactNode
  items: RunLogItem[]
  managed: boolean
  managedError?: string
  previewSessionId?: string
  service: string
  worktree?: string | null
  onServiceChange: (service: string) => void
}) {
  const local = useProjectServiceLog(managed ? undefined : worktree, service)
  const managedLog = useManagedPreviewLog(previewSessionId, service)
  const runtimeLog = managed ? managedLog : local
  const error = managedError ?? runtimeLog.error
  const stopped = managed && !previewSessionId && !error
  const loading = managed
    ? Boolean(previewSessionId && runtimeLog.loading)
    : runtimeLog.loading
  return (
    <RunLogPanel
      actions={actions}
      empty={
        stopped
          ? {
              title: "Cloud preview stopped",
              description:
                "Start the selected run configuration to create it and see its logs.",
            }
          : serviceLogEmpty({
              error,
              loading,
              service,
              stopped: runLogItemStopped(
                items.find(({ id }) => id === service)
              ),
              services: items.length,
            })
      }
      items={items}
      output={stopped ? "" : runtimeLog.content}
      placeholder="Loading services"
      value={service}
      onValueChange={onServiceChange}
    />
  )
}

// Most precise first: a service known to be stopped has no logs to load.
export function serviceLogEmpty({
  error,
  loading,
  service,
  services,
  stopped,
}: {
  error?: string
  loading: boolean
  service: string
  services: number
  stopped: boolean
}): RunLogEmpty {
  if (error) return { title: "Couldn't read the logs", description: error }
  if (services === 0) return { title: "No services found yet" }
  if (stopped)
    return {
      title: "Service not started",
      description: `Start a run configuration that runs ${service} to see its logs.`,
    }
  if (loading) return { title: "Loading logs…" }
  return {
    title: "No logs yet",
    description: `${service} hasn't written anything yet.`,
  }
}
