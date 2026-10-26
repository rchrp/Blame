import { createHash } from 'node:crypto'

export type WebSearchInput = { query: string; limit?: number; language?: string }

export class WebSearchError extends Error {
  constructor(
    message: string,
    public status = 502
  ) {
    super(message)
  }
}

/** Only the server knows the upstream address. No provider keys or queries in logs. */
export default class WebSearchService {
  constructor(
    private endpoint: string | undefined,
    private request: typeof fetch = fetch
  ) {}

  async search(input: WebSearchInput) {
    if (!this.endpoint)
      throw new WebSearchError('Web search is not configured on this Blame server.', 503)
    const url = new URL('search', `${this.endpoint.replace(/\/$/, '')}/`)
    const body = new URLSearchParams({ q: input.query, format: 'json', categories: 'general' })
    if (input.language) body.set('language', input.language)
    let payload: Record<string, unknown>
    try {
      const response = await this.request(url, {
        method: 'POST',
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`)
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Empty search response')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 2_000_000) throw new Error('Search response too large')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!payload || !Array.isArray(payload.results)) throw new Error('Invalid search response')
    } catch {
      throw new WebSearchError('The search service is unavailable. Please try again shortly.')
    }
    const seen = new Set<string>()
    const retrievedAt = new Date().toISOString()
    const sources = (payload.results as unknown[])
      .flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const value = item as Record<string, unknown>
        let url: URL
        try {
          url = new URL(String(value.url))
        } catch {
          return []
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []
        url.hash = ''
        if (seen.has(url.href)) return []
        seen.add(url.href)
        const date = typeof value.publishedDate === 'string' ? Date.parse(value.publishedDate) : NaN
        return [
          {
            id: `web_${createHash('sha256').update(url.href).digest('hex').slice(0, 24)}`,
            url: url.href,
            title: text(value.title, 300) || url.hostname,
            domain: url.hostname,
            snippet: text(value.content, 700),
            engines: (Array.isArray(value.engines) ? value.engines : [value.engine])
              .filter((entry): entry is string => typeof entry === 'string')
              .slice(0, 8),
            retrievedAt,
            ...(Number.isFinite(date) ? { publishedAt: new Date(date).toISOString() } : {}),
          },
        ]
      })
      .slice(0, input.limit ?? 10)
    const unavailable = Array.isArray(payload.unresponsive_engines)
      ? payload.unresponsive_engines.flatMap((entry) =>
          Array.isArray(entry) && typeof entry[0] === 'string' ? [entry[0]] : []
        )
      : []
    return {
      query: input.query,
      sources,
      resultCount: sources.length,
      partial: unavailable.length > 0,
      unavailableEngines: unavailable,
      retrievedAt,
    }
  }
}

function text(value: unknown, limit: number) {
  return typeof value === 'string'
    ? value
        .replace(/<[^>]*>/g, '')
        .trim()
        .slice(0, limit)
    : ''
}
