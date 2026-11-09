import * as React from "react"
import { toast } from "sonner"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import type { AgentGithubAccessLevel } from "@/context/platform-agent-github-access"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"

import { SettingsGroup, SettingsRow } from "./settings-layout"

const localLevelDescriptions: Record<AgentGithubAccessLevel, string> = {
  off: "The agent gets no GitHub credentials.",
  read: "The agent reads repositories, issues, pull requests and Actions runs through GitHub's MCP server, in read-only mode. Its commands get no GitHub token.",
  write:
    "The agent's commands get the token as GH_TOKEN, so the agent can use gh with all of your account's rights.",
}

const cloudLevelDescriptions: Record<AgentGithubAccessLevel, string> = {
  off: "",
  read: " In cloud sessions, the agent's commands get a one-hour Blame GitHub App token limited to the repository linked above, never your personal gh token. GitHub only lets it read the code, issues, pull requests, checks and Actions runs.",
  write:
    " In cloud sessions, the agent's commands get a one-hour Blame GitHub App token limited to the repository linked above, never your personal gh token. It can read the code and write issues, pull requests and checks, but not push code.",
}

function isLevel(value: string): value is AgentGithubAccessLevel {
  return value === "off" || value === "read" || value === "write"
}

// Lets the open project's agents use GitHub. In Local Container stories they
// get the person's own GitHub CLI sign-in, at the chosen level; in an account
// project's cloud sessions, a Blame GitHub App token limited to the linked
// repository, which the API only issues while its own agent-access option is
// on too. Off by default.
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
  const [level, setLevel] = React.useState<AgentGithubAccessLevel>("off")
  const [loadedFor, setLoadedFor] = React.useState<string>()
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => {
    if (!settings || !projectId) return
    let active = true
    void settings
      .getLevel({ projectId })
      .then((value) => {
        if (!active) return
        setLevel(value)
        setLoadedFor(projectId)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [projectId, settings])
  const ready = Boolean(settings && projectId && loadedFor === projectId)
  const shown = ready ? level : "off"

  const update = async (next: AgentGithubAccessLevel) => {
    if (!settings || !projectId) return
    const previous = level
    setLevel(next)
    setSaving(true)
    try {
      await settings.setLevel({ level: next, projectId })
    } catch {
      setLevel(previous)
      setSaving(false)
      return
    }
    try {
      if (accountProject)
        await api.setGithubAgentAccess(projectId, next !== "off")
    } catch (cause) {
      // Keeps both settings equal: cloud sessions need the two of them.
      await settings
        .setLevel({ level: previous, projectId })
        .catch(() => undefined)
      setLevel(previous)
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
            ? agentGithubAccessDescription(project.name, shown, accountProject)
            : "Open a project to change this setting."
        }
      >
        <Select
          value={shown}
          disabled={!ready || saving}
          onValueChange={(value) => {
            if (isLevel(value)) void update(value)
          }}
        >
          <SelectTrigger
            className="w-40"
            aria-label="GitHub access for the agent"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="read">Read only</SelectItem>
            <SelectItem value="write">Read and write</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsGroup>
  )
}

function agentGithubAccessDescription(
  projectName: string,
  level: AgentGithubAccessLevel,
  accountProject: boolean
) {
  const local = `In Local Container sessions in ${projectName}, Blame runs gh auth token on this computer and keeps the token in memory only, never in the worktree. ${localLevelDescriptions[level]}`
  const cloud = accountProject ? cloudLevelDescriptions[level] : ""
  return `${local}${cloud} Takes effect in new sessions.`
}
