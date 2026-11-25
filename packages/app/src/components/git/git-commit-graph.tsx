import type {
  GitGraphLine,
  GitGraphRow,
} from "@/components/git/git-graph-layout"

export const gitGraphRowHeight = 48
const laneWidth = 16
const graphPadding = 6
// Wider histories keep their lanes but clip the ones past this column.
const maxVisibleLanes = 10

// Opaque colors: lines meeting at a row edge must not stack into a lighter
// or darker seam.
const laneColors = [
  "text-sky-500 dark:text-sky-400",
  "text-violet-500 dark:text-violet-400",
  "text-emerald-500 dark:text-emerald-400",
  "text-amber-500 dark:text-amber-400",
  "text-pink-500 dark:text-pink-400",
  "text-teal-500 dark:text-teal-400",
  "text-orange-500 dark:text-orange-400",
  "text-indigo-500 dark:text-indigo-400",
]

export type GitCommitNodeKind = "commit" | "head" | "selected"

export function gitGraphWidth(laneCount: number) {
  const lanes = Math.min(Math.max(laneCount, 1), maxVisibleLanes)
  return lanes * laneWidth + graphPadding * 2
}

export function GitCommitGraphCell({
  node,
  row,
  width,
}: {
  node: GitCommitNodeKind
  row: GitGraphRow
  width: number
}) {
  const middle = gitGraphRowHeight / 2
  const nodeX = laneX(row.column)
  const gap = nodeRadius(node)

  return (
    <svg
      aria-hidden
      className="block shrink-0"
      height={gitGraphRowHeight}
      viewBox={`0 0 ${width} ${gitGraphRowHeight}`}
      width={width}
    >
      {row.lines.map((line, index) => (
        <path
          className={laneColor(line.color)}
          d={linePath(line, middle, gap)}
          fill="none"
          key={index}
          stroke="currentColor"
          strokeWidth={1.75}
        />
      ))}
      <g className={laneColor(row.color)}>
        <CommitNode kind={node} x={nodeX} y={middle} />
      </g>
    </svg>
  )
}

function CommitNode({
  kind,
  x,
  y,
}: {
  kind: GitCommitNodeKind
  x: number
  y: number
}) {
  if (kind === "selected") {
    return (
      <>
        <circle
          cx={x}
          cy={y}
          fill="none"
          r={6.5}
          stroke="currentColor"
          strokeWidth={1.75}
        />
        <circle cx={x} cy={y} fill="currentColor" r={3.5} />
      </>
    )
  }
  if (kind === "head") {
    return (
      <>
        <circle
          cx={x}
          cy={y}
          fill="none"
          r={5}
          stroke="currentColor"
          strokeWidth={1.75}
        />
        <circle cx={x} cy={y} fill="currentColor" r={2} />
      </>
    )
  }
  return <circle cx={x} cy={y} fill="currentColor" r={4} />
}

// Where lines stop around the node, so hollow nodes stay empty.
function nodeRadius(kind: GitCommitNodeKind) {
  if (kind === "selected") return 7.5
  if (kind === "head") return 6
  return 3
}

function laneX(column: number) {
  return graphPadding + column * laneWidth + laneWidth / 2
}

function laneColor(color: number) {
  return laneColors[color % laneColors.length]
}

// Each line leaves and reaches its ends vertically, so a lane bends in a
// smooth S and stays straight across row edges.
function linePath(line: GitGraphLine, middle: number, gap: number) {
  const fromX = laneX(line.from)
  const toX = laneX(line.to)
  if (line.part === "through") return `M ${fromX} 0 V ${gitGraphRowHeight}`
  const [startY, endY] =
    line.part === "top" ? [0, middle - gap] : [middle + gap, gitGraphRowHeight]
  if (fromX === toX) return `M ${fromX} ${startY} V ${endY}`
  const bend = (startY + endY) / 2
  return `M ${fromX} ${startY} C ${fromX} ${bend}, ${toX} ${bend}, ${toX} ${endY}`
}
