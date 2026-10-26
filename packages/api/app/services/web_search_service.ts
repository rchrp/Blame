import { createHash } from 'node:crypto'
import WebSearchEnginePool from '#services/web_search_engine_pool'

export type WebSearchInput = { query: string; limit?: number; language?: string }
type SearchPayload = { results: unknown[]; unresponsive_engines?: unknown }

export class WebSearchError extends Error {
  constructor(
    message: string,
    public status = 502,
    public retryAfter?: number
  ) {
    super(message)
  }
}

/** Only the server knows the upstream address. No provider keys or queries in logs. */
export default class WebSearchService {
  private pool: WebSearchEnginePool
  private unavailableUntil = 0

  constructor(
    private endpoint: string | undefined,
    private request: typeof fetch = fetch,
    private now: () => number = Date.now
  ) {
    this.pool = new WebSearchEnginePool(now)
  }

  async search(input: WebSearchInput) {
    if (!this.endpoint)
      throw new WebSearchError('Web search is not configured on this Blame server.', 503)
    if (this.unavailableUntil > this.now())
      throw new WebSearchError(
        'The search service is unavailable. Please try again shortly.',
        503,
        5
      )

    const deadline = this.now() + 15_000
    const attempted = new Set<string>()
    const unavailable = new Set(this.pool.cooling())
    let responded = false
    // Three disjoint pairs at most. Stop as soon as usable sources are available.
    while (this.now() < deadline - 500) {
      const leases = this.pool.reserve(attempted)
      if (!leases.length) break
      for (const lease of leases) attempted.add(lease.name)
      let payload: SearchPayload
      try {
        payload = await this.fetchResults(
          input,
          leases.map((lease) => lease.name),
          deadline
        )
      } catch {
        this.pool.release(leases)
        // The shared upstream failed, so switching engines cannot fix this call.
        this.unavailableUntil = this.now() + 5_000
        throw new WebSearchError(
          'The search service is unavailable. Please try again shortly.',
          502,
          5
        )
      }
      const errors = new Map<string, string>()
      if (Array.isArray(payload.unresponsive_engines)) {
        for (const entry of payload.unresponsive_engines) {
          if (Array.isArray(entry) && typeof entry[0] === 'string')
            errors.set(entry[0], typeof entry[1] === 'string' ? entry[1] : 'unknown error')
        }
      }
      for (const lease of leases) {
        this.pool.finish(lease, errors.get(lease.name))
        if (errors.has(lease.name)) unavailable.add(lease.name)
        else responded = true
      }
      const retrievedAt = new Date(this.now()).toISOString()
      const sources = normalizeSources(payload.results, input.limit ?? 10, retrievedAt)
      if (sources.length) {
        return {
          query: input.query,
          sources,
          resultCount: sources.length,
          partial: unavailable.size > 0,
          unavailableEngines: [...unavailable],
          retrievedAt,
        }
      }
    }
    // A genuine empty search remains distinct from all engines being blocked/busy.
    if (!responded)
      throw new WebSearchError(
        'Web search engines are temporarily unavailable or busy. Please try again later.',
        503,
        this.pool.retryAfter()
      )
    return {
      query: input.query,
      sources: [],
      resultCount: 0,
      partial: unavailable.size > 0,
      unavailableEngines: [...unavailable],
      retrievedAt: new Date(this.now()).toISOString(),
    }
  }

  private async fetchResults(input: WebSearchInput, engines: string[], deadline: number) {
    const url = new URL('search', `${this.endpoint!.replace(/\/$/, '')}/`)
    const remaining = Math.max(1, deadline - this.now())
    const body = new URLSearchParams({
      // Quote SearXNG control tokens: queries cannot override engines, language,
      // timeouts or request an external-bang redirect. site: and quotes still work.
      q: input.query.replace(
        /(^|\s)([!:<]\S*)/gu,
        (_match, space, token) => `${space}${JSON.stringify(token)}`
      ),
      format: 'json',
      engines: engines.join(','),
      // Do NOT send categories=general: SearXNG adds every category engine to an
      // explicit engines list, defeating both rotation and circuit breakers.
      locale: 'en',
    })
    // Let SearXNG use the selected engines' configured timeouts normally. An
    // explicit timeout_limit overrides those defaults, so only shorten it when
    // the total budget is nearly spent.
    if (remaining < 5_500) body.set('timeout_limit', String(Math.max(100, remaining - 500) / 1000))
    if (input.language) body.set('language', input.language)
    const response = await this.request(url, {
      method: 'POST',
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(6_000, remaining)),
      headers: { 'Accept': 'application/json', 'Accept-Language': 'en' },
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`Upstream HTTP ${response.status}`)
    }
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
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!payload || !Array.isArray(payload.results)) throw new Error('Invalid search response')
    return payload as SearchPayload
  }
}

function normalizeSources(results: unknown[], limit: number, retrievedAt: string) {
  const seen = new Set<string>()
  const sources = results
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
      const date =
        typeof value.publishedDate === 'string' ? Date.parse(value.publishedDate) : Number.NaN
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
    .slice(0, limit)
  return sources
}

function text(value: unknown, limit: number) {
  return typeof value === 'string'
    ? value
        .replace(/<[^>]*>/g, '')
        .trim()
        .slice(0, limit)
    : ''
}
