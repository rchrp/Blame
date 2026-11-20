import type { UserStoryAgentActivity } from '#models/user_story'
import UserStoryAgentRunActivity from '#models/user_story_agent_run_activity'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

type TerminalActivityPersistenceOptions = {
  client?: TransactionClientContract
  completedAt?: string
}

export async function persistUserStoryRunActivity(
  runId: string,
  activity: UserStoryAgentActivity,
  client?: TransactionClientContract
) {
  const existing = await UserStoryAgentRunActivity.query({ client })
    .where('runId', runId)
    .where('activityId', activity.id)
    .first()
  if (!existing) {
    return UserStoryAgentRunActivity.create(
      { runId, activityId: activity.id, activity },
      { client }
    )
  }
  existing.activity = activityWithDurableDetail(existing.activity, activity)
  return existing.save()
}

export async function userStoryRunActivity(runId: string, activityId: string) {
  const record = await UserStoryAgentRunActivity.query()
    .where('runId', runId)
    .where('activityId', activityId)
    .first()
  return record?.activity ?? undefined
}

export async function userStoryRunActivities(runIds: string[]) {
  if (!runIds.length) return []
  const records = await UserStoryAgentRunActivity.query().whereIn('runId', runIds)
  return records.flatMap((record) => (record.activity ? [record.activity] : []))
}

export function terminalAgentRunActivities(
  activities: UserStoryAgentActivity[],
  completedAt = new Date().toISOString()
) {
  return activities.map((activity) => {
    if (activity.status !== 'running') return activity
    return {
      ...activity,
      status: terminalActivityStatus(activity.kind),
      updatedAt: completedAt,
    }
  })
}

export function reconcileTerminalAgentRunActivities(
  activities: UserStoryAgentActivity[],
  persisted: UserStoryAgentActivity[],
  completedAt = new Date().toISOString()
) {
  return terminalAgentRunActivities(mergeActivities(activities, persisted), completedAt)
}

export async function persistTerminalUserStoryRunActivities(
  runId: string,
  activities: UserStoryAgentActivity[],
  options: TerminalActivityPersistenceOptions = {}
) {
  const persisted = await persistedUserStoryRunActivities(runId, options.client)
  const terminalActivities = reconcileTerminalAgentRunActivities(
    activities,
    persisted,
    options.completedAt
  )
  return persistActivities(terminalActivities, (activity) =>
    persistUserStoryRunActivity(runId, activity, options.client)
  )
}

async function persistActivities(
  activities: UserStoryAgentActivity[],
  persist: (activity: UserStoryAgentActivity) => Promise<unknown>
) {
  await Promise.all(activities.map(persist))
  return activities
}

async function persistedUserStoryRunActivities(runId: string, client?: TransactionClientContract) {
  const records = await UserStoryAgentRunActivity.query({ client })
    .where('runId', runId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
  return records.flatMap((record) => (record.activity ? [record.activity] : []))
}

function mergeActivities(
  activities: UserStoryAgentActivity[],
  persisted: UserStoryAgentActivity[]
) {
  const merged = [...activities, ...persisted].reduce((result, activity) => {
    const existing = result.get(activity.id)
    if (!existing || isNewerActivity(existing, activity)) result.set(activity.id, activity)
    return result
  }, new Map<string, UserStoryAgentActivity>())
  return [...merged.values()]
}

function isNewerActivity(existing: UserStoryAgentActivity, candidate: UserStoryAgentActivity) {
  const existingTimestamp = activityTimestamp(existing)
  const candidateTimestamp = activityTimestamp(candidate)
  if (candidateTimestamp !== existingTimestamp) return candidateTimestamp > existingTimestamp
  return existing.status === 'running' || candidate.status !== 'running'
}

function activityTimestamp(activity: UserStoryAgentActivity) {
  const timestamp = Date.parse(activity.updatedAt ?? activity.createdAt)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function terminalActivityStatus(kind: UserStoryAgentActivity['kind']) {
  return kind === 'tool' || kind === 'approval' || kind === 'error'
    ? ('failed' as const)
    : ('completed' as const)
}

function activityWithDurableDetail(
  existing: UserStoryAgentActivity | null,
  input: UserStoryAgentActivity
) {
  if (!existing?.detailArtifact || input.detailArtifact) return input
  return {
    ...input,
    detail: existing.detail,
    detailArtifact: existing.detailArtifact,
    detailTruncated: existing.detailTruncated,
    originalDetailLength: existing.originalDetailLength,
  }
}
