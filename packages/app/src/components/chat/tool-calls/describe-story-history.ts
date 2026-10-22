import { firstLine, list, record, str, textOf } from "./tool-call-values.ts"
import type { ToolCallSource, ToolCallView } from "./tool-call-view.ts"

// The agent looking back at earlier user stories of the project.

export function describeStorySearch(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const query = str(input.query)?.trim()
  const status = str(input.status)
  const output = textOf(source.output)
  return {
    family: "search",
    verb: source.running ? "Searching stories" : "Searched stories",
    target: query
      ? { text: `“${firstLine(query, 60)}”`, title: query }
      : { text: status && status !== "any" ? `in ${status}` : "recent" },
    chips: [],
    bodies: output ? [{ type: "text", text: output.text }] : [],
    failed: false,
  }
}

export function describeStoryRead(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const story = str(input.story)?.trim() ?? "story"
  const sections = list(input.include).filter(
    (item): item is string => typeof item === "string"
  )
  const output = textOf(source.output)
  return {
    family: "read",
    verb: source.running ? "Reading story" : "Read story",
    target: { text: story.toUpperCase(), mono: true },
    chips: sections.map((section) => ({ label: section })),
    bodies: output ? [{ type: "text", text: output.text }] : [],
    failed: false,
  }
}
