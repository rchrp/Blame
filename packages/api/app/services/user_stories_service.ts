import Project from '#models/project'
import UserStory, { type UserStoryAgentActivity, type UserStoryStatus } from '#models/user_story'
import UserStoryAgentRun from '#models/user_story_agent_run'
import UserStoryComment from '#models/user_story_comment'
import {
  putScreenshotArtifact,
  screenshotArtifact,
  type ScreenshotUpload,
} from '#services/agent_screenshot_artifacts'
import {
  activityWithArtifact,
  artifactDetail,
  deleteActivityArtifacts,
} from '#services/agent_activity_artifacts'
import {
  persistTerminalUserStoryRunActivities,
  persistUserStoryRunActivity,
  terminalAgentRunActivities,
  userStoryRunActivities,
  userStoryRunActivity,
} from '#services/agent_run_activity_log'
import ProjectsService from '#services/projects_service'
import { DateTime } from 'luxon'
import type { Infer } from '@vinejs/vine/types'
import type {
  createUserStoryAgentRunValidator,
  finalizeUserStoryAgentRunValidator,
  updateUserStoryAgentRunValidator,
} from '#validators/user_story_agent_run'
import type {
  createUserStoryValidator,
  listUserStoriesValidator,
  updateUserStoryValidator,
} from '#validators/user_story'
import type { createUserStoryCommentValidator } from '#validators/user_story_comment'
import db from '@adonisjs/lucid/services/db'
import { Exception } from '@adonisjs/core/exceptions'
import FileAttachmentsService from '#services/file_attachments_service'
import type FileAttachment from '#models/file_attachment'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import PreviewSessionService from '#services/preview_sessions/preview_session_service'
import {
  agentRunPersistenceUpdate,
  assertAgentRunStatusTransition,
  terminalAgentStatus,
} from '#services/agent_run_persistence'

type ListUserStoriesInput = Infer<typeof listUserStoriesValidator>
type CreateUserStoryInput = Infer<typeof createUserStoryValidator>
type UpdateUserStoryInput = Infer<typeof updateUserStoryValidator>
type CreateUserStoryCommentInput = Infer<typeof createUserStoryCommentValidator>
type CreateUserStoryAgentRunInput = Infer<typeof createUserStoryAgentRunValidator>
type FinalizeUserStoryAgentRunInput = Infer<typeof finalizeUserStoryAgentRunValidator>
type UpdateUserStoryAgentRunInput = Infer<typeof updateUserStoryAgentRunValidator>

const maxAgentActivities = 512
const agentRunSummaryColumns = [
  'id',
  'userStoryId',
  'commentId',
  'kind',
  'clineSessionId',
  'executionId',
  'lastSequenceNumber',
  'checkpointRunCount',
  'diffEndRef',
  'status',
  'completedAt',
  'createdAt',
  'updatedAt',
] as const

export default class UserStoriesService {
  private fileAttachments = new FileAttachmentsService()

  async list(userId: string, input: ListUserStoriesInput) {
    await new ProjectsService().findForUser(userId, input.projectId)
    const query = UserStory.query().where('projectId', input.projectId).orderBy('createdAt', 'asc')
    if (input.view === 'summary') {
      return query.preload('agentRuns', runningAgentRunSummaries)
    }
    const stories = await query
      .preload('storedFileAttachments')
      .preload('comments', (comments) => comments.preload('storedFileAttachments'))
      .preload('agentRuns', orderAgentRuns)
    stories.map(sortStoryComments)
    await this.prepareDownloads(stories)
    return stories
  }

  async find(userId: string, id: string) {
    const story = await this.userStoryQuery(userId)
      .where('id', id)
      .preload('storedFileAttachments')
      .preload('comments', (comments) => comments.preload('storedFileAttachments'))
      .preload('agentRuns', orderAgentRuns)
      .firstOrFail()
    sortStoryComments(story)
    await this.prepareDownloads([story])
    return story
  }

  async create(userId: string, input: CreateUserStoryInput) {
    if (input.projectId) {
      await new ProjectsService().findForUser(userId, input.projectId)
    }

    const attachments = await this.fileAttachments.resolveInputs(userId, input.fileAttachments)
    const storyId = await db.transaction(async (transaction) => {
      const storyNumber = await this.nextStoryNumber(userId, input.projectId, transaction)
      return this.createRecord(userId, input, storyNumber, attachments, transaction)
    })
    return this.find(userId, storyId)
  }

