import type { ProjectRunConfiguration } from "@blame/agent-runtime"

import { runnerPreviewDevtoolsScope } from "@/components/backlog/shared/preview-devtools-scope"

export function projectRunConfigurationPreviewUrl(
  configuration?: ProjectRunConfiguration
) {
  const previewUrl = configuration?.previewUrl?.trim()
  return previewUrl || undefined
}

export function projectPreviewConfiguration(
  configurations: ProjectRunConfiguration[]
) {
  return (
    configurations.find(
      (configuration) =>
        configuration.default &&
        projectRunConfigurationPreviewUrl(configuration)
    ) ?? configurations.find(projectRunConfigurationPreviewUrl)
  )
}

// What an agent working in the project folder inspects with its browser
// tools: the project's own app, the page Blame's runner keeps open.
export function directStoryPreviewScope(
  configurations: ProjectRunConfiguration[] | undefined,
  projectPath: string | undefined
) {
  const configuration = projectPreviewConfiguration(configurations ?? [])
  if (!configuration || !projectPath) return undefined
  return projectRunConfigurationPreviewKey(configuration, projectPath)
}

export function projectRunConfigurationPreviewKey(
  configuration?: ProjectRunConfiguration,
  scope = "project"
) {
  return runnerPreviewDevtoolsScope(configuration, scope)
}
