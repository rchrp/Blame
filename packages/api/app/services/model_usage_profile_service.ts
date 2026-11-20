import type { ModelRecommendationProfile } from '#services/model_catalog_contract'
import db from '@adonisjs/lucid/services/db'

type UsageSample = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

const fallbackProfile: ModelRecommendationProfile = {
  inputTokens: 50_000,
  outputTokens: 5_000,
  cacheReadTokens: 0,
  sampleCount: 0,
}

export default class ModelUsageProfileService {
  // Only stories keep their usage here: a quick chat's usage is in the
  // records of its engine session.
  async forUser(userId: string) {
    const rows = await usageRows(userId)
    const samples = rows
      .map((row) => usageSample(row.agent_usage))
      .filter((sample): sample is UsageSample => sample !== undefined)
    if (!samples.length) return fallbackProfile
    return {
      inputTokens: median(samples.map((sample) => sample.inputTokens)),
      outputTokens: median(samples.map((sample) => sample.outputTokens)),
      cacheReadTokens: median(samples.map((sample) => sample.cacheReadTokens)),
      sampleCount: samples.length,
    }
  }
}

function usageRows(userId: string) {
  return db
    .from('user_stories as source')
    .join('projects', 'projects.id', 'source.project_id')
    .where('projects.user_id', userId)
    .whereNotNull('source.agent_usage')
    .orderBy('source.updated_at', 'desc')
    .limit(100)
    .select('source.agent_usage')
}

function usageSample(value: unknown): UsageSample | undefined {
  const usage = parseUsage(value)
  if (!usage) return undefined
  const inputTokens = tokenValue(usage.totalInputTokens)
  const outputTokens = tokenValue(usage.totalOutputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: tokenValue(usage.totalCacheReadTokens) ?? 0,
  }
}

function parseUsage(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function tokenValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[middle]
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
