import { test } from '@japa/runner'
import WebSearchService, { WebSearchError } from '#services/web_search_service'
import { webSearchValidator } from '#validators/web_search'

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
            engines: ['google'],
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
})
