// Lane layout of a commit graph, drawn one row per commit like IntelliJ's
// log: each lane waits for one commit, a merge opens a lane for its other
// parents, and lanes waiting for the same commit meet on it.
// Commits must list children before parents (git log --date-order).

export type GitGraphCommit = {
  hash: string
  parents: readonly string[]
}

// top: from the row's top edge to the commit; bottom: from the commit to the
// row's bottom edge; through: a lane passing by the commit.
export type GitGraphLine = {
  color: number
  from: number
  part: "bottom" | "through" | "top"
  to: number
}

export type GitGraphRow = {
  color: number
  column: number
  lines: GitGraphLine[]
}

export type GitGraphLayout = {
  laneCount: number
  rows: GitGraphRow[]
}

type Lane = {
  color: number
  hash: string
}

export function layoutGitGraph(
  commits: readonly GitGraphCommit[]
): GitGraphLayout {
  const lanes: (Lane | null)[] = []
  let nextColor = 0
  let laneCount = 0
  const rows = commits.map((commit) => {
    const waiting = waitingLanes(lanes, commit.hash)
    const column = waiting[0] ?? freeLane(lanes)
    const color = waiting.length > 0 ? lanes[column]!.color : nextColor++
    const lines = incomingLines(lanes, commit.hash, column)
    for (const index of waiting) lanes[index] = null

    commit.parents.forEach((parent, parentIndex) => {
      if (parentIndex === 0) {
        lanes[column] = { color, hash: parent }
        lines.push({ color, from: column, part: "bottom", to: column })
        return
      }
      const existing = lanes.findIndex((lane) => lane?.hash === parent)
      if (existing !== -1) {
        const laneColor = lanes[existing]!.color
        lines.push({
          color: laneColor,
          from: column,
          part: "bottom",
          to: existing,
        })
        return
      }
      const index = freeLane(lanes)
      const laneColor = nextColor++
      lanes[index] = { color: laneColor, hash: parent }
      lines.push({ color: laneColor, from: column, part: "bottom", to: index })
    })

    trimClosedLanes(lanes)
    laneCount = Math.max(laneCount, rowLaneCount(column, lines))
    return { color, column, lines }
  })
  return { laneCount, rows }
}

function waitingLanes(lanes: readonly (Lane | null)[], hash: string) {
  return lanes.flatMap((lane, index) => (lane?.hash === hash ? [index] : []))
}

function incomingLines(
  lanes: readonly (Lane | null)[],
  hash: string,
  column: number
) {
  const lines: GitGraphLine[] = []
  lanes.forEach((lane, index) => {
    if (!lane) return
    lines.push(
      lane.hash === hash
        ? { color: lane.color, from: index, part: "top", to: column }
        : { color: lane.color, from: index, part: "through", to: index }
    )
  })
  return lines
}

function freeLane(lanes: readonly (Lane | null)[]) {
  const index = lanes.indexOf(null)
  return index === -1 ? lanes.length : index
}

function trimClosedLanes(lanes: (Lane | null)[]) {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
}

function rowLaneCount(column: number, lines: readonly GitGraphLine[]) {
  return Math.max(
    column + 1,
    ...lines.map((line) => Math.max(line.from, line.to) + 1)
  )
}
