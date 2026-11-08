// Per-project GitHub access for the agent in Local Container sessions, with
// the host's `gh auth token`: read only through GitHub's MCP server, or read
// and write with the token given to the agent's commands as GH_TOKEN.
export type AgentGithubAccessLevel = "off" | "read" | "write"

export type AgentGithubAccessClient = {
  getLevel(input: { projectId: string }): Promise<AgentGithubAccessLevel>
  setLevel(input: {
    level: AgentGithubAccessLevel
    projectId: string
  }): Promise<AgentGithubAccessLevel>
}
