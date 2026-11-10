import type { DirectStoryFile } from "@blame/agent-runtime"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { AgentClient, WorkspaceClient } from "@/context/platform"

// Approving a Direct story commits its own files in the project folder, on the
// branch checked out there. The folder is shared with the person, other Direct
// stories, chats and Plan Mode: only the files the story wrote are committed,
// and the person decides about those that also hold someone else's changes.

// What the person decides for the files that also hold other changes: commit
// them with the story, leave them out, or stop.
export type SharedFilesChoice = "commit" | "leave-out" | "cancel"

export type DirectStoryCommitDependencies = {
  agent: Pick<AgentClient, "directStoryFiles">
  confirmSharedFiles(files: DirectStoryFile[]): Promise<SharedFilesChoice>
  generateMessage(paths: string[]): Promise<string>
  workspace: Pick<WorkspaceClient, "gitCommit" | "gitLog">
}

export type DirectStoryCommitResult =
  | { status: "cancelled" }
  | {
      status: "committed"
      // The commit before the story's, so the story's diff stays its own.
      baseCommit: string | null
      commit: string
      fileCount: number
      message: string
    }

export async function commitDirectStory(
  story: Pick<UserStory, "agentRuns" | "clineSessionId">,
  root: string,
  dependencies: DirectStoryCommitDependencies
): Promise<DirectStoryCommitResult> {
  const { files } = await dependencies.agent.directStoryFiles({
    root,
    sessionIds: storySessionIds(story),
  })
  if (files.length === 0) {
    throw new Error(
      "None of the story's changes are left in the project folder to commit: they were reverted, already committed or ignored by Git."
    )
  }
  const paths = await filesToCommit(files, dependencies)
  if (!paths.length) return { status: "cancelled" }
  const message = await dependencies.generateMessage(paths)
  await dependencies.workspace.gitCommit({ message, paths, root })
  const [head] = await dependencies.workspace.gitLog({
    currentBranchOnly: true,
    limit: 1,
    root,
  })
  if (!head) throw new Error("Git did not report the new commit.")
  return {
    status: "committed",
    baseCommit: head.parents[0] ?? null,
    commit: head.hash,
    fileCount: paths.length,
    message,
  }
}

export function directCommitValidationError(
  story: Pick<UserStory, "worktree">,
  authStatus: string,
  agent: Pick<AgentClient, "directStoryFiles" | "generateCommitMessage"> | undefined,
  workspace: Pick<WorkspaceClient, "gitCommit" | "gitLog"> | undefined,
  model: unknown
) {
  if (!story.worktree) return "This user story has no project folder."
  if (authStatus !== "authenticated")
    return "Reconnect the provider before approving the commit."
  if (!model) return "Select a model before approving the commit."
  if (!agent?.directStoryFiles || !agent.generateCommitMessage || !workspace)
    return "Desktop agent runtime is not available."
}

// The story's own files and text: with them, the runtime ends the message with
// a Closes #N line per GitHub issue of origin the story says it handles.
export function directCommitMessageRequest(
  story: Pick<UserStory, "summary" | "title">,
  root: string,
  paths: string[]
) {
  return {
    repositoryRoot: root,
    worktree: root,
    selectedPaths: paths,
    title: story.title,
    summary: story.summary,
    closeLinkedIssues: true,
  }
}

// Every agent session of the story: its runs, and the one it ends with.
export function storySessionIds(
  story: Pick<UserStory, "agentRuns" | "clineSessionId">
) {
  const ids = [
    ...(story.agentRuns ?? []).map((run) => run.clineSessionId),
    story.clineSessionId,
  ]
  return [...new Set(ids.filter((id): id is string => Boolean(id)))]
}

async function filesToCommit(
  files: DirectStoryFile[],
  dependencies: Pick<DirectStoryCommitDependencies, "confirmSharedFiles">
) {
  const own = files.filter((file) => !file.shared).map((file) => file.path)
  if (own.length === files.length) return own
  const choice = await dependencies.confirmSharedFiles(files)
  if (choice === "cancel") return []
  return choice === "commit" ? files.map((file) => file.path) : own
}
