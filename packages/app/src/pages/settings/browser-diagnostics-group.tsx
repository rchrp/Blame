import * as React from "react"

import { Switch } from "@/components/ui/switch"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"

import { SettingsGroup, SettingsRow } from "./settings-layout"

// The agent's browser tools for the open project. The default set covers
// inspecting and driving the preview; diagnostics are opt-in because their
// schemas travel with every request.
export function BrowserDiagnosticsGroup() {
  const settings = usePlatform().previewDevtools
  const project = useProjects().activeProject
  const projectId = project?.id
  const [enabled, setEnabled] = React.useState(false)
  const [loadedFor, setLoadedFor] = React.useState<string>()
  React.useEffect(() => {
    if (!settings || !projectId) return
    let active = true
    void settings
      .getAdvancedDiagnostics({ projectId })
      .then((value) => {
        if (!active) return
        setEnabled(value)
        setLoadedFor(projectId)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [projectId, settings])
  const ready = Boolean(settings && projectId && loadedFor === projectId)

  return (
    <SettingsGroup
      title="Agent browser"
      description="Tools the agent uses to inspect and drive the story's preview."
    >
      <SettingsRow
        title="Advanced browser diagnostics"
        description={
          project
            ? `Performance traces, Lighthouse audits, memory snapshots and third-party developer tools for agents in ${project.name}. Takes effect in new sessions.`
            : "Open a project to change this setting."
        }
      >
        <Switch
          aria-label="Toggle advanced browser diagnostics"
          checked={ready && enabled}
          disabled={!ready}
          onCheckedChange={(checked) => {
            if (!settings || !projectId) return
            setEnabled(checked)
            void settings
              .setAdvancedDiagnostics({ enabled: checked, projectId })
              .catch(() => setEnabled(!checked))
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}