  async update(userId: string, id: string, input: UpdateUserStoryInput) {
    if (input.projectId) {
      await new ProjectsService().findForUser(userId, input.projectId)
    }

    const attachments =
      input.fileAttachments === undefined
        ? undefined
        : await this.fileAttachments.resolveInputs(userId, input.fileAttachments)
    await db.transaction(async (transaction) => {
      const userStory = await this.userStoryQuery(userId, transaction)
        .where('id', id)
        .forUpdate()
        .firstOrFail()
      const update = await this.updateInput(userStory, input)
      const storyNumber =
        input.projectId && input.projectId !== userStory.projectId
          ? await this.nextStoryNumber(userId, input.projectId, transaction)
          : userStory.storyNumber
      await cancelActiveAgentRun(userStory, input, transaction)
      userStory.useTransaction(transaction)
      userStory.merge({
        ...update,
        storyNumber,
        ...inactiveAgentRunUpdate(input),
        mergedAt: input.mergedAt === undefined ? userStory.mergedAt : input.mergedAt,
      })
      await userStory.save()
      if (attachments !== undefined) {
        await this.fileAttachments.syncOwner(
          userId,
          'userStory',
          userStory.id,
          attachments,
          transaction
        )
      }
    })
    return this.find(userId, id)
  }

  async createComment(userId: string, id: string, input: CreateUserStoryCommentInput) {
    await this.find(userId, id)
    const attachments = await this.fileAttachments.resolveInputs(userId, input.fileAttachments)
    const commentId = await db.transaction(async (transaction) => {
      const comment = await UserStoryComment.create(
        {
          author: 'Product',
          body: input.body,
          codeSelectionAttachments: input.codeSelectionAttachments ?? null,
          legacyFileAttachments: null,
          userStoryId: id,
        },
        { client: transaction }
      )
      await this.fileAttachments.syncOwner(
        userId,
        'userStoryComment',
        comment.id,
        attachments,
        transaction
      )
      return comment.id
    })
    return this.commentForDelivery(commentId)
  }

  async undoComment(
    userId: string,
    id: string,
    commentId: string,
    runId: string,
    clineSessionId?: string
  ) {
    await db.transaction(async (transaction) => {
      const story = await UserStory.query({ client: transaction })
        .whereIn(
          'projectId',
          Project.query({ client: transaction }).select('id').where('userId', userId)
        )
        .where('id', id)
        .preload('comments')
        .preload('agentRuns', orderAgentRuns)
        .forUpdate()
        .firstOrFail()
      sortStoryComments(story)
      const { comment, targetRun } = assertStoryUndoTarget(story, commentId, runId)
      const deletedCommentIds = new Set(
        story.comments.filter((item) => sameOrAfter(item, comment)).map((item) => item.id)
      )
      const deletedRunIds = new Set(
        story.agentRuns.slice(story.agentRuns.indexOf(targetRun)).map((run) => run.id)
      )
      await this.fileAttachments.markOwnersDetached(
        'userStoryComment',
        [...deletedCommentIds],
        transaction
      )
      await deleteStoryRuns(story.id, [...deletedRunIds], transaction)
      await deleteStoryComments(story.id, [...deletedCommentIds], transaction)
      const remainingRuns = story.agentRuns.filter((run) => !deletedRunIds.has(run.id))
      story.useTransaction(transaction)
      story.merge(storyUndoUpdate(remainingRuns, story.status, clineSessionId))
      await story.save()
    })
    return this.find(userId, id)
  }

  async validateCommentUndo(userId: string, id: string, commentId: string, runId: string) {
    assertStoryUndoTarget(await this.find(userId, id), commentId, runId)
  }

  async activityDetail(userId: string, id: string, activityId: string) {
    const story = await this.find(userId, id)
    const activity = story.agentActivities?.find((item) => item.id === activityId)
    if (!activity) throw new Error('Agent activity not found.')
    if (!activity.detailArtifact) return { detail: activity.detail }
    return { detail: await artifactDetail(story.id, story.worktree, activity) }
  }

  async createAgentRun(userId: string, id: string, input: CreateUserStoryAgentRunInput) {
    return db.transaction((transaction) =>
      this.createAgentRunRecord(userId, id, input, transaction)
    )
  }

