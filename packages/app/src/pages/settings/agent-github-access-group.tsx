import * as React from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { usePlatform } from "@/context/platform"
import type { AgentGithubAccessLevel } from "@/context/platform-agent-github-access"
import { useProjects } from "@/context/projects"

import { SettingsGroup, SettingsRow } from "./settings-layout"

const levelDescriptions: Record<AgentGithubAccessLevel, string> = {
  off: "The agent gets no GitHub credentials.",
  read: "The agent reads repositories, issues, pull requests and Actions runs through GitHub's MCP server, in read-only mode. Its commands get no GitHub token.",
  write:
    "The agent's commands get the token as GH_TOKEN, so the agent can use gh with all of your account's rights.",
}

function isLevel(value: string): value is AgentGithubAccessLevel {
  return value === "off" || value === "read" || value === "write"
}

// Lets the open project's agents use GitHub in Local Container stories with
// the person's own GitHub CLI sign-in. Off by default.
export function AgentGithubAccessGroup() {
  const settings = usePlatform().agentGithubAccess
  const project = useProjects().activeProject
  const projectId = project?.id
  const [level, setLevel] = React.useState<AgentGithubAccessLevel>("off")
  const [loadedFor, setLoadedFor] = React.useState<string>()
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

  return (
    <SettingsGroup
      title="Agent GitHub access"
      description="Credentials the agent can use in this project's Local Container stories."
    >
      <SettingsRow
        title="GitHub access for the agent"
        description={
          project
            ? `When a session starts in ${project.name}, Blame runs gh auth token on this computer and keeps the token in memory only, never in the worktree. ${levelDescriptions[shown]} Takes effect in new sessions.`
            : "Open a project to change this setting."
        }
      >
        <Select
          value={shown}
          disabled={!ready}
          onValueChange={(value) => {
            if (!settings || !projectId || !isLevel(value)) return
            const previous = level
            setLevel(value)
            void settings
              .setLevel({ level: value, projectId })
              .catch(() => setLevel(previous))
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
