import type { Platform } from "../../context/platform.ts"
import { turnPatch } from "./agent-run-diff-range.ts"
import { createCachedTaskQueue } from "./cached-task-queue.ts"
import {
  normalizeDiffs,
  parseGitDiff,
  type VcsFileDiff,
} from "../backlog/development/development-workspace.ts"

/** What one turn changed, file by file (see `turnPatch`). */
export async function loadAgentRunDiffs({
  from,
  platform,
  root,
  to,
}: {
  from: string
  platform: Platform
  root: string
  to: string | undefined
}): Promise<VcsFileDiff[]> {
  const workspace = platform.workspace
  if (!workspace) return []
  const load = async () =>
    normalizeDiffs(parseGitDiff(await turnPatch(workspace, { from, root, to })))
  // A finished range never changes; the files now do.
  return to ? enqueueAgentRunDiff([root, from, to].join("\0"), load) : load()
}

const enqueueAgentRunDiff = createCachedTaskQueue<VcsFileDiff[]>(1, 0)