  async updateAgentRun(
    userId: string,
    id: string,
    runId: string,
    input: UpdateUserStoryAgentRunInput
  ) {
    return db.transaction(async (transaction) => {
      const story = await this.lockedStory(userId, id, transaction)
      const run = await lockedAgentRun(story.id, runId, transaction)
      const persistence = agentRunPersistenceUpdate(run, input.persistenceEvent)
      if (persistence === undefined) return run
      const update = await this.agentRunUpdateInput(story, run, input, transaction)
      run.merge(monotonicAgentRunUpdate(run, { ...update, ...persistence }))
      await closeTerminalStoryRunActivities(run, transaction)
      await run.save()
      return run
    })
  }

  async finalizeAgentRun(
    userId: string,
    id: string,
    runId: string,
    input: FinalizeUserStoryAgentRunInput
  ) {
    await db.transaction((transaction) =>
      this.finalizeAgentRunRecord(userId, id, runId, input, transaction)
    )
    return this.find(userId, id)
  }

  async agentRunActivityDetail(userId: string, id: string, runId: string, activityId: string) {
    const story = await this.find(userId, id)
    const run = await this.agentRunQuery(story, runId)
    const activity =
      run.activities?.find((item) => item.id === activityId) ??
      (await userStoryRunActivity(run.id, activityId))
    if (!activity) throw new Error('Agent activity not found.')
    if (!activity.detailArtifact) return { detail: activity.detail }
    return { detail: await artifactDetail(story.id, story.worktree, activity) }
  }

  async storeAgentScreenshot(
    userId: string,
    id: string,
    screenshotId: string,
    input: ScreenshotUpload
  ) {
    const owner = await this.userStoryQuery(userId).where('id', id).firstOrFail()
    return putScreenshotArtifact(owner.id, screenshotId, input)
  }

  async agentScreenshot(userId: string, id: string, screenshotId: string, sessionId?: string) {
    const owner = await this.userStoryQuery(userId).where('id', id).firstOrFail()
    return screenshotArtifact(owner.id, screenshotId, sessionId)
  }

  async delete(userId: string, id: string) {
    const userStory = await this.find(userId, id)
    const loggedActivities = await userStoryRunActivities(userStory.agentRuns.map((run) => run.id))
    await new PreviewSessionService().destroyForUserStory(userId, userStory.id)
    const activityGroups = [
      userStory.agentActivities,
      loggedActivities,
      ...userStory.agentRuns.map((run) => run.activities),
    ]
    await db.transaction(async (transaction) => {
      await this.fileAttachments.markOwnersDetached('userStory', [userStory.id], transaction)
      await this.fileAttachments.markOwnersDetached(
        'userStoryComment',
        userStory.comments.map((comment) => comment.id),
        transaction
      )
      userStory.useTransaction(transaction)
      await userStory.delete()
    })
    await deleteActivityArtifacts(userStory.id, activityGroups)
  }

  private userStoryQuery(userId: string, client?: Parameters<UserStory['useTransaction']>[0]) {
    return UserStory.query({ client }).whereIn(
      'projectId',
      Project.query({ client }).select('id').where('userId', userId)
    )
  }

  private async updateInput(userStory: UserStory, input: UpdateUserStoryInput) {
    const { agentActivity, agentActivityUpdates, fileAttachments, ...update } = input
    void fileAttachments
    const prepared = await Promise.all(
      requestedActivities(agentActivity, agentActivityUpdates).map((activity) =>
        activityWithArtifact(userStory.id, userStory.clineSessionId, activity)
      )
    )
    const activities = userStory.activeAgentRunId ? prepared : terminalAgentRunActivities(prepared)
    if (!activities.length) return update
    return {
      ...update,
      agentActivities: activities.reduce(upsertActivity, userStory.agentActivities ?? []),
    }
  }

  private async nextStoryNumber(
    userId: string,
    projectId: string,
    transaction: TransactionClientContract
  ) {
    // Lock the project even when it has no stories. Deleting a story never
    // lowers this counter, and concurrent creates reserve distinct numbers.
    const project = await Project.query({ client: transaction })
      .where('id', projectId)
      .where('userId', userId)
      .forUpdate()
      .firstOrFail()
    project.lastStoryNumber += 1
    await project.save()
    return project.lastStoryNumber
  }

