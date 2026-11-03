import { record, str } from "./tool-call-values.ts"
import type { ToolCallSource, ToolCallView } from "./tool-call-view.ts"

// The agent listed the preview's variables (names and statuses only) or
// asked the person for one.
export function describePreviewEnvironment(
  source: ToolCallSource
): ToolCallView {
  const input = record(source.input)
  const output = record(source.output)
  const request = str(input.action) === "request"
  const key = str(input.key)
  const variables = Array.isArray(output.variables) ? output.variables : []
  const missing = variables.filter(
    (entry) => record(entry).status !== "set"
  ).length
  return {
    family: "preview",
    verb: request
      ? source.running
        ? "Requesting"
        : "Requested"
      : source.running
        ? "Listing"
        : "Listed",
    target:
      request && key
        ? { text: key, mono: true }
        : { text: "preview variables" },
    chips:
      !request && variables.length
        ? [
            {
              label: missing ? `${missing} not set` : "all set",
              tone: missing ? "neutral" : "success",
            },
          ]
        : [],
    bodies:
      request && str(input.reason)
        ? [{ type: "text", label: "Reason", text: str(input.reason)! }]
        : [],
    failed: output.isError === true,
  }
}
