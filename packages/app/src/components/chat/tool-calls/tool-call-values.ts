// Small, defensive readers for tool call payloads. Tool inputs and outputs
// come from several runtimes (Cline built-ins, the Blame harness, older
// harness versions) and may be compacted into { excerpt, truncated } records.

export type TextValue = { text: string; truncated: boolean }

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function strings(value: unknown): string[] {
  return list(value).flatMap((entry) => {
    if (typeof entry === "string") return entry.trim() ? [entry] : []
    const command = record(entry)
    const text = str(command.command)
    if (!text) return []
    const args = list(command.args).filter(
      (arg): arg is string => typeof arg === "string"
    )
    return [[text, ...args].join(" ")]
  })
}

// Reads text that may have been compacted to { excerpt, truncated }.
export function textOf(value: unknown): TextValue | undefined {
  if (typeof value === "string") {
    return value.length ? { text: value, truncated: false } : undefined
  }
  const compact = record(value)
  const excerpt = str(compact.excerpt)
  if (excerpt) return { text: excerpt, truncated: compact.truncated === true }
  return undefined
}

export function pair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const first = num(value[0])
  const second = num(value[1])
  return first !== undefined && second !== undefined
    ? [first, second]
    : undefined
}

export function basename(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "")
  const index = normalized.lastIndexOf("/")
  return index < 0 ? normalized : normalized.slice(index + 1) || normalized
}

export function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./u, "")
  } catch {
    return url
  }
}

export function firstLine(text: string, max = 120) {
  const line = text.trim().split("\n", 1)[0] ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function plural(count: number, singular: string, pluralForm?: string) {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`
}

export function humanize(value: string) {
  const words = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_-]+/u)
    .filter(Boolean)
  const sentence = words.join(" ").toLowerCase()
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

export function formatDuration(ms: number | undefined) {
  if (ms === undefined || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`
}

// Strips terminal color codes so command output reads as plain text.
export function stripAnsi(text: string) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "")
}

export function lineCount(text: string) {
  if (!text) return 0
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text
  return trimmed.split("\n").length
}

// Results from the Blame harness: { status: "ok", data } or a blocked/failed
// record with a message. Older harness versions used "success" / "error".
export type HarnessResult = {
  data: Record<string, unknown>
  failed: boolean
  message?: string
  recovery?: string
}

export function harnessResult(output: unknown): HarnessResult | undefined {
  let value = record(output)
  const nested = record(value.output)
  if (str(nested.status) && !str(value.status)) value = nested
  const status = str(value.status)
  if (!status) return undefined
  const data = record(value.data)
  const failed = ["blocked", "failed", "error"].includes(status)
  return {
    data,
    failed,
    message: str(value.message) ?? str(value.error) ?? str(data.message),
    recovery: str(value.recovery),
  }
}

// Results from Cline built-in tools: one { query, result, success } per item.
export type OperationResult = {
  error?: string
  query?: string
  result?: TextValue
  success?: boolean
}

export function operationResults(output: unknown): OperationResult[] {
  return list(Array.isArray(output) ? output : output ? [output] : []).flatMap(
    (entry) => {
      const item = record(entry)
      if (!("query" in item) && !("result" in item) && !("success" in item)) {
        return []
      }
      return [
        {
          error: str(item.error),
          query: str(item.query) ?? textOf(item.query)?.text,
          result: textOf(item.result),
          success: typeof item.success === "boolean" ? item.success : undefined,
        },
      ]
    }
  )
}

export function specialistTool(toolName: string | undefined) {
  return toolName === "consult_specialist" || toolName === "spawn_agent"
}
