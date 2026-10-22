import type { CatalogModel, OpenRouterModel } from '#services/model_catalog_contract'

export type OpenRouterMatch = {
  model: OpenRouterModel
  confidence: number
}

const providerAuthors: Record<string, string[]> = {
  'anthropic': ['anthropic'],
  'bedrock': ['anthropic', 'amazon'],
  'claude-code': ['anthropic'],
  'gemini': ['google'],
  'google': ['google'],
  'minimax': ['minimax'],
  'moonshot': ['moonshotai'],
  'openai-codex': ['openai'],
  'openai-native': ['openai'],
  'openai': ['openai'],
  'qwen': ['qwen', 'alibaba'],
  'xai': ['x-ai'],
  'zai': ['z-ai'],
  'zai-coding-plan': ['z-ai'],
}

export class ModelCatalogMatcher {
  private readonly byId = new Map<string, OpenRouterModel>()
  private readonly byName = new Map<string, OpenRouterModel[]>()
  private readonly byShortId = new Map<string, OpenRouterModel | null>()

  constructor(private readonly models: OpenRouterModel[]) {
    for (const model of models) this.index(model)
  }

  match(providerId: string, model: CatalogModel): OpenRouterMatch | undefined {
    const exact = this.exactMatch(providerId, model)
    if (exact) return { model: exact, confidence: 1 }
    const aliased = this.aliasMatch(providerId, model)
    if (aliased) return { model: aliased, confidence: 0.9 }
    const named = this.nameMatch(providerId, model)
    if (named) return { model: named, confidence: 0.94 }
    return this.fuzzyMatch(providerId, model)
  }

  private index(model: OpenRouterModel) {
    this.byId.set(model.id.toLowerCase(), model)
    this.byId.set(model.canonicalSlug.toLowerCase(), model)
    this.indexShortId(stripProviderPrefix(model.id), model)
    this.indexShortId(stripProviderPrefix(model.canonicalSlug), model)
    const key = normalizeModelText(model.name)
    this.byName.set(key, [...(this.byName.get(key) ?? []), model])
  }

  private indexShortId(id: string, model: OpenRouterModel) {
    const key = id.toLowerCase()
    const current = this.byShortId.get(key)
    if (current && current.id !== model.id) {
      this.byShortId.set(key, null)
      return
    }
    if (current === undefined) this.byShortId.set(key, model)
  }

  private exactMatch(providerId: string, model: CatalogModel) {
    for (const id of candidateIds(providerId, model.id)) {
      const match = this.byId.get(id.toLowerCase())
      if (match) return match
    }
    return this.byShortId.get(stripProviderPrefix(model.id).toLowerCase()) ?? undefined
  }

  // A family alias without a version ("opus" in Claude Code) stands for the
  // family's latest model: the one released closest to the alias, or the
  // newest one when the alias has no date.
  private aliasMatch(providerId: string, model: CatalogModel) {
    const family = stripProviderPrefix(model.id).toLowerCase()
    if (!/^[a-z]+$/.test(family)) return undefined
    const authors = new Set(providerAuthors[providerId] ?? [])
    if (!authors.size) return undefined
    const pattern = new RegExp(`^[a-z]+-(?:${family}-\\d|[\\d.]+-${family}(?:-|$))`)
    const members = this.models.filter(
      (candidate) =>
        authors.has(modelAuthor(candidate.id)) &&
        !candidate.id.includes(':') &&
        pattern.test(stripProviderPrefix(candidate.id).toLowerCase())
    )
    const target = releaseTime(model.releaseDate)
    return members.sort((left, right) =>
      target
        ? Math.abs(releaseTime(left.releaseDate) - target) -
          Math.abs(releaseTime(right.releaseDate) - target)
        : releaseTime(right.releaseDate) - releaseTime(left.releaseDate)
    )[0]
  }

  private nameMatch(providerId: string, model: CatalogModel) {
    const matches = this.byName.get(normalizeModelText(model.name)) ?? []
    return preferProviderAuthor(providerId, matches)
  }

  private fuzzyMatch(providerId: string, model: CatalogModel) {
    const candidates = providerCandidates(providerId, this.models)
    const ranked = candidates
      .map((candidate) => ({ candidate, score: similarityScore(model, candidate) }))
      .filter((entry) => entry.score >= 0.78)
      .sort((left, right) => right.score - left.score)
    const best = ranked[0]
    if (!best || ranked[1]?.score === best.score) return undefined
    return { model: best.candidate, confidence: best.score }
  }
}

function candidateIds(providerId: string, modelId: string) {
  const ids = new Set([modelId])
  for (const author of providerAuthors[providerId] ?? []) {
    ids.add(`${author}/${stripProviderPrefix(modelId)}`)
  }
  return ids
}

function preferProviderAuthor(providerId: string, models: OpenRouterModel[]) {
  if (models.length === 1) return models[0]
  const authors = new Set(providerAuthors[providerId] ?? [])
  return models.find((model) => authors.has(modelAuthor(model.id)))
}

function providerCandidates(providerId: string, models: OpenRouterModel[]) {
  const authors = new Set(providerAuthors[providerId] ?? [])
  if (!authors.size) return models
  const matching = models.filter((model) => authors.has(modelAuthor(model.id)))
  return matching.length ? matching : models
}

function similarityScore(model: CatalogModel, candidate: OpenRouterModel) {
  const rawModelId = stripProviderPrefix(model.id)
  const rawCandidateId = stripProviderPrefix(candidate.canonicalSlug)
  if (!versionsCompatible(rawModelId, rawCandidateId)) return 0
  const modelId = normalizeModelText(rawModelId)
  const candidateId = normalizeModelText(rawCandidateId)
  const idScore = tokenSimilarity(modelId, candidateId)
  const nameScore = tokenSimilarity(
    normalizeModelText(model.name),
    normalizeModelText(candidate.name)
  )
  return roundScore(idScore * 0.7 + nameScore * 0.3)
}

function tokenSimilarity(left: string, right: string) {
  if (left === right) return 1
  const leftTokens = new Set(left.split(' ').filter(Boolean))
  const rightTokens = new Set(right.split(' ').filter(Boolean))
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length
  const union = new Set([...leftTokens, ...rightTokens]).size
  return union ? intersection / union : 0
}

// Versions are compared whole: "6" is not part of "5.6", so GPT-6 Sol never
// borrows GPT-5.6 Sol's benchmark.
function versionsCompatible(left: string, right: string) {
  const leftVersions = versionTokens(left)
  const rightVersions = versionTokens(right)
  if (!leftVersions.size || !rightVersions.size) return true
  return [...leftVersions].every((token) => rightVersions.has(token))
}

function versionTokens(value: string) {
  return new Set(value.toLowerCase().match(/\d+(?:\.\d+)*/g) ?? [])
}

function normalizeModelText(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(the|model|preview|latest|chat)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function stripProviderPrefix(value: string) {
  return value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value
}

function modelAuthor(value: string) {
  return value.includes('/') ? value.slice(0, value.indexOf('/')).toLowerCase() : ''
}

function releaseTime(value: string | undefined) {
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function roundScore(value: number) {
  return Math.round(value * 1000) / 1000
}
