import * as React from "react"
import { toast } from "sonner"

import { Switch } from "@/components/ui/switch"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"

import { SettingsGroup, SettingsRow } from "./settings-layout"

// Lets the open project's agents use gh in Local Container stories with the
// person's own GitHub CLI sign-in. Off by default: the token reaches every
// command the agent runs.
// Lets the open project's agents use GitHub. In Local Container stories they
// get the person's own GitHub CLI sign-in; in an account project's cloud
// sessions, a Blame GitHub App token limited to the linked repository, which
// the API only issues while its own agent-access option is on too. Off by
// default: the token reaches every command the agent runs.
export function AgentGithubAccessGroup() {
  const settings = usePlatform().agentGithubAccess
  const auth = useCloudAuth()
  const project = useProjects().activeProject
  const projectId = project?.id
  const accountProject =
    auth.status === "authenticated" && auth.mode === "account"
  const api = React.useMemo(
    () => createCloudApi(auth.apiConnection),
    [auth.apiConnection]
  )
  const [enabled, setEnabled] = React.useState(false)
  const [loadedFor, setLoadedFor] = React.useState<string>()
  const [saving, setSaving] = React.useState(false)
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

  const update = async (checked: boolean) => {
    if (!settings || !projectId) return
    setEnabled(checked)
    setSaving(true)
    try {
      await settings.setEnabled({ enabled: checked, projectId })
    } catch {
      setEnabled(!checked)
      setSaving(false)
      return
    }
    try {
      if (accountProject) await api.setGithubAgentAccess(projectId, checked)
    } catch (cause) {
      // Keeps both settings equal: cloud sessions need the two of them.
      await settings
        .setEnabled({ enabled: !checked, projectId })
        .catch(() => undefined)
      setEnabled(!checked)
      toast.error(
        cause instanceof Error && cause.message
          ? cause.message
          : "GitHub access could not be saved to your account."
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsGroup
      title="Agent GitHub access"
      description="Credentials the agent can use in this project's Local Container stories and cloud sessions."
    >
      <SettingsRow
        title="GitHub access for the agent"
        description={
          project
            ? agentGithubAccessDescription(project.name, accountProject)
            : "Open a project to change this setting."
        }
      >
        <Switch
          aria-label="Toggle GitHub access for the agent"
          checked={ready && enabled}
          disabled={!ready || saving}
          onCheckedChange={(checked) => void update(checked)}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

function agentGithubAccessDescription(
  projectName: string,
  accountProject: boolean
) {
  const local = `In Local Container sessions, Blame runs gh auth token on this computer and gives the token to the agent's commands in ${projectName} as GH_TOKEN, so the agent can use gh.`
  const cloud = accountProject
    ? " In cloud sessions, the agent gets a one-hour Blame GitHub App token limited to the repository linked above, never your personal gh token."
    : ""
  return `${local}${cloud} Tokens are kept in memory only, never written to the worktree. Takes effect in new sessions.`
}
