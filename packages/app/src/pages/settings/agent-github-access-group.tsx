import * as React from "react"

import { Switch } from "@/components/ui/switch"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"

import { SettingsGroup, SettingsRow } from "./settings-layout"

// Lets the open project's agents use gh in Local Container stories with the
// person's own GitHub CLI sign-in. Off by default: the token reaches every
// command the agent runs.
export function AgentGithubAccessGroup() {
  const settings = usePlatform().agentGithubAccess
  const project = useProjects().activeProject
  const projectId = project?.id
  const [enabled, setEnabled] = React.useState(false)
  const [loadedFor, setLoadedFor] = React.useState<string>()
  React.useEffect(() => {
    if (!settings || !projectId) return
    let active = true
    void settings
      .getEnabled({ projectId })
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
      title="Agent GitHub access"
      description="Credentials the agent can use in this project's Local Container stories."
    >
      <SettingsRow
        title="GitHub access for the agent"
        description={
          project
            ? `When a session starts, Blame runs gh auth token on this computer and gives the token to the agent's commands in ${project.name} as GH_TOKEN, so the agent can use gh. It is kept in memory only, never written to the worktree. Takes effect in new sessions.`
            : "Open a project to change this setting."
        }
      >
        <Switch
          aria-label="Toggle GitHub access for the agent"
          checked={ready && enabled}
          disabled={!ready}
          onCheckedChange={(checked) => {
            if (!settings || !projectId) return
            setEnabled(checked)
            void settings
              .setEnabled({ enabled: checked, projectId })
              .catch(() => setEnabled(!checked))
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}
