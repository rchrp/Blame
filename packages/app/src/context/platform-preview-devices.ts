export type PreviewDeviceScope = { storyId: string; projectId: string; title?: string; worktree: string; targetId: string; workspaceMode?: "direct" | "local-container" | "cloud-mirror" }
export type PreviewDevicePrerequisite = { id: string; title: string; status: "done" | "missing" | "checking" | "blocked"; detail?: string; action?: { type: "open-terminal"; command: string } | { type: "open-url"; url: string } | { type: "install"; label: string } }
export type PreviewDeviceAvailability = { status: "ready" } | { status: "missing-prerequisites"; prerequisites: PreviewDevicePrerequisite[] } | { status: "unavailable"; reason: string }
export type PreviewDeviceState = { status: string; message: string; step?: string; handle?: { platform: string; model: string; os: string; pointWidth: number; pointHeight: number; limited?: string }; logs: string[]; build?: { ok: boolean; summary?: string; errors?: Array<{ file?: string; line?: number; message: string }>; logTail?: string } }
export type PreviewDeviceActionResult = { status: string; message?: string; logs?: string[]; content?: Array<{ type: string; data: string }> }
export type PreviewDevicesClient = {
  availability(scope: PreviewDeviceScope): Promise<PreviewDeviceAvailability>
  state(scope: PreviewDeviceScope): Promise<PreviewDeviceState>
  start(scope: PreviewDeviceScope): Promise<PreviewDeviceState>
  action(scope: PreviewDeviceScope, args: Record<string, unknown>): Promise<PreviewDeviceActionResult>
  channel(scope: PreviewDeviceScope): Promise<{ url: string }>
  prerequisite(scope: PreviewDeviceScope, id: string): Promise<void>
  stop(input: { storyId: string; destroy?: boolean }): Promise<void>
}
