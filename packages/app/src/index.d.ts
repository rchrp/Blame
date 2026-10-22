import type { Root } from "react-dom/client"
import type { ComponentType } from "react"
import type { Platform } from "./context/platform"

export declare const App: ComponentType
export type {
  AgentScreenshotData,
  AgentScreenshotMetadata,
  AgentScreenshotsClient,
  BacklogStatusPipRequest,
  BacklogStatusPipSnapshot,
  CloudAuthRequestClient,
  CloudAuthRequestInput,
  CloudAuthRequestResponse,
  CloudMcpServerConfig,
  DeployClient,
  DeployProgress,
  GitBranchStatus,
  GitCommandResult,
  GitConflictFile,
  GitLogCommit,
  GitLogCommitRef,
  GitStatusFile,
  GitStatusResult,
  McpServerConfig,
  McpServersClient,
  Platform,
  RuntimeDiagnosticInput,
  RuntimeProgress,
  SecurityAuditClient,
  TelemetryExportSession,
} from "./context/platform"

export type MountAppOptions = {
  platform?: Platform
}

export declare function mountApp(
  element: HTMLElement,
  options?: MountAppOptions
): Root
