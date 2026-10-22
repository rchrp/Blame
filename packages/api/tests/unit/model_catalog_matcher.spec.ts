import type { CatalogModel, OpenRouterModel } from '#services/model_catalog_contract'
import { ModelCatalogMatcher } from '#services/model_catalog_matcher'
import { test } from '@japa/runner'

test.group('model catalog matcher', () => {
  test('matches exact OpenRouter identifiers', ({ assert }) => {
    const matcher = new ModelCatalogMatcher([openRouterModel('openai/gpt-5.6', 'GPT-5.6')])

    const match = matcher.match('openrouter', catalogModel('openai/gpt-5.6', 'GPT-5.6'))

    assert.equal(match?.model.id, 'openai/gpt-5.6')
    assert.equal(match?.confidence, 1)
  })

  test('adds the provider author to native model identifiers', ({ assert }) => {
    const matcher = new ModelCatalogMatcher([
      openRouterModel('anthropic/claude-sonnet-4.6', 'Claude Sonnet 4.6'),
    ])

    const match = matcher.match('anthropic', catalogModel('claude-sonnet-4.6', 'Claude Sonnet 4.6'))

    assert.equal(match?.model.id, 'anthropic/claude-sonnet-4.6')
    assert.equal(match?.confidence, 1)
  })

  test('uses a unique normalized display name when ids differ', ({ assert }) => {
    const matcher = new ModelCatalogMatcher([
      openRouterModel('google/gemini-3.1-pro', 'Gemini 3.1 Pro Preview'),
    ])

    const match = matcher.match(
      'gemini',
      catalogModel('gemini-3.1-pro-preview-latest', 'Gemini 3.1 Pro')
    )

    assert.equal(match?.model.id, 'google/gemini-3.1-pro')
    assert.equal(match?.confidence, 0.94)
  })

  test('matches unique providerless custom model identifiers', ({ assert }) => {
    const matcher = new ModelCatalogMatcher([
      openRouterModel('z-ai/glm-5.1', 'GLM 5.1'),
      openRouterModel('moonshotai/kimi-k2.6', 'Kimi K2.6'),
    ])

    const match = matcher.match('openai-compatible', catalogModel('glm-5.1', 'glm-5.1'))

    assert.equal(match?.model.id, 'z-ai/glm-5.1')
    assert.equal(match?.confidence, 1)
  })

  test('resolves a Claude Code alias to its family model', ({ assert }) => {
    const matcher = new ModelCatalogMatcher([
      dated('anthropic/claude-opus-5', 'Claude Opus 5', '2026-07-24'),
      dated('anthropic/claude-opus-5.5', 'Claude Opus 5.5', '2026-09-22'),
      dated('anthropic/claude-opus-5.5:batch', 'Claude Opus 5.5 (batch)', '2026-09-22'),
      dated('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', '2026-09-28'),
      dated('anthropic/claude-4.5-haiku', 'Claude Haiku 4.5', '2025-10-15'),
    ])
    const alias = (id: string, name: string, releaseDate?: string) =>
      matcher.match('claude-code', { ...catalogModel(id, name), releaseDate })

    assert.equal(alias('opus', 'Claude Opus', '2026-09-22')?.model.id, 'anthropic/claude-opus-5.5')
    assert.equal(alias('sonnet', 'Claude Sonnet')?.model.id, 'anthropic/claude-sonnet-5.5')
    assert.equal(alias('haiku', 'Claude Haiku')?.model.id, 'anthropic/claude-4.5-haiku')
    // The alias date wins over the newest release.
    assert.equal(alias('opus', 'Claude Opus', '2026-07-20')?.model.id, 'anthropic/claude-opus-5')
  })

  test('does not take a whole version for part of another', ({ assert }) => {
    const matcher = new ModelCatalogMatcher([
      openRouterModel('openai/gpt-5.6-sol-codex-max', 'GPT-5.6 Sol Codex Max'),
    ])

    const match = matcher.match(
      'openai-codex',
      catalogModel('gpt-6-sol-codex-max', 'GPT-6 Sol Codex Max')
    )

    assert.isUndefined(match)
  })

  test('does not confuse different numeric model versions', ({ assert }) => {
    const matcher = new ModelCatalogMatcher([
      openRouterModel('openai/gpt-5.5-codex', 'GPT-5.5 Codex'),
    ])

    const match = matcher.match('openai-codex', catalogModel('gpt-5.6-codex', 'GPT-5.6 Codex'))

    assert.isUndefined(match)
  })
})

function catalogModel(id: string, name: string): CatalogModel {
  return {
    id,
    name,
    cost: {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    },
  }
}

function dated(id: string, name: string, releaseDate: string): OpenRouterModel {
  return { ...openRouterModel(id, name), releaseDate }
}

function openRouterModel(id: string, name: string): OpenRouterModel {
  return {
    id,
    canonicalSlug: id,
    name,
    inputPrice: null,
    outputPrice: null,
    cacheReadPrice: null,
    cacheWritePrice: null,
  }
}
