type DiffWorkspace = {
  gitSnapshot(input: { id: string; root: string }): Promise<string>
  gitDiffBetween(input: {
    from: string
    root: string
    to: string
  }): Promise<string>
}

/**
 * The patch of one turn: from the engine's snapshot when the turn opened to
 * the next turn's snapshot, or to the files now for the last turn. The
 * snapshots are git trees in the workspace's own repository.
 */
export async function turnPatch(
  workspace: DiffWorkspace,
  { from, root, to }: { from: string; root: string; to: string | undefined }
) {
  // The files now, untracked ones included, as a tree to diff against. One
  // ref holds it, overwritten each time, so no refs pile up.
  const end =
    to ?? (await workspace.gitSnapshot({ id: "engine-turn-now", root }))
  return workspace.gitDiffBetween({ from, root, to: end })
}