  private async createRecord(
    userId: string,
    input: CreateUserStoryInput,
    storyNumber: number,
    attachments: FileAttachment[],
    transaction: TransactionClientContract
  ) {
    const userStory = await UserStory.create(userStoryCreateAttributes(input, storyNumber), {
      client: transaction,
    })
    await this.fileAttachments.syncOwner(
      userId,
      'userStory',
      userStory.id,
      attachments,
      transaction
    )
    return userStory.id
  }

  private async commentForDelivery(id: string) {
    const comment = await UserStoryComment.query()
      .where('id', id)
      .preload('storedFileAttachments')
      .firstOrFail()
    await this.fileAttachments.prepareDownloads(storedAttachments(comment))
    return comment
  }

  private async prepareDownloads(stories: UserStory[]) {
    const attachments = stories.flatMap((story) => [
      ...storedAttachments(story),
      ...story.comments.flatMap(storedAttachments),
    ])
    await this.fileAttachments.prepareDownloads(uniqueAttachments(attachments))
  }

  private agentRunQuery(story: UserStory, runId: string) {
    return UserStoryAgentRun.query().where('userStoryId', story.id).where('id', runId).firstOrFail()
  }

  private async createAgentRunRecord(
    userId: string,
    id: string,
    input: CreateUserStoryAgentRunInput,
    transaction: TransactionClientContract
  ) {
    const story = await this.lockedStory(userId, id, transaction)
    await assertRunComment(story.id, input.commentId, transaction)
    const run = await UserStoryAgentRun.create(agentRunAttributes(story.id, input), {
      client: transaction,
    })
    if (run.status === 'running') {
      story.merge(activeAgentRunStoryUpdate(run))
      await story.save()
    }
    return run
  }

  private async finalizeAgentRunRecord(
    userId: string,
    id: string,
    runId: string,
    input: FinalizeUserStoryAgentRunInput,
    transaction: TransactionClientContract
  ) {
    const story = await this.lockedStory(userId, id, transaction)
    const run = await lockedAgentRun(story.id, runId, transaction)
    const persistence = agentRunPersistenceUpdate(run, input.persistenceEvent)
    if (persistence === undefined) return
    assertAgentRunStatusTransition(run.status, input.status)
    if (terminalStatus(run.status)) {
      await persistAlreadyTerminalStoryRun(story, run, input, persistence, transaction)
      return
    }
    const activities = await this.preparedRunActivities(story, run, input.activities)
    const finalActivities = finalResponseActivities(run, activities, input.finalResponse)
    run.merge({ ...finalAgentRunUpdate(run, input, finalActivities), ...persistence })
    await closeTerminalStoryRunActivities(run, transaction)
    await run.save()
    if (story.activeAgentRunId !== run.id) return
    story.merge(finalAgentRunStoryUpdate(run, input))
    await story.save()
  }

  private lockedStory(userId: string, id: string, transaction: TransactionClientContract) {
    return this.userStoryQuery(userId, transaction).where('id', id).forUpdate().firstOrFail()
  }

  private preparedRunActivities(
    story: UserStory,
    run: UserStoryAgentRun,
    activities: UserStoryAgentActivity[]
  ) {
    return Promise.all(
      activities.map((activity) =>
        activityWithArtifact(story.id, run.clineSessionId, activity, run.id)
      )
    )
  }

  private async agentRunUpdateInput(
    story: UserStory,
    run: UserStoryAgentRun,
    input: UpdateUserStoryAgentRunInput,
    transaction: TransactionClientContract
  ) {
    const { agentActivity, agentActivityUpdates, persistenceEvent, ...update } = input
    void persistenceEvent
    const nextUpdate = {
      ...update,
      ...agentRunCompletedAtUpdate(update),
    }
    const prepared = await Promise.all(
      requestedActivities(agentActivity, agentActivityUpdates).map((activity) =>
        activityWithArtifact(story.id, run.clineSessionId, activity, run.id)
      )
    )
    const activities = terminalStatus(run.status) ? terminalAgentRunActivities(prepared) : prepared
    if (!activities.length) return nextUpdate
    await Promise.all(
      activities.map((activity) => persistUserStoryRunActivity(run.id, activity, transaction))
    )
    return {
      ...nextUpdate,
      activities: activities.reduce(upsertActivity, run.activities ?? []),
    }
  }
}

