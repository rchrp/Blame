// How full the agent's context is, from the last request it sent: the
// cached part it reused, the new part, and what is left.

export type StoryContextUsage = {
  cached: number
  fresh: number
  free: number
  limit: number
  used: number
  // 0 to 1.
  ratio: number
}

type TurnUsage = {
  cacheReadTokens?: number
  cacheWriteTokens?: number
  inputTokens?: number
}

export function storyContextUsage(
  usage: TurnUsage | null | undefined,
  limit: number | undefined
): StoryContextUsage | undefined {
  if (!usage || !limit || limit <= 0) return undefined
  const input = usage.inputTokens ?? 0
  const cached = usage.cacheReadTokens ?? 0
  const written = usage.cacheWriteTokens ?? 0
  // Some providers count cached tokens inside the input, others beside it:
  // when adding them up overflows the window, the input already holds them.
  const separate = input + cached + written
  const used = separate > limit && input <= limit ? input : separate
  if (used <= 0) return undefined
  const clamped = Math.min(used, limit)
  const cachedPart = Math.min(cached, clamped)
  return {
    cached: cachedPart,
    fresh: clamped - cachedPart,
    free: limit - clamped,
    limit,
    used: clamped,
    ratio: clamped / limit,
  }
}

// 1.2M, 94k, 812.
export function compactTokens(value: number) {
  if (value >= 999_500)
    return `${trimZero((value / 1_000_000).toFixed(value >= 9_950_000 ? 0 : 1))}M`
  if (value >= 1_000)
    return `${trimZero((value / 1_000).toFixed(value >= 9_950 ? 0 : 1))}k`
  return String(Math.round(value))
}

function trimZero(value: string) {
  return value.replace(/\.0$/, "")
}
