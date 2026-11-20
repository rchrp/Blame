import EngineLogException from '#lib/engine/engine_log_exception'
import EngineSession from '#models/engine_session'
import Project from '#models/project'
import UserStory from '#models/user_story'
import {
  putScreenshotArtifact,
  screenshotArtifact,
  type ScreenshotUpload,
} from '#services/agent_screenshot_artifacts'
import EngineSessionsService from '#services/engine_sessions_service'
import ProjectsService from '#services/projects_service'
import type { Infer } from '@vinejs/vine/types'
import type {
  createUserStoryValidator,
  listUserStoriesValidator,
  updateUserStoryValidator,
} from '#validators/user_story'
import db from '@adonisjs/lucid/services/db'
import FileAttachmentsService from '#services/file_attachments_service'
import type FileAttachment from '#models/file_attachment'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import PreviewSessionService from '#services/preview_sessions/preview_session_service'

type ListUserStoriesInput = Infer<typeof listUserStoriesValidator>
type CreateUserStoryInput = Infer<typeof createUserStoryValidator>
type UpdateUserStoryInput = Infer<typeof updateUserStoryValidator>

/**
 * Development stories of the user's projects. A story keeps its product
 * state; its conversation is the story's engine session, which the engine
 * pushes on its own and which the story only names.
 */
export default class UserStoriesService {
  private fileAttachments = new FileAttachmentsService()

  async list(userId: string, input: ListUserStoriesInput) {
    await new ProjectsService().findForUser(userId, input.projectId)
    const query = UserStory.query().where('projectId', input.projectId).orderBy('createdAt', 'asc')
    if (input.view === 'summary') return query
    const stories = await query.preload('storedFileAttachments')
    await this.prepareDownloads(stories)
    return stories
  }

  async find(userId: string, id: string) {
    const story = await this.userStoryQuery(userId)
      .where('id', id)
      .preload('storedFileAttachments')
      .firstOrFail()
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
    if (input.engineSessionId) await assertSessionNotForeign(userId, input.engineSessionId)

    const { fileAttachments, ...update } = input
    const attachments =
      fileAttachments === undefined
        ? undefined
        : await this.fileAttachments.resolveInputs(userId, fileAttachments)
    await db.transaction(async (transaction) => {
      const userStory = await this.userStoryQuery(userId, transaction)
        .where('id', id)
        .forUpdate()
        .firstOrFail()
      const storyNumber =
        input.projectId && input.projectId !== userStory.projectId
          ? await this.nextStoryNumber(userId, input.projectId, transaction)
          : userStory.storyNumber
      userStory.useTransaction(transaction)
      userStory.merge({
        ...update,
        storyNumber,
        ...idleAgentUpdate(input),
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

  /** Deletes the story with its previews and its conversation, the engine session. */
  async delete(userId: string, id: string) {
    const userStory = await this.userStoryQuery(userId).where('id', id).firstOrFail()
    await new PreviewSessionService().destroyForUserStory(userId, userStory.id)
    // The session goes before the story, so a failure leaves the story to
    // delete again instead of a session nothing points to.
    if (userStory.engineSessionId) await destroySession(userId, userStory.engineSessionId)
    await db.transaction(async (transaction) => {
      await this.fileAttachments.markOwnersDetached('userStory', [userStory.id], transaction)
      userStory.useTransaction(transaction)
      await userStory.delete()
    })
  }

  private userStoryQuery(userId: string, client?: Parameters<UserStory['useTransaction']>[0]) {
    return UserStory.query({ client }).whereIn(
      'projectId',
      Project.query({ client }).select('id').where('userId', userId)
    )
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

  private async prepareDownloads(stories: UserStory[]) {
    await this.fileAttachments.prepareDownloads(stories.flatMap(storedAttachments))
  }
}

function storedAttachments(story: UserStory): FileAttachment[] {
  return (story.$preloaded.storedFileAttachments as FileAttachment[] | undefined) ?? []
}

function userStoryCreateAttributes(input: CreateUserStoryInput, storyNumber: number) {
  const { fileAttachments, fileAttachmentUploadPending, ...attributes } = input
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
    agentLastError: input.agentLastError ?? null,
    agentModels: input.agentModels ?? null,
    agentStatus: input.agentStatus ?? null,
    baseCommit: input.baseCommit ?? null,
    branch: input.branch ?? null,
    targetBranch: input.targetBranch ?? null,
    discardedReason: input.discardedReason ?? null,
    mergeCommit: input.mergeCommit ?? null,
    mergedAt: input.mergedAt ?? null,
    previewUrl: input.previewUrl ?? null,
    runConfigurationId: input.runConfigurationId ?? null,
    worktree: input.worktree ?? null,
    workspaceMode: input.workspaceMode ?? null,
    runMode: input.runMode ?? null,
    ambition: input.ambition ?? null,
  }
}

// An agent only runs or pauses on a story in progress.
function idleAgentUpdate(input: UpdateUserStoryInput) {
  if (input.status === undefined || input.status === 'in-progress') return {}
  return { agentStatus: null }
}

/** The engine may push a session before the story names it: someone else's is not the story's. */
async function assertSessionNotForeign(userId: string, sessionId: string) {
  const session = await EngineSession.find(sessionId)
  if (session && session.userId !== userId) {
    throw new EngineLogException(
      'E_ENGINE_SESSION_FORBIDDEN',
      'This session belongs to another account',
      403
    )
  }
}

async function destroySession(userId: string, sessionId: string) {
  try {
    await new EngineSessionsService().destroy(userId, sessionId)
  } catch (error) {
    // A session never pushed has no row, and one another account pushed under
    // the same id is not this story's: either way there is nothing to delete.
    if (
      error instanceof EngineLogException &&
      (error.engineCode === 'E_ENGINE_SESSION_NOT_FOUND' ||
        error.engineCode === 'E_ENGINE_SESSION_FORBIDDEN')
    ) {
      return
    }
    throw error
  }
}