async function persistAlreadyTerminalStoryRun(
  story: UserStory,
  run: UserStoryAgentRun,
  input: FinalizeUserStoryAgentRunInput,
  persistence: NonNullable<ReturnType<typeof agentRunPersistenceUpdate>>,
  transaction: TransactionClientContract
) {
  run.merge(persistence)
  await closeTerminalStoryRunActivities(run, transaction)
  await run.save()
  if (story.activeAgentRunId !== run.id) return
  story.merge(finalAgentRunStoryUpdate(run, input))
  await story.save()
}

function storedAttachments(owner: UserStory | UserStoryComment): FileAttachment[] {
  return (owner.$preloaded.storedFileAttachments as FileAttachment[] | undefined) ?? []
}

function uniqueAttachments(attachments: FileAttachment[]) {
  return [...new Map(attachments.map((attachment) => [attachment.id, attachment])).values()]
}

function userStoryCreateAttributes(input: CreateUserStoryInput, storyNumber: number) {
  const { agentActivity, fileAttachments, fileAttachmentUploadPending, ...attributes } = input
  void agentActivity
  void fileAttachments
  return {
    ...attributes,
    ...nullableStoryAttributes(input),
    codeSelectionAttachments: input.codeSelectionAttachments ?? null,
    fileAttachmentUploadPending: fileAttachmentUploadPending ?? false,
    legacyFileAttachments: null,
    owner: input.owner ?? 'Product',
    priority: input.priority ?? 'Medium',
    status: input.status ?? 'backlog',
    storyNumber,
  }
}

function nullableStoryAttributes(input: CreateUserStoryInput) {
  return {
    agentActivities: input.agentActivities ?? null,
    agentFinalResponse: input.agentFinalResponse ?? null,
    agentLastError: input.agentLastError ?? null,
    agentLastEvent: input.agentLastEvent ?? null,
    agentModelId: input.agentModelId ?? null,
    agentProviderId: input.agentProviderId ?? null,
    agentSessionSummary: input.agentSessionSummary ?? null,
    agentStatus: input.agentStatus ?? null,
    agentUsage: input.agentUsage ?? null,
    baseCommit: input.baseCommit ?? null,
    branch: input.branch ?? null,
    clineSessionId: input.clineSessionId ?? null,
    discardedReason: input.discardedReason ?? null,
    mergeCommit: input.mergeCommit ?? null,
    mergedAt: input.mergedAt ?? null,
    previewUrl: input.previewUrl ?? null,
    runConfigurationId: input.runConfigurationId ?? null,
    worktree: input.worktree ?? null,
    workspaceMode: input.workspaceMode ?? null,
    runMode: input.runMode ?? null,
  }
}

function assertStoryUndoTarget(story: UserStory, commentId: string, runId: string) {
  const comment = story.comments.find((item) => item.id === commentId)
  if (!comment) throw new Error('User story comment not found.')
  const targetRun = story.agentRuns.find((run) => run.id === runId)
  if (!targetRun || targetRun.commentId !== comment.id) {
    throw new Exception('Agent run does not belong to this user story comment.', {
      code: 'E_USER_STORY_UNDO_RUN_MISMATCH',
      status: 409,
    })
  }
  return { comment, targetRun }
}

function upsertActivity(activities: UserStoryAgentActivity[], input: UserStoryAgentActivity) {
  const exists = activities.some((activity) => activity.id === input.id)
  const next = exists
    ? activities.map((activity) => (activity.id === input.id ? input : activity))
    : [...activities, input]
  return next.slice(Math.max(0, next.length - maxAgentActivities))
}

function requestedActivities(
  activity: UserStoryAgentActivity | null | undefined,
  updates: UserStoryAgentActivity[] | undefined
) {
  return updates ?? (activity ? [activity] : [])
}

function terminalStatus(status: string | undefined) {
  return terminalAgentStatus(status)
}

function inactiveAgentRunUpdate(input: UpdateUserStoryInput) {
  if (input.status === undefined || input.status === 'in-progress') return {}
  return { activeAgentRunId: null, agentStatus: null }
}

