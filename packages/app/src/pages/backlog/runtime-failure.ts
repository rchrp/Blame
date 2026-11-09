export type RuntimeOperation = "ensure" | "repair" | "reset"

export function runtimeFailureTitle(operation: RuntimeOperation) {
  if (operation === "ensure") return "Runtime setup failed"
  if (operation === "repair") return "Runtime repair failed"
  return "Runtime reset failed"
}

export function runtimeReportFailure(result: unknown) {
  if (!isRecord(result) || typeof result.status !== "string") return null
  if (result.status === "ready") return null
  const issue = Array.isArray(result.issues) ? result.issues[0] : undefined
  const issueError = isRecord(issue) ? errorDetail(issue.error) : null
  if (issueError) return issueError
  const action = isRecord(issue) ? stringValue(issue.action) : null
  return [`Blame Runtime is still ${result.status}.`, action]
    .filter(Boolean)
    .join(" ")
}

export function runtimeFailureDetail(error: unknown) {
  const detail = errorDetail(error) ?? "Blame Runtime could not be prepared."
  const withoutIpcPrefix = stripAnsiSequences(detail).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,
    ""
  )
  const lines = withoutIpcPrefix
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return (lines.slice(-8).join("\n") || detail).slice(0, 1_200)
}

function stripAnsiSequences(value: string) {
  return value
    .split("\u001b")
    .map((segment, index) =>
      index === 0 ? segment : segment.replace(/^\[[0-9;]*m/, "")
    )
    .join("")
}

function errorDetail(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (isRecord(error)) return stringValue(error.message)
  return null
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object"
}
