export type { PreviewDevicesClient } from "./context/platform-preview-devices"
import type { Root } from "react-dom/client"
import type { ComponentType } from "react"
import type { Platform } from "./context/platform"
export type { LocalApiClient } from "./context/platform-local-api"
export type { PreviewEnvironmentClient } from "./context/platform-preview-environment"
export type { PreviewServingSettingsClient } from "./context/platform-preview-serving"
export type { AgentGithubAccessClient } from "./context/platform-agent-github-access"
export type { RunLogsClient } from "./context/platform-run-logs"
export type {
  PreviewTerminalClient,
  PreviewSurfacesClient,
} from "./context/platform-preview-surfaces"

export declare const App: ComponentType
export type {
  AppTheme,
  AppearanceClient,
  AgentScreenshotData,
  AgentScreenshotMetadata,
  AgentScreenshotsClient,
  BacklogStatusPipRequest,
  BacklogStatusPipSnapshot,
  CloudAuthRequestClient,
  CloudAuthRequestInput,
  CloudAuthRequestResponse,
  CloudMcpServerConfig,
  McpLocalParts,
  McpSecretValues,
  McpSyncMode,
  DeployClient,
  DeployProgress,
  GitBranchStatus,
  GitCommandResult,
  GitConflictFile,
  GitLogCommit,
  GitLogCommitRef,
  GitStatusFile,
  GitStatusResult,
  IssueReport,
  McpServerConfig,
  McpServersClient,
  Platform,
  RuntimePowerEvent,
  RuntimeProgress,
  SecurityAuditClient,
} from "./context/platform"

export type MountAppOptions = {
  platform?: Platform
}

export declare function mountApp(
  element: HTMLElement,
  options?: MountAppOptions
): Root
