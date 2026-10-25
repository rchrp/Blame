import { SpeechToTextProvider } from "@/components/backlog/drawer/speech-to-text-provider"
import { MotionConfig } from "motion/react"
import { StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"

import "./index.css"
import App from "./App"
import { ThemeProvider } from "@/components/providers/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { DesktopUpdatesProvider } from "@/components/updates/desktop-updates-provider"
import { UpdateNotifications } from "@/components/updates/update-notifications"
import { RuntimeInstallDialog } from "@/components/runtime/runtime-install-dialog"
import { BlameRuntimeProvider } from "@/context/blame-runtime"
import { CloudAuthProvider } from "@/context/cloud-auth-provider"
import type { Platform } from "@/context/platform"
import { PlatformProvider } from "@/context/platform-provider"
import { ProjectProvider } from "@/context/project-provider"
import { ServerProvider } from "@/context/server-provider"
import { installPerformanceDiagnostics } from "@/lib/performance-diagnostics"
import { PerformanceDiagnosticsProfiler } from "@/lib/performance-diagnostics-profiler"

export { App }
export type {
  AppTheme,
  AppearanceClient,
  BacklogStatusPipRequest,
  BacklogStatusPipSnapshot,
  CloudMcpServerConfig,
  DeployClient,
  DeployProgress,
  GitBranchStatus,
  GitCommandResult,
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

function secondaryWindow() {
  return new URLSearchParams(window.location.search).get("view") !== null
}

export function mountApp(element: HTMLElement, options?: MountAppOptions) {
  installPerformanceDiagnostics()
  const root = createRoot(element)
  root.render(
    <StrictMode>
      <PlatformProvider value={options?.platform}>
        <CloudAuthProvider>
          <ServerProvider>
            <ProjectProvider>
              <ThemeProvider>
                {/* Every animation follows the system "reduce motion" setting. */}
                <MotionConfig reducedMotion="user">
                  <PerformanceDiagnosticsProfiler id="app">
                    <SpeechToTextProvider>
                      <BlameRuntimeProvider enabled={!secondaryWindow()}>
                        <DesktopUpdatesProvider enabled={!secondaryWindow()}>
                          <App />
                          <RuntimeInstallDialog />
                          <Toaster />
                          <UpdateNotifications />
                        </DesktopUpdatesProvider>
                      </BlameRuntimeProvider>
                    </SpeechToTextProvider>
                  </PerformanceDiagnosticsProfiler>
                </MotionConfig>
              </ThemeProvider>
            </ProjectProvider>
          </ServerProvider>
        </CloudAuthProvider>
      </PlatformProvider>
    </StrictMode>
  )
  return root
}

export type { Root }
