// Per-project GitHub access for the agent: the host's `gh auth token`, given
// to the agent's commands as GH_TOKEN in Local Container sessions.
export type AgentGithubAccessClient = {
  getEnabled(input: { projectId: string }): Promise<boolean>
  setEnabled(input: { enabled: boolean; projectId: string }): Promise<boolean>
}
