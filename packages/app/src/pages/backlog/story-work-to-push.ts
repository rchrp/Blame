import { changedFilesFromDiff } from "../../components/backlog/data/user-story-context.ts"

type PullRequestStory = {
  branch?: string | null
  pullRequestUrl?: string | null
  worktree?: string | null
}

type PullRequestWorkspace = {
  gitDiff(input: { root: string }): Promise<string>
  gitLog(input: {
    root: string
    limit: number
    currentBranchOnly?: boolean
  }): Promise<Array<{ refs: Array<{ name: string; type: string }> }>>
}

// Open PR pushes the story branch to origin and git moves origin/<branch>
// with it. Work is waiting for the pull request when HEAD is not where that
// branch stands, or when files changed since HEAD (Open PR commits those).
export async function storyWorkToPush(
  story: PullRequestStory,
  workspace: PullRequestWorkspace
) {
  const { branch, pullRequestUrl, worktree } = story
  if (!pullRequestUrl || !branch || !worktree) return false
  try {
    const [head] = await workspace.gitLog({
      root: worktree,
      limit: 1,
      currentBranchOnly: true,
    })
    if (!head) return false
    if (!head.refs.some((ref) => ref.name === `origin/${branch}`)) return true
    return (
      changedFilesFromDiff(await workspace.gitDiff({ root: worktree })).length >
      0
    )
  } catch {
    return false
  }
}
