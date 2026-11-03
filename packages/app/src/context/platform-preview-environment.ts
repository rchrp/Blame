import type {
  PreviewEnvironmentView,
  SetPreviewVariableInput,
} from "@blame/agent-runtime"

// The Variables tab of a story preview: the environment each service gets,
// with secrets masked, and the variables people set for a story or project.
export type PreviewEnvironmentClient = {
  describe(input: {
    worktree: string
    databaseMode?: "compose" | "existing" | null
  }): Promise<PreviewEnvironmentView>
  set(input: SetPreviewVariableInput): Promise<boolean>
  dismissRequest(input: { worktree: string; key: string }): Promise<boolean>
}
