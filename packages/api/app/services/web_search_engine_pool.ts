/** Traffic priorities, separate from SearXNG's result-ranking weights. */
export const WEB_SEARCH_ENGINES = [
  { name: 'brave', weight: 3 },
  { name: 'google cse', weight: 3 },
  { name: 'bing', weight: 2 },
  { name: 'qwant', weight: 2 },
  { name: 'duckduckgo', weight: 2 },
  { name: 'yahoo', weight: 1 },
] as const

type EngineState = {
  name: string
  weight: number
  score: number
  active: number
  failures: number
  revision: number
  blockedUntil: number
}

export type EngineLease = { name: string; revision: number }

/** Shared by the API process. Reserve synchronously, before any network await. */
export default class WebSearchEnginePool {
  private engines: EngineState[] = WEB_SEARCH_ENGINES.map((engine) => ({
    ...engine,
    score: 0,
    active: 0,
    failures: 0,
    revision: 0,
    blockedUntil: 0,
  }))

  constructor(private now: () => number = Date.now) {}

  reserve(excluded: Set<string>, count = 2): EngineLease[] {
    const leases: EngineLease[] = []
    for (let i = 0; i < count; i++) {
      const available = this.engines.filter(
        (engine) =>
          !excluded.has(engine.name) &&
          !leases.some((lease) => lease.name === engine.name) &&
          engine.blockedUntil <= this.now() &&
          engine.active < (engine.failures ? 1 : 2)
      )
      if (!available.length) break
      // Smooth weighted rotation; cooling/busy engines do not accumulate credit.
      let selected = available[0]
      let totalWeight = 0
      for (const engine of available) {
        totalWeight += engine.weight
        engine.score += engine.weight
        if (engine.score > selected.score) selected = engine
      }
      selected.score -= totalWeight
      selected.active++
      leases.push({ name: selected.name, revision: selected.revision })
    }
    return leases
  }

  finish(lease: EngineLease, error?: string) {
    const engine = this.engines.find((entry) => entry.name === lease.name)!
    engine.active--
    if (error !== undefined) {
      engine.failures++
      engine.revision++
      const duration = /captcha|access denied|\b403\b/i.test(error)
        ? 86_400_000
        : /too many requests|\b429\b/i.test(error)
          ? 3_600_000
          : Math.min(120_000, 30_000 * 2 ** Math.min(engine.failures - 1, 2))
      engine.blockedUntil = Math.max(engine.blockedUntil, this.now() + duration)
      engine.score = 0
    } else if (engine.revision === lease.revision) {
      // A late success must not reopen a circuit closed by another request.
      engine.failures = 0
      engine.blockedUntil = 0
    }
  }

  /** Release without blaming engines for an unavailable/malformed SearXNG API. */
  release(leases: EngineLease[]) {
    for (const lease of leases) this.engines.find((engine) => engine.name === lease.name)!.active--
  }

  cooling() {
    return this.engines
      .filter((engine) => engine.blockedUntil > this.now())
      .map((engine) => engine.name)
  }

  retryAfter() {
    const next = Math.min(...this.engines.map((engine) => engine.blockedUntil))
    return Math.max(1, Math.ceil((next - this.now()) / 1000))
  }
}
