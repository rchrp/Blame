// The `/` picker of the composers: typing `/` at the start of a message lists
// the skills the user may start (Claude Code's skills, commands and Blame's
// own), and picking one writes `/name ` for the agent, which runs that skill
// with what follows as its arguments.

export type SkillMention = {
  active: boolean
  query: string
  start: number
  end: number
}

export type SkillMentionItem = {
  name: string
  description?: string
  argumentHint?: string
}

const inactive: SkillMention = { active: false, query: "", start: 0, end: 0 }

/** A `/query` that is the start of the message and has no space yet. */
export function skillMentionState(value: string, cursor: number): SkillMention {
  const match = /^\/([^\s/]*)$/.exec(value.slice(0, cursor))
  return match
    ? { active: true, query: match[1] ?? "", start: 0, end: cursor }
    : inactive
}

/** The skills whose name or description fits the query, names first. */
export function matchingSkills(
  items: readonly SkillMentionItem[],
  query: string,
  limit = 50
) {
  const needle = query.toLowerCase()
  if (!needle) return items.slice(0, limit)
  const rank = (item: SkillMentionItem) => {
    const name = item.name.toLowerCase()
    if (name.startsWith(needle)) return 0
    if (name.split(/[:\s_-]/u).some((word) => word.startsWith(needle))) return 1
    if (name.includes(needle)) return 2
    return item.description?.toLowerCase().includes(needle) ? 3 : undefined
  }
  return items
    .map((item) => ({ item, rank: rank(item) }))
    .filter(
      (entry): entry is { item: SkillMentionItem; rank: number } =>
        entry.rank !== undefined
    )
    .sort((left, right) => left.rank - right.rank)
    .slice(0, limit)
    .map((entry) => entry.item)
}

/** What the picker writes: the skill's name and a space for its arguments. */
export function skillInvocation(item: SkillMentionItem) {
  return `/${item.name} `
}

// One list per workspace for a few seconds: each keystroke of the query
// filters it, and only the first asks the desktop.
const cache = new Map<
  string,
  { at: number; items: Promise<SkillMentionItem[]> }
>()
const cacheMs = 15_000

export function workspaceSkills(
  root: string,
  load: () => Promise<SkillMentionItem[]>
) {
  const cached = cache.get(root)
  if (cached && Date.now() - cached.at < cacheMs) return cached.items
  const items = load()
  cache.set(root, { at: Date.now(), items })
  items.catch(() => cache.delete(root))
  return items
}
