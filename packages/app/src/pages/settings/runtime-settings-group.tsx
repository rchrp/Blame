import { LoaderCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useBlameRuntime } from "@/context/blame-runtime"
import {
  runtimeBusy,
  runtimePhaseLabel,
  runtimeProgressText,
} from "@/lib/blame-runtime-state"
import { cn } from "@/lib/utils"
import { SettingsGroup, SettingsRow } from "./settings-layout"

// Where to find the Blame Runtime after onboarding: its state, and the
// rarely needed repair and reset actions that used to live in popups.
export function RuntimeSettingsGroup() {
  const runtime = useBlameRuntime()
  if (runtime.phase === "unavailable") return null
  const busy = runtimeBusy(runtime.phase)
  const ready = runtime.phase === "ready"

  return (
    <SettingsGroup
      title="Blame Runtime"
      description="Runs Local Container stories and their previews in an isolated sandbox on this computer. Updates install on their own once no local story is running."
    >
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "size-2 rounded-full",
                ready
                  ? "bg-emerald-500"
                  : busy || runtime.phase === "checking" || runtime.phase === "update-pending"
                    ? "bg-amber-500"
                    : "bg-destructive"
              )}
            />
            {busy ? runtimeProgressText(runtime.progress) : runtimePhaseLabel(runtime.phase)}
          </span>
        }
        description={runtime.report?.runtime ?? "Blame Runtime"}
      >
        {busy ? <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" /> : null}
        {!busy && runtime.phase === "missing" && runtime.canInstall ? (
          <Button type="button" onClick={() => void runtime.install()}>
            Install
          </Button>
        ) : null}
        {!busy && runtime.phase === "needs-repair" ? (
          <Button type="button" onClick={() => runtime.promptInstall()}>
            Repair
          </Button>
        ) : null}
        {!busy && (ready || runtime.phase === "unsupported") ? (
          <Button type="button" variant="outline" onClick={() => void runtime.refresh()}>
            Check again
          </Button>
        ) : null}
      </SettingsRow>
      {runtime.canInstall && (ready || runtime.phase === "needs-repair") ? (
        <SettingsRow
          title="Start over"
          description="Deletes the sandbox and installs a fresh one. Your projects are not touched; running local previews stop."
        >
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Reinstall Blame Runtime from scratch?")) void runtime.reset()
            }}
          >
            Reset
          </Button>
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  )
}
