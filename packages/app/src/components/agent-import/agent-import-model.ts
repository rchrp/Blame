import type {
  AgentImportCategory,
  AgentImportChoice,
  AgentImportItem,
  AgentImportResult,
  AgentImportScan,
  AgentImportSource,
} from "@/context/platform"

// What the review shows and what it sends back. Pure, so it is tested alone.

/** An item the person can still decide on. */
export function isImportable(item: AgentImportItem) {
  return item.state === "new" || item.state === "conflict"
}

export function importableItems(scan: AgentImportScan) {
  return scan.sources.flatMap((source) => source.items.filter(isImportable))
}

export function hasImportable(scan: AgentImportScan) {
  return importableItems(scan).length > 0
}

/**
 * The ids ticked when the review opens, for the sources the person picked
 * (all of them when none is named).
 */
export function defaultSelection(
  scan: AgentImportScan,
  sourceIds?: ReadonlySet<string>
) {
  return new Set(
    scan.sources
      .filter((source) => !sourceIds || sourceIds.has(source.id))
      .flatMap((source) => source.items.filter(isImportable))
      .filter((item) => item.defaultSelected)
      .map((item) => item.id)
  )
}

/**
 * - `available`: found, with something to import: shown in colour.
 * - `empty`: found, nothing Blame can use or everything is already there.
 * - `missing`: not on this computer.
 */
export type SourceStatus = "available" | "empty" | "missing"

export function sourceStatus(source: AgentImportSource): SourceStatus {
  if (source.items.some(isImportable)) return "available"
  return source.detected ? "empty" : "missing"
}

/** The sources the first screen preselects. */
export function availableSourceIds(scan: AgentImportScan) {
  return new Set(
    scan.sources
      .filter((source) => sourceStatus(source) === "available")
      .map((source) => source.id)
  )
}

export function sourceCaption(source: AgentImportSource) {
  const status = sourceStatus(source)
  if (status === "missing") return "Not found"
  if (status === "empty") return "Nothing to import"
  const count = (category: AgentImportCategory) =>
    source.items.filter(
      (item) => item.category === category && isImportable(item)
    ).length
  const servers = count("mcp")
  const skills = count("skill") + count("command")
  return [
    servers ? `${servers} ${servers === 1 ? "server" : "servers"}` : "",
    skills ? `${skills} ${skills === 1 ? "skill" : "skills"}` : "",
  ]
    .filter(Boolean)
    .join(", ")
}

/**
 * A conflict is skipped unless ticked, and ticking it imports it under its
 * `renameTo`: nothing of Blame's is ever overwritten.
 */
export function choicesFrom(
  scan: AgentImportScan,
  selected: ReadonlySet<string>
): AgentImportChoice[] {
  return importableItems(scan)
    .filter((item) => selected.has(item.id))
    .map((item) => ({ id: item.id, rename: item.state === "conflict" }))
}

const categoryLabels: Record<AgentImportCategory, string> = {
  command: "Commands",
  mcp: "MCP servers",
  skill: "Skills",
}

export function categoryLabel(category: AgentImportCategory) {
  return categoryLabels[category]
}

/** The rows of a source: what can be imported, by category. */
export function groupItems(items: AgentImportItem[]) {
  const groups: { category: AgentImportCategory; items: AgentImportItem[] }[] =
    []
  for (const category of ["mcp", "skill", "command"] as const) {
    const rows = items.filter(
      (item) => item.category === category && isImportable(item)
    )
    if (rows.length) groups.push({ category, items: rows })
  }
  return groups
}

/** What is already there, said in one line instead of a row each. */
export function availableLine(items: AgentImportItem[]) {
  const count = (state: AgentImportItem["state"], category?: string) =>
    items.filter(
      (item) =>
        item.state === state && (!category || item.category === category)
    ).length
  const parts: string[] = []
  const inPlace = count("in-place")
  const present = count("present")
  if (inPlace)
    parts.push(
      `${inPlace} ${inPlace === 1 ? "skill or command is" : "skills and commands are"} already available to Blame where they are`
    )
  if (present)
    parts.push(
      `${present} ${present === 1 ? "item is" : "items are"} already in Blame`
    )
  return parts.join("; ")
}

export function resultLine(result: AgentImportResult) {
  const count = (...statuses: string[]) =>
    result.outcomes.filter((outcome) => statuses.includes(outcome.status))
      .length
  const added = count("imported", "renamed")
  const parts = [`${added} imported`]
  if (count("skipped", "present"))
    parts.push(`${count("skipped", "present")} left as they were`)
  if (count("failed")) parts.push(`${count("failed")} failed`)
  return parts.join(", ")
}
