import { test } from '@japa/runner'
import WebSearchService, { WebSearchError } from '#services/web_search_service'
import { webSearchValidator } from '#validators/web_search'
import WebSearchEnginePool, { WEB_SEARCH_ENGINES } from '#services/web_search_engine_pool'

function selected(init?: RequestInit) {
  return new URLSearchParams(String(init?.body)).get('engines')!.split(',')
}

function found(engines: string[]) {
  return Response.json({ results: [{ url: 'https://example.org/', engines }] })
}

test.group('web search', () => {
  test('normalizes results, drops unsafe URLs, deduplicates and reports partial engines', async ({
    assert,
  }) => {
    const request: typeof fetch = async (url, init) => {
      assert.equal(String(url), 'http://search.internal/search')
      assert.equal(init?.method, 'POST')
      assert.equal(new URLSearchParams(String(init?.body)).get('q'), 'readability')
      return Response.json({
        results: [
          {
            url: 'https://example.org/article#one',
            title: '<b>Article</b>',
            content: 'A useful source',
            engines: ['google cse'],
            publishedDate: '2026-10-20',
          },
          { url: 'https://example.org/article#two', title: 'Duplicate' },
          { url: 'javascript:alert(1)' },
          { url: 'https://user:secret@example.org' },
          { url: 'https://example.net/', title: 'Another source', publishedDate: 'invalid' },
        ],
        unresponsive_engines: [['brave', 'timeout']],
      })
    }
    const result = await new WebSearchService('http://search.internal', request).search({
      query: 'readability',
    })
    assert.equal(result.resultCount, 2)
    assert.equal(result.sources[0].title, 'Article')
    assert.match(result.sources[0].id, /^web_[a-f0-9]{24}$/)
    assert.equal(result.sources[0].url, 'https://example.org/article')
    assert.isUndefined(result.sources[1].publishedAt)
    assert.isTrue(result.partial)
    assert.deepEqual(result.unavailableEngines, ['brave'])
  })
  test('fails explicitly for missing configuration and invalid upstream responses', async ({
    assert,
  }) => {
    try {
      await new WebSearchService(undefined).search({ query: 'test' })
      assert.fail('expected error')
    } catch (error) {
      assert.instanceOf(error, WebSearchError)
      assert.equal((error as WebSearchError).status, 503)
    }
    for (const response of [
      new Response('upstream secret', { status: 500 }),
      Response.json({ wrong: [] }),
    ]) {
      await assert.rejects(
        () =>
          new WebSearchService('http://search.internal', async () => response).search({
            query: 'test',
          }),
        /unavailable/
      )
    }
  })
  test('bounds user input before querying upstream', async ({ assert }) => {
    await assert.rejects(() => webSearchValidator.validate({ query: 'ok', limit: 999 }))
    await assert.rejects(() => webSearchValidator.validate({ query: 'x'.repeat(501) }))
    assert.deepEqual(
      await webSearchValidator.validate({ query: '  a query  ', limit: 5, language: 'fr' }),
      { query: 'a query', limit: 5, language: 'fr' }
    )
  })

  test('rotates healthy engines with priorities without querying all engines every time', async ({
    assert,
  }) => {
    const counts = new Map<string, number>()
    const service = new WebSearchService('http://search.internal', async (_url, init) => {
      const engines = selected(init)
      assert.lengthOf(engines, 2)
      assert.notEqual(engines[0], engines[1])
      const body = new URLSearchParams(String(init?.body))
      assert.isFalse(body.has('categories'))
      assert.equal(body.get('language'), 'fr')
      assert.equal(init?.redirect, 'error')
      assert.instanceOf(init?.signal, AbortSignal)
      for (const engine of engines) counts.set(engine, (counts.get(engine) ?? 0) + 1)
      return found(engines)
    })
    for (let i = 0; i < 130; i++) await service.search({ query: 'test', language: 'fr' })
    assert.sameMembers(
      [...counts.keys()],
      WEB_SEARCH_ENGINES.map((engine) => engine.name)
    )
    assert.isAbove(counts.get('brave')!, counts.get('yahoo')! * 1.5)
    assert.isAbove(counts.get('google cse')!, counts.get('bing')!)
  })

  test('falls back to different engines and skips blocked engines on subsequent searches', async ({
    assert,
  }) => {
    const calls: string[][] = []
    const service = new WebSearchService('http://search.internal', async (_url, init) => {
      const engines = selected(init)
      calls.push(engines)
      return calls.length === 1
        ? Response.json({
            results: [],
            unresponsive_engines: engines.map((engine) => [engine, 'CAPTCHA']),
          })
        : found(engines)
    })
    const result = await service.search({ query: 'test' })
    assert.lengthOf(calls, 2)
    assert.isTrue(result.partial)
    assert.sameMembers(result.unavailableEngines, calls[0])
    assert.equal(result.resultCount, 1)
    for (let i = 0; i < 10; i++) await service.search({ query: 'test' })
    for (const engines of calls.slice(1))
      for (const engine of engines) assert.notInclude(calls[0], engine)
  })

  test('returns partial sources immediately instead of filling from every fallback', async ({
    assert,
  }) => {
    let calls = 0
    const service = new WebSearchService('http://search.internal', async (_url, init) => {
      calls++
      const engines = selected(init)
      return Response.json({
        results: [{ url: 'https://example.org', engines: [engines[0]] }],
        unresponsive_engines: [[engines[1], 'timeout']],
      })
    })
    const result = await service.search({ query: 'test', limit: 20 })
    assert.equal(calls, 1)
    assert.equal(result.resultCount, 1)
    assert.isTrue(result.partial)
  })

  test('distinguishes empty searches from all engines failing and does not retry blocked engines', async ({
    assert,
  }) => {
    for (const failing of [false, true]) {
      const calls: string[] = []
      const service = new WebSearchService('http://search.internal', async (_url, init) => {
        const engines = selected(init)
        calls.push(...engines)
        return Response.json({
          results: [],
          unresponsive_engines: failing
            ? engines.map((engine) => [engine, 'too many requests'])
            : [],
        })
      })
      if (failing) {
        try {
          await service.search({ query: 'test' })
          assert.fail('expected unavailable engines')
        } catch (error) {
          assert.instanceOf(error, WebSearchError)
          assert.equal((error as WebSearchError).status, 503)
          assert.equal((error as WebSearchError).retryAfter, 3600)
        }
        await assert.rejects(() => service.search({ query: 'test' }), /unavailable/)
      } else {
        const result = await service.search({ query: 'test' })
        assert.equal(result.resultCount, 0)
        assert.isFalse(result.partial)
      }
      assert.lengthOf(calls, 6)
      assert.lengthOf(new Set(calls), 6)
    }
  })

  test('limits total fallback time and reduces the final upstream timeout', async ({ assert }) => {
    let now = 0
    const budgets: (string | null)[] = []
    const service = new WebSearchService(
      'http://search.internal',
      async (_url, init) => {
        budgets.push(new URLSearchParams(String(init?.body)).get('timeout_limit'))
        now += 6_000
        return Response.json({
          results: [],
          unresponsive_engines: selected(init).map((engine) => [engine, 'timeout']),
        })
      },
      () => now
    )
    await assert.rejects(() => service.search({ query: 'test' }), /unavailable/)
    assert.deepEqual(budgets, [null, null, '2.5'])
  })

  test('treats query control syntax literally so it cannot bypass the engine pool', async ({
    assert,
  }) => {
    const query = '!google_cse !!g <99 :de site:example.org "some phrase"'
    const service = new WebSearchService('http://search.internal', async (_url, init) => {
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get('q'), '"!google_cse" "!!g" "<99" ":de" site:example.org "some phrase"')
      assert.equal(body.get('locale'), 'en')
      return found(selected(init))
    })
    const result = await service.search({ query })
    assert.equal(result.query, query)
  })

  test('opens a short service circuit on malformed/oversized upstream responses', async ({
    assert,
  }) => {
    for (const body of [
      'not json',
      JSON.stringify({ results: [], padding: 'x'.repeat(2_000_000) }),
    ]) {
      let calls = 0
      let now = 0
      const service = new WebSearchService(
        'http://search.internal',
        async (_url, init) => {
          calls++
          return calls === 1 ? new Response(body) : found(selected(init))
        },
        () => now
      )
      await assert.rejects(() => service.search({ query: 'test' }), /unavailable/)
      await assert.rejects(() => service.search({ query: 'test' }), /unavailable/)
      assert.equal(calls, 1)
      now = 5_001
      const result = await service.search({ query: 'test' })
      assert.equal(result.resultCount, 1)
    }
  })
})

