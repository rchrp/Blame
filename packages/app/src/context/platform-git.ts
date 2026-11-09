export type GitBranchList = {
  // Null when the folder is on a detached HEAD.
  current: string | null
  local: string[]
  // Remote branches with no local branch yet, such as "origin/feature".
  remote: string[]
}

export type GitBranchStatus = {
  ahead: number
  behind: number
  current: string
  detached: boolean
  upstream?: string
}

export type GitStatusFile = {
  conflicted?: boolean
  indexStatus: string
  originalPath?: string
  path: string
  staged: boolean
  status: string
  untracked: boolean
  unstaged: boolean
  worktreeStatus: string
}

export type GitStatusResult = {
  branch: GitBranchStatus
  files: GitStatusFile[]
  remote?: string
}

export type GitLogCommitRef = {
  name: string
  type: "branch" | "head" | "remote" | "tag" | "other"
}

export type GitLogCommit = {
  authorEmail: string
  authorName: string
  date: string
  hash: string
  message: string
  parents: string[]
  refs: GitLogCommitRef[]
}

export type GitCommandResult = {
  output: string
}

export type GitConflictFile = {
  base: string
  current: string
  incoming: string
  path: string
  result: string
}
