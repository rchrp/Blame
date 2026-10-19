import type { Platform } from "../../context/platform.ts"
import { loadAgentRunPatch } from "./agent-run-diff-range.ts"
import { createCachedTaskQueue } from "./cached-task-queue.ts"
import {
  normalizeDiffs,
  parseGitDiff,
  type VcsFileDiff,
} from "../backlog/development/development-workspace.ts"

export async function captureAgentRunDiffEndRef({
  id,
  platform,
  root,
}: {
  id: string
  platform: Platform
  root?: string | null
}) {
  if (!root || !platform.workspace) return undefined
  try {
    return await platform.workspace.gitSnapshot({ id, root })
  } catch {
    return undefined
  }
}

export async function loadAgentRunDiffs({
  checkpointRunCount,
  diffEndRef,
  platform,
  root,
  sessionId,
}: {
  checkpointRunCount: number
  diffEndRef: string
  platform: Platform
  root: string
  sessionId: string
}): Promise<VcsFileDiff[]> {
  return enqueueAgentRunDiff(
    agentRunDiffKey({
      checkpointRunCount,
      diffEndRef,
      root,
      sessionId,
    }),
    () =>
      loadAgentRunDiff({
        checkpointRunCount,
        diffEndRef,
        platform,
        root,
        sessionId,
      })
  )
}

function agentRunDiffKey({
  checkpointRunCount,
  diffEndRef,
  root,
  sessionId,
}: Pick<
  Parameters<typeof loadAgentRunDiffs>[0],
  | "checkpointRunCount"
  | "diffEndRef"
  | "root"
  | "sessionId"
>) {
  return [
    root,
    checkpointRunCount,
    diffEndRef,
    sessionId,
  ].join("\0")
}

async function loadAgentRunDiff({
  checkpointRunCount,
  diffEndRef,
  platform,
  root,
  sessionId,
}: Parameters<typeof loadAgentRunDiffs>[0]) {
  const agent = platform.agent
  const workspace = platform.workspace
  if (!agent || !workspace) return []

  const patch = await loadAgentRunPatch({
    compareCheckpoint: async (boundary) =>
      (
        await agent.sessions.compareCheckpoint({
          checkpointRunCount: boundary.checkpointRunCount,
          cwd: root,
          sessionId: boundary.sessionId,
        })
      ).checkpoint.ref,
    diffBetween: (from, to) => workspace.gitDiffBetween({ from, root, to }),
    from: { checkpointRunCount, sessionId },
    toRef: diffEndRef,
  })

  return normalizeDiffs(parseGitDiff(patch))
}

const enqueueAgentRunDiff = createCachedTaskQueue<VcsFileDiff[]>(1, 0)
