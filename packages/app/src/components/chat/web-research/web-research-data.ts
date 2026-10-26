import type { WebSource } from "@blame/agent-runtime/web-research"

export type ResearchSource = WebSource & {
  found: boolean
  consulted: boolean
  cited: boolean
  partial: boolean
  error?: string
  method?: string
  passage?: string
  queries: string[]
  runIds: string[]
}

export type ResearchEntry = { runId: string; detail: string; kind: string }

export function researchOutput(
  value: unknown,
  depth = 0
): Record<string, unknown> | undefined {
  if (depth > 6) return undefined
  if (typeof value === "string") {
    try {
      return researchOutput(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = researchOutput(item, depth + 1)
      if (result) return result
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  if (record.kind === "web_search" || record.kind === "web_page") return record
  for (const key of ["output", "result", "content", "text", "data"]) {
    const result = researchOutput(record[key], depth + 1)
    if (result) return result
  }
  return undefined
}

export function sourceFrom(value: unknown): WebSource | undefined {
  if (!value || typeof value !== "object") return undefined
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== "string" ||
    !/^web_[a-f0-9]{24}$/.test(item.id) ||
    typeof item.url !== "string"
  )
    return undefined
  let url: URL
  try {
    url = new URL(item.url)
  } catch {
    return undefined
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return undefined
  const text = (key: string) =>
    typeof item[key] === "string" ? (item[key] as string) : undefined
  return {
    id: item.id,
    url: url.href,
    title: text("title") || url.hostname,
    domain: url.hostname,
    snippet: text("snippet") ?? "",
    retrievedAt: text("retrievedAt") ?? "",
    publishedAt: text("publishedAt"),
    author: text("author"),
    siteName: text("siteName"),
    finalUrl: text("finalUrl"),
    engines: Array.isArray(item.engines)
      ? item.engines.filter(
          (entry): entry is string => typeof entry === "string"
        )
      : [],
  }
}

export function citationIds(markdown: string) {
  // Code samples are not citations. Only complete Markdown links count.
  const prose = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/`[^`\n]*`/g, "")
  return new Set(
    [...prose.matchAll(/\[[^\]\n]+\]\(#source-(web_[a-f0-9]{24})\)/g)].map(
      (match) => match[1]!
    )
  )
}

export function collectResearchSources(
  entries: ResearchEntry[],
  replies: string[]
): ResearchSource[] {
  const sources = new Map<string, ResearchSource>()
  for (const entry of entries) {
    if (entry.kind !== "tool") continue
    const result = researchOutput(entry.detail)
    if (!result) continue
    const values =
      result.kind === "web_search"
        ? Array.isArray(result.sources)
          ? result.sources
          : []
        : [result.source]
    for (const value of values) {
      const source = sourceFrom(value)
      if (!source) continue
      const previous = sources.get(source.id)
      const reading = result.kind === "web_page"
      const success =
        reading &&
        ["read", "partial"].includes(String(result.status)) &&
        typeof result.content === "string" &&
        result.content.trim().length > 0
      const updated = { ...previous, ...source } as ResearchSource
      // A failed read or a later search must not erase previously retrieved metadata.
      if (previous?.consulted && !success) Object.assign(updated, previous)
      updated.found = previous?.found === true || !reading
      updated.consulted = previous?.consulted === true || success
      updated.partial = success
        ? result.status === "partial" || result.truncated === true
        : (previous?.partial ?? false)
      updated.error =
        reading && typeof result.error === "string"
          ? result.error
          : previous?.error
      if (success) {
        updated.method = String(result.method)
        updated.passage = String(result.content).slice(0, 1500)
        updated.error =
          typeof result.error === "string" ? result.error : undefined
      }
      updated.queries = [
        ...new Set([
          ...(previous?.queries ?? []),
          ...(!reading && typeof result.query === "string"
            ? [result.query]
            : []),
        ]),
      ]
      updated.runIds = [...new Set([...(previous?.runIds ?? []), entry.runId])]
      updated.cited = false
      sources.set(source.id, updated)
    }
  }
  const cited = citationIds(replies.join("\n"))
  return [...sources.values()].map((source) => ({
    ...source,
    cited: cited.has(source.id),
  }))
}