test.group('web search engine circuits', () => {
  test('respects cooldowns and probes an expired circuit only once concurrently', ({ assert }) => {
    for (const [reason, duration] of [
      ['timeout', 30_000],
      ['too many requests', 3_600_000],
      ['Suspended: CAPTCHA', 86_400_000],
      ['access denied', 86_400_000],
    ] as const) {
      let now = 0
      const pool = new WebSearchEnginePool(() => now)
      const lease = pool.reserve(new Set(), 1)[0]
      const others = new Set(
        WEB_SEARCH_ENGINES.map((engine) => engine.name).filter((name) => name !== lease.name)
      )
      pool.finish(lease, reason)
      now = duration - 1
      assert.isEmpty(pool.reserve(others))
      now++
      const probe = pool.reserve(others)
      assert.lengthOf(probe, 1)
      assert.isEmpty(pool.reserve(others))
      pool.finish(probe[0])
      assert.lengthOf(pool.reserve(others), 1)
      assert.lengthOf(pool.reserve(others), 1)
      assert.isEmpty(pool.reserve(others))
    }
  })

  test('backs off repeated temporary errors and ignores stale concurrent successes', ({
    assert,
  }) => {
    let now = 0
    const pool = new WebSearchEnginePool(() => now)
    const first = pool.reserve(new Set(), 1)[0]
    const others = new Set(
      WEB_SEARCH_ENGINES.map((engine) => engine.name).filter((name) => name !== first.name)
    )
    const concurrent = pool.reserve(others)[0]
    pool.finish(first, 'timeout')
    pool.finish(concurrent)
    assert.isEmpty(pool.reserve(others))
    now = 30_000
    pool.finish(pool.reserve(others)[0], 'timeout')
    now += 59_999
    assert.isEmpty(pool.reserve(others))
    now++
    pool.finish(pool.reserve(others)[0], 'timeout')
    now += 119_999
    assert.isEmpty(pool.reserve(others))
    now++
    assert.lengthOf(pool.reserve(others), 1)
  })

  test('caps simultaneous work at two per engine and releases transport failures', ({ assert }) => {
    const pool = new WebSearchEnginePool()
    const leases = Array.from({ length: 6 }, () => pool.reserve(new Set())).flat()
    assert.lengthOf(leases, 12)
    for (const { name } of WEB_SEARCH_ENGINES)
      assert.lengthOf(
        leases.filter((lease) => lease.name === name),
        2
      )
    assert.isEmpty(pool.reserve(new Set()))
    pool.release(leases)
    assert.lengthOf(pool.reserve(new Set()), 2)
    assert.isEmpty(pool.cooling())
  })
})
