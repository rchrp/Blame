import {
  type DesktopUpdatesClient,
  type DesktopUpdateStatus,
  usePlatform,
} from "@/context/platform"
import {
  CapabilityRow,
  SettingsGroup,
  SettingsPanel,
  SettingsRow,
} from "./settings-layout"
import { useSystemNotificationsEnabled } from "@/lib/system-notifications"
import { RuntimeSettingsGroup } from "./runtime-settings-group"
import { BrowserDiagnosticsGroup } from "./browser-diagnostics-group"
import { Switch } from "@/components/ui/switch"
import * as React from "react"
import { cn } from "@/lib/utils"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  LoaderCircleIcon,
  MonitorDownIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

const fallbackStatus: DesktopUpdateStatus = {
  channel: "stable",
  currentVersion: "development",
  phase: "unsupported",
  reason: "Updates are available only in the desktop app.",
}

export function DesktopSettingsPanel() {
  const platform = usePlatform()
  const updates = useDesktopUpdates(platform.updates)

  return (
    <SettingsPanel>
      <DesktopUpdatesGroup platform={platform} updates={updates} />
      <RuntimeSettingsGroup />
      <BrowserDiagnosticsGroup />
      <DesktopIntegrationGroup platform={platform} />
    </SettingsPanel>
  )
}

function DesktopUpdatesGroup({
  platform,
  updates,
}: {
  platform: ReturnType<typeof usePlatform>
  updates: ReturnType<typeof useDesktopUpdates>
}) {
  return (
    <SettingsGroup
      title="Updates"
      description="Follow the desktop release state and install updates when ready."
    >
      <UpdateOverview status={updates.status} />
      <VersionGrid status={updates.status} />
      {updates.status.phase === "downloading" ? (
        <DownloadProgress progress={updates.status.progress ?? 0} />
      ) : null}
      <BetaChannelRow
        run={updates.run}
        status={updates.status}
        updates={platform.updates}
      />
      <UpdateActions
        status={updates.status}
        updates={platform.updates}
        run={updates.run}
      />
    </SettingsGroup>
  )
}

function DesktopIntegrationGroup({
  platform,
}: {
  platform: ReturnType<typeof usePlatform>
}) {
  const [notificationsEnabled, setNotificationsEnabled] =
    useSystemNotificationsEnabled()

  return (
    <SettingsGroup
      title="Desktop integration"
      description="Check which native features are available in this runtime."
    >
      <SettingsRow
        title="System notifications"
        description="Show desktop alerts when agents need attention or finish a response."
      >
        <Switch
          aria-label="Toggle system notifications"
          checked={notificationsEnabled}
          disabled={!platform.systemNotifications}
          onCheckedChange={setNotificationsEnabled}
        />
      </SettingsRow>
      <CapabilityRow label="Updates" enabled={!!platform.updates} />
      <CapabilityRow label="Workspace access" enabled={!!platform.workspace} />
      <CapabilityRow label="Terminal runner" enabled={!!platform.terminal} />
      <CapabilityRow
        label="System notifications"
        enabled={!!platform.systemNotifications}
      />
      <CapabilityRow
        label="Preview browser"
        enabled={!!platform.previewBrowser}
      />
    </SettingsGroup>
  )
}

function useDesktopUpdates(updates: DesktopUpdatesClient | undefined) {
  const [status, setStatus] =
    React.useState<DesktopUpdateStatus>(fallbackStatus)
  const run = useDesktopUpdateRunner(setStatus)

  useDesktopUpdateSubscription(updates, setStatus)

  return { run, status }
}

function useDesktopUpdateSubscription(
  updates: DesktopUpdatesClient | undefined,
  setStatus: React.Dispatch<React.SetStateAction<DesktopUpdateStatus>>
) {
  React.useEffect(() => {
    if (!updates) {
      setStatus(fallbackStatus)
      return undefined
    }

    let active = true
    void updates.getStatus().then((nextStatus) => {
      if (active) setStatus(nextStatus)
    })
    const unsubscribe = updates.onStatus(setStatus)

    return () => {
      active = false
      unsubscribe()
    }
  }, [setStatus, updates])
}

