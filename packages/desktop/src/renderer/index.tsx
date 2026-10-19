import { mountApp } from "@blame/app"
import "./styles.css"

document.documentElement.dataset.blameDesktop = "true"

const root = document.getElementById("root")
if (!(root instanceof HTMLElement)) throw new Error("Root element not found")

mountApp(root, {
  platform: {
    auth: window.blame.auth,
    agent: window.blame.agent,
    billing: window.blame.billing,
    deploy: window.blame.deploy,
    mcp: window.blame.mcp,
    backlogStatusPip: window.blame.backlogStatusPip,
    platform: window.blame.platform,
    previewBrowser: window.blame.previewBrowser,
    previewRuntime: window.blame.previewRuntime,
    securityAudits: window.blame.securityAudits,
    systemNotifications: window.blame.systemNotifications,
    appStatus: window.blame.appStatus,
    telemetry: window.blame.telemetry,
    terminal: window.blame.terminal,
    updates: window.blame.updates,
    workspace: window.blame.workspace,
    windowControls: window.blame.windowControls,
    openDirectoryPickerDialog: (options) => window.blame.openDirectoryPicker(options),
    openExternalLink: (url) => window.blame.openExternalLink(url),
    requestMicrophoneAccess: () => window.blame.requestMicrophoneAccess(),
    openPath: (path) => window.blame.openPath(path),
  },
})
