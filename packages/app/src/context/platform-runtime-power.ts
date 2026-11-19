// What the desktop reports while it installs, updates or starts the Blame
// Runtime.
export type RuntimeProgress = {
  completedBytes?: number
  percent?: number
  phase:
    | "checking"
    | "configuring"
    | "downloading"
    | "installing"
    | "starting"
    | "verifying"
  totalBytes?: number
}

// The desktop starts the Blame Runtime when something needs it and stops it
// once unused; every window hears each change.
export type RuntimePowerEvent = {
  // Why a start failed.
  error?: string
  progress?: RuntimeProgress
  state: "starting" | "running" | "stopping" | "stopped"
}