function useDesktopUpdateRunner(
  setStatus: React.Dispatch<React.SetStateAction<DesktopUpdateStatus>>
) {
  return React.useCallback(
    async (action: () => Promise<DesktopUpdateStatus>) => {
      try {
        setStatus(await action())
      } catch (error) {
        setStatus((current) => updateErrorStatus(current, error))
      }
    },
    [setStatus]
  )
}

function UpdateOverview({ status }: { status: DesktopUpdateStatus }) {
  const summary = updateSummary(status)

  return (
    <div className="flex flex-col gap-3 border-b py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <span className={cn("mt-0.5 text-muted-foreground", summary.iconClass)}>
          <UpdateStatusIcon status={status} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium">{summary.title}</div>
          <p className="mt-1 text-sm text-muted-foreground">
            {summary.description}
          </p>
        </div>
      </div>
      <UpdateBadge status={status} />
    </div>
  )
}

function UpdateStatusIcon({ status }: { status: DesktopUpdateStatus }) {
  const className = cn(
    "size-5",
    status.phase === "checking" && "animate-spin",
    status.phase === "downloading" && "animate-spin"
  )

  if (status.phase === "error") return <AlertCircleIcon className={className} />
  if (status.phase === "available")
    return <DownloadIcon className={className} />
  if (status.phase === "checking" || status.phase === "downloading") {
    return <LoaderCircleIcon className={className} />
  }
  if (status.phase === "downloaded" || status.phase === "not-available") {
    return <CheckCircle2Icon className={className} />
  }
  return <MonitorDownIcon className={className} />
}

function BetaChannelRow({
  run,
  status,
  updates,
}: {
  run: (action: () => Promise<DesktopUpdateStatus>) => Promise<void>
  status: DesktopUpdateStatus
  updates: DesktopUpdatesClient | undefined
}) {
  const busy = status.phase === "checking" || status.phase === "downloading"

  return (
    <SettingsRow
      title="Beta channel"
      description="Get prerelease versions before everyone else. When you turn it off, you keep this version until a newer stable release ships."
    >
      <Switch
        aria-label="Toggle the beta channel"
        checked={status.channel === "beta"}
        disabled={!updates || busy || status.phase === "unsupported"}
        onCheckedChange={(checked) =>
          updates &&
          void run(() => updates.setChannel(checked ? "beta" : "stable"))
        }
      />
    </SettingsRow>
  )
}

function VersionGrid({ status }: { status: DesktopUpdateStatus }) {
  return (
    <div className="grid gap-4 border-b py-4 sm:grid-cols-2">
      <VersionCell
        label="Current version"
        value={status.currentVersion}
        badge={
          isPrerelease(status.currentVersion) ? (
            <Badge variant="outline">Beta</Badge>
          ) : null
        }
      />
      <VersionCell
        label="Latest version"
        value={status.latestVersion ?? "Not checked"}
      />
    </div>
  )
}

function UpdateActions({
  run,
  status,
  updates,
}: {
  run: (action: () => Promise<DesktopUpdateStatus>) => Promise<void>
  status: DesktopUpdateStatus
  updates: DesktopUpdatesClient | undefined
}) {
  const busy = status.phase === "checking" || status.phase === "downloading"

  return (
    <div className="flex flex-wrap gap-2 py-4">
      <CheckUpdateButton
        busy={busy}
        run={run}
        status={status}
        updates={updates}
      />
      <DownloadUpdateButton run={run} status={status} updates={updates} />
      <InstallUpdateButton run={run} status={status} updates={updates} />
    </div>
  )
}

function CheckUpdateButton({
  busy,
  run,
  status,
  updates,
}: {
  busy: boolean
  run: (action: () => Promise<DesktopUpdateStatus>) => Promise<void>
  status: DesktopUpdateStatus
  updates: DesktopUpdatesClient | undefined
}) {
  return (
    <Button
      type="button"
      variant={status.phase === "idle" ? "default" : "outline"}
      disabled={!updates || busy}
      onClick={() => updates && void run(updates.check)}
    >
      <RefreshCwIcon />
      Check
    </Button>
  )
}

