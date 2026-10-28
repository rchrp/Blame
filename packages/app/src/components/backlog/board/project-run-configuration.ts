import { isHostWindowConfiguration } from "../drawer/surfaces/host-window-kind.ts"
import type { ProjectRunConfiguration } from "@blame/agent-runtime"

import { runnerPreviewDevtoolsScope } from "../shared/preview-devtools-scope.ts"

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
      (configuration) => configuration.default && hasPreview(configuration)
    ) ?? configurations.find(hasPreview) ?? configurations.find((c) => c.default && isHostWindowConfiguration(c)) ?? configurations.find(isHostWindowConfiguration)
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

function hasPreview(configuration: ProjectRunConfiguration) {
  return Boolean(
    projectRunConfigurationPreviewUrl(configuration) ||
    configuration.previewService || configuration.previewTarget
  )
}
