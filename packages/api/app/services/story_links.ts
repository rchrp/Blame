import Epic from '#models/epic'
import UserStory from '#models/user_story'
import { Exception } from '@adonisjs/core/exceptions'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'

type StoryLinks = {
  projectId: string
  /** The story being updated; absent for a story being created, which no one waits for yet. */
  storyId?: string
  targetBranch: string | null
  /** The list to check; leave it out to check the epic alone. */
  startsAfter?: string[]
  /** The epic to check; `undefined` leaves it out. */
  epicId?: string | null
}

/** The ids of a list once each, in the order given. */
export function distinctIds(ids: string[]) {
  return [...new Set(ids)]
}

/**
 * Refuses the links of a story that break the rules of the board, with a 422
 * that names the story or epic at fault: a story it waits for must be a
 * story of the same project, not itself, on the same target branch, and
 * waiting must not close a cycle; its epic must be one of the same project.
 */
export async function assertStoryLinks(client: QueryClientContract, links: StoryLinks) {
  if (links.epicId) await assertEpic(client, links.projectId, links.epicId)
  if (links.startsAfter?.length) await assertDependencies(client, links, links.startsAfter)
}

async function assertEpic(client: QueryClientContract, projectId: string, epicId: string) {
  const epic = await Epic.query({ client })
    .where('id', epicId)
    .where('projectId', projectId)
    .first()
  if (!epic) invalid('E_STORY_EPIC_INVALID', `Epic ${epicId} is not an epic of this project`)
}

async function assertDependencies(
  client: QueryClientContract,
  links: StoryLinks,
  startsAfter: string[]
) {
  if (links.storyId && startsAfter.includes(links.storyId)) {
    invalid('E_STORY_DEPENDENCY_INVALID', `Story ${links.storyId} cannot start after itself`)
  }
  const stories = await UserStory.query({ client })
    .where('projectId', links.projectId)
    .select('id', 'targetBranch', 'startsAfter')
  const known = new Map(stories.map((story) => [story.id, story]))
  for (const id of startsAfter) {
    const dependency = known.get(id)
    if (!dependency) {
      invalid('E_STORY_DEPENDENCY_INVALID', `Story ${id} is not a story of this project`)
    }
    if ((dependency.targetBranch ?? null) !== links.targetBranch) {
      invalid(
        'E_STORY_DEPENDENCY_INVALID',
        `Story ${id} has a different target branch than this story`
      )
    }
  }
  if (!links.storyId) return
  // A cycle closes when a story this one waits for already waits, directly or
  // through others, for this one: name that story.
  for (const id of startsAfter) {
    if (waitsFor(known, id, links.storyId)) {
      invalid(
        'E_STORY_DEPENDENCY_INVALID',
        `Story ${id} already waits for this story: waiting for it would close a cycle`
      )
    }
  }
}

/** Whether `from` waits for `target`, directly or through the stories it waits for. */
function waitsFor(stories: Map<string, UserStory>, from: string, target: string) {
  const seen = new Set<string>()
  const pending = [from]
  while (pending.length) {
    const id = pending.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of stories.get(id)?.startsAfter ?? []) {
      if (next === target) return true
      pending.push(next)
    }
  }
  return false
}

function invalid(code: string, message: string): never {
  throw new Exception(message, { status: 422, code })
}