function DownloadUpdateButton({
  run,
  status,
  updates,
}: {
  run: (action: () => Promise<DesktopUpdateStatus>) => Promise<void>
  status: DesktopUpdateStatus
  updates: DesktopUpdatesClient | undefined
}) {
  if (status.phase !== "available" && status.phase !== "downloading")
    return null

  return (
    <Button
      type="button"
      disabled={!updates || status.phase !== "available"}
      onClick={() => updates && void run(updates.download)}
    >
      <DownloadIcon />
      Download
    </Button>
  )
}

function InstallUpdateButton({
  run,
  status,
  updates,
}: {
  run: (action: () => Promise<DesktopUpdateStatus>) => Promise<void>
  status: DesktopUpdateStatus
  updates: DesktopUpdatesClient | undefined
}) {
  if (status.phase !== "downloaded") return null

  return (
    <Button
      type="button"
      disabled={!updates}
      onClick={() => updates && void run(updates.install)}
    >
      <RotateCcwIcon />
      Restart and install
    </Button>
  )
}

function DownloadProgress({ progress }: { progress: number }) {
  const percent = Math.max(0, Math.min(100, progress))

  return (
    <div className="border-b py-4">
      <div className="flex justify-between text-sm">
        <span className="font-medium">Downloading update</span>
        <span className="text-muted-foreground">{Math.round(percent)}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function VersionCell({
  badge,
  label,
  value,
}: {
  badge?: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{value}</span>
        {badge}
      </div>
    </div>
  )
}

// Prerelease versions carry a suffix, such as 1.2.0-beta.1.
function isPrerelease(version: string) {
  return /^\d+\.\d+\.\d+-/.test(version)
}

function UpdateBadge({ status }: { status: DesktopUpdateStatus }) {
  if (status.phase === "available") return <Badge>Available</Badge>
  if (status.phase === "downloaded") return <Badge>Ready</Badge>
  if (status.phase === "error")
    return <Badge variant="destructive">Error</Badge>
  if (status.phase === "unsupported")
    return <Badge variant="outline">Unavailable</Badge>
  if (status.phase === "checking" || status.phase === "downloading")
    return <Badge variant="secondary">Working</Badge>
  if (status.phase === "not-available")
    return <Badge variant="secondary">Current</Badge>
  return <Badge variant="outline">Idle</Badge>
}

function updateSummary(status: DesktopUpdateStatus) {
  if (status.phase === "error") {
    return {
      description: status.error ?? "Unable to check for updates.",
      iconClass: "text-destructive",
      title: "Update check failed",
    }
  }

  if (status.phase === "unsupported") {
    return {
      description: status.reason ?? "Updates are unavailable for this build.",
      iconClass: "",
      title: "Updates unavailable",
    }
  }

  if (status.phase === "available") {
    return {
      description: "Download the update now or keep working on this version.",
      iconClass: "text-primary",
      title: `Version ${status.latestVersion} is available`,
    }
  }

  return runningUpdateSummary(status)
}

function runningUpdateSummary(status: DesktopUpdateStatus) {
  if (status.phase === "downloaded") {
    return {
      description: `Restart Blame to install version ${status.latestVersion}.`,
      iconClass: "text-emerald-500",
      title: "Update downloaded",
    }
  }

  if (status.phase === "downloading") {
    return {
      description: "The update package is downloading in the background.",
      iconClass: "text-primary",
      title: "Downloading update",
    }
  }

  if (status.phase === "checking") {
    return {
      description: "Blame is checking the latest desktop release.",
      iconClass: "text-primary",
      title: "Checking for updates",
    }
  }

  return idleUpdateSummary(status)
}

function idleUpdateSummary(status: DesktopUpdateStatus) {
  if (status.phase === "not-available") {
    return {
      description: "No newer desktop release is available.",
      iconClass: "text-emerald-500",
      title: "Blame is up to date",
    }
  }

  return {
    description: "Check manually when you want to look for a new release.",
    iconClass: "",
    title: "Manual updates",
  }
}

function updateErrorStatus(
  status: DesktopUpdateStatus,
  error: unknown
): DesktopUpdateStatus {
  return {
    ...status,
    error: error instanceof Error ? error.message : "Unable to update Blame.",
    phase: "error",
  }
}