async function cancelActiveAgentRun(
  story: UserStory,
  input: UpdateUserStoryInput,
  transaction: TransactionClientContract
) {
  if (!story.activeAgentRunId || input.status === undefined || input.status === 'in-progress')
    return
  const run = await UserStoryAgentRun.query({ client: transaction })
    .where('userStoryId', story.id)
    .where('id', story.activeAgentRunId)
    .forUpdate()
    .first()
  if (!run) return
  const terminal = terminalStatus(run.status)
  const completedAt = run.completedAt ?? DateTime.now()
  const completedAtIso = completedAt.toISO() ?? undefined
  story.agentActivities = terminalAgentRunActivities(story.agentActivities ?? [], completedAtIso)
  run.merge({
    ...(terminal ? {} : { status: 'cancelled' as const, completedAt }),
  })
  await closeTerminalStoryRunActivities(run, transaction)
  await run.save()
}

async function closeTerminalStoryRunActivities(
  run: UserStoryAgentRun,
  transaction: TransactionClientContract
) {
  if (!terminalStatus(run.status)) return
  const completedAt = run.completedAt ?? DateTime.now()
  const activities = await persistTerminalUserStoryRunActivities(run.id, run.activities ?? [], {
    client: transaction,
    completedAt: completedAt.toISO() ?? undefined,
  })
  run.merge({ activities: activities.reduce(upsertActivity, []), completedAt })
}

function agentRunAttributes(storyId: string, input: CreateUserStoryAgentRunInput) {
  return {
    activities: [],
    checkpointRunCount: input.checkpointRunCount ?? null,
    clineSessionId: input.clineSessionId ?? null,
    commentId: input.commentId ?? null,
    diffEndRef: null,
    executionId: input.executionId ?? null,
    finalResponse: null,
    kind: input.kind,
    modelId: input.modelId ?? null,
    providerId: input.providerId ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    sessionSummary: null,
    status: input.status ?? ('running' as const),
    usage: null,
    userStoryId: storyId,
  }
}

function activeAgentRunStoryUpdate(run: UserStoryAgentRun): Partial<UserStory> {
  return {
    activeAgentRunId: run.id,
    agentActivities: [],
    agentFinalResponse: null,
    agentStatus: 'Running',
    agentUsage: null,
    clineSessionId: run.clineSessionId,
    status: 'in-progress',
  }
}

async function assertRunComment(
  storyId: string,
  commentId: string | null | undefined,
  transaction: TransactionClientContract
) {
  if (!commentId) return
  const comment = await UserStoryComment.query({ client: transaction })
    .where('userStoryId', storyId)
    .where('id', commentId)
    .first()
  if (!comment) throw new Error('User story comment not found.')
}

function finalAgentRunUpdate(
  run: UserStoryAgentRun,
  input: FinalizeUserStoryAgentRunInput,
  activities: UserStoryAgentActivity[]
): Partial<UserStoryAgentRun> {
  const { agentLastError, agentLastEvent, outcome, persistenceEvent, ...metadata } = input
  void agentLastError
  void agentLastEvent
  void outcome
  void persistenceEvent
  return {
    ...metadata,
    activities: activities.reduce(upsertActivity, run.activities ?? []),
    completedAt: input.completedAt ?? DateTime.now(),
  }
}

function finalResponseActivities(
  run: UserStoryAgentRun,
  updates: UserStoryAgentActivity[],
  response: string | null | undefined
) {
  const activities = updates.reduce(upsertActivity, run.activities ?? [])
  const finalResponse = response?.trim()
  if (!finalResponse || activities.some((activity) => activity.kind === 'message')) {
    return activities
  }
  return [
    ...activities,
    {
      createdAt: (run.completedAt ?? DateTime.now()).toISO() ?? new Date().toISOString(),
      detail: finalResponse,
      id: 'message-final',
      kind: 'message' as const,
      messageKind: 'final' as const,
      status: 'completed' as const,
      title: 'Agent response',
    },
  ]
}

function finalAgentRunStoryUpdate(
  run: UserStoryAgentRun,
  input: FinalizeUserStoryAgentRunInput
): Partial<UserStory> {
  const review = input.outcome === 'review'
  return {
    activeAgentRunId: null,
    agentActivities: run.activities,
    agentFinalResponse: run.finalResponse,
    agentLastError: input.agentLastError,
    agentLastEvent: input.agentLastEvent,
    agentSessionSummary: run.sessionSummary,
    agentStatus: review ? null : 'Paused',
    agentUsage: run.usage,
    status: review ? 'in-review' : 'in-progress',
  }
}

