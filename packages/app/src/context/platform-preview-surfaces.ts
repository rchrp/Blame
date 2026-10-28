export type PreviewSurfaceScope = {
  storyId: string
  serviceId: string
  worktree?: string
  sessionId?: string
}
export type PreviewTerminalState = {
  status: string
  message: string
  exitCode?: number
  text?: string
}
export type PreviewTerminalClient = {
  attach(
    scope: PreviewSurfaceScope
  ): Promise<PreviewTerminalState & { id: string; replay: string }>
  detach(id: string): Promise<void>
  write(input: { id: string; data: string }): Promise<boolean>
  resize(input: { id: string; cols: number; rows: number }): Promise<boolean>
  restart(id: string): Promise<void>
  read(id: string): Promise<PreviewTerminalState>
  onEvent(
    id: string,
    callback: (event: { type: "stdout" | "state"; data: string }) => void
  ): () => void
}
export type PreviewSurfacesClient = {
  enabled(): Promise<string[]>
  open(scope: PreviewSurfaceScope): Promise<{ url: string }>
  action(
    scope: PreviewSurfaceScope,
    args: Record<string, unknown>
  ): Promise<{
    status: string
    message?: string
    content?: Array<{ type: string; data: string }>
  }>
}
