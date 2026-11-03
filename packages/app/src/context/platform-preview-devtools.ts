// Per-project settings of the agent's browser tools.
export type PreviewDevtoolsSettingsClient = {
  getAdvancedDiagnostics(input: { projectId: string }): Promise<boolean>
  setAdvancedDiagnostics(input: {
    enabled: boolean
    projectId: string
  }): Promise<boolean>
}