function lockedAgentRun(storyId: string, runId: string, transaction: TransactionClientContract) {
  return UserStoryAgentRun.query({ client: transaction })
    .where('userStoryId', storyId)
    .where('id', runId)
    .forUpdate()
    .firstOrFail()
}

function monotonicAgentRunUpdate(run: UserStoryAgentRun, update: Partial<UserStoryAgentRun>) {
  assertAgentRunStatusTransition(run.status, update.status)
  if (!terminalStatus(run.status)) return update
  const { completedAt, status, ...metadata } = update
  void completedAt
  void status
  return metadata
}

function agentRunCompletedAtUpdate(input: { completedAt?: DateTime | null; status?: string }) {
  if (input.completedAt !== undefined) return { completedAt: input.completedAt }
  if (terminalStatus(input.status)) return { completedAt: DateTime.now() }
  return {}
}

export function runningAgentRunSummaries(query: ReturnType<typeof UserStoryAgentRun.query>) {
  query.select([...agentRunSummaryColumns]).where('status', 'running')
  orderAgentRuns(query)
}

function orderAgentRuns(query: ReturnType<typeof UserStoryAgentRun.query>) {
  return query.orderBy('userStoryId', 'asc').orderBy('createdAt', 'asc').orderBy('id', 'asc')
}

function sortStoryComments<T extends UserStory>(story: T) {
  story.comments?.sort(compareComments)
  return story
}

function compareComments(left: UserStoryComment, right: UserStoryComment) {
  const createdAtDelta = left.createdAt.toMillis() - right.createdAt.toMillis()
  return createdAtDelta || left.id.localeCompare(right.id)
}

async function deleteStoryRuns(
  storyId: string,
  ids: string[],
  client?: Parameters<UserStoryAgentRun['useTransaction']>[0]
) {
  if (!ids.length) return
  await UserStoryAgentRun.query({ client })
    .where('userStoryId', storyId)
    .whereIn('id', ids)
    .delete()
}

async function deleteStoryComments(
  storyId: string,
  ids: string[],
  client?: Parameters<UserStoryComment['useTransaction']>[0]
) {
  if (!ids.length) return
  await UserStoryComment.query({ client }).where('userStoryId', storyId).whereIn('id', ids).delete()
}

function storyUndoUpdate(
  remainingRuns: UserStoryAgentRun[],
  currentStatus: UserStoryStatus,
  clineSessionId?: string
): Partial<UserStory> {
  const lastRun = remainingRuns.at(-1)
  return {
    activeAgentRunId: lastRun?.status === 'running' ? lastRun.id : null,
    agentActivities: lastRun?.activities ?? [],
    agentFinalResponse: lastRun?.finalResponse ?? null,
    agentLastError: null,
    agentLastEvent: lastRun ? agentRunLastEvent(lastRun) : null,
    agentSessionSummary: lastRun?.sessionSummary ?? null,
    agentStatus: null,
    agentUsage: lastRun?.usage ?? null,
    clineSessionId: clineSessionId ?? lastRun?.clineSessionId ?? null,
    status: storyStatusAfterUndo(lastRun, currentStatus),
  }
}

function storyStatusAfterUndo(
  lastRun: UserStoryAgentRun | undefined,
  currentStatus: UserStoryStatus
): UserStoryStatus {
  if (!lastRun) return 'backlog'
  if (lastRun.status === 'running') return 'in-progress'
  if (currentStatus === 'done') return 'in-review'
  if (currentStatus === 'discarded') return 'backlog'
  if (currentStatus === 'backlog' || currentStatus === 'ready') return currentStatus
  return 'in-review'
}

function agentRunLastEvent(run: UserStoryAgentRun) {
  if (run.status === 'failed') return run.finalResponse ?? 'Agent run failed.'
  if (run.status === 'cancelled') return run.finalResponse ?? 'Agent run cancelled.'
  if (run.status === 'running') return 'Agent is running.'
  return run.finalResponse ?? 'Agent run completed.'
}

function sameOrAfter<T extends { createdAt: DateTime; id: string }>(item: T, target: T) {
  const delta = item.createdAt.toMillis() - target.createdAt.toMillis()
  return delta > 0 || (delta === 0 && item.id.localeCompare(target.id) >= 0)
}
