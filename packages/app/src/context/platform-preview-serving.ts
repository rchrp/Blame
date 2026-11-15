// Per-project choice of what a story in review serves: a production build
// of the app (the default, lighter) or its development server.
export type PreviewServingSettingsClient = {
  getReviewBuilds(input: { projectPath: string }): Promise<boolean>
  setReviewBuilds(input: {
    enabled: boolean
    projectPath: string
  }): Promise<boolean>
}
