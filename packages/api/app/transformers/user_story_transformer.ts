import type UserStory from '#models/user_story'
import { BaseTransformer } from '@adonisjs/core/transformers'

export default class UserStoryTransformer extends BaseTransformer<UserStory> {
  static summary(story: UserStory) {
    return {
      id: story.id,
      projectId: story.projectId,
      storyNumber: story.storyNumber,
      title: story.title,
      summary: story.summary,
      fileAttachmentUploadPending: Boolean(story.fileAttachmentUploadPending),
      status: story.status,
      priority: story.priority,
      owner: story.owner,
      branch: story.branch,
      targetBranch: story.targetBranch,
      pullRequestUrl: story.pullRequestUrl,
      previewUrl: story.previewUrl,
      runConfigurationId: story.runConfigurationId,
      worktree: story.worktree,
      workspaceMode: story.workspaceMode,
      runMode: story.runMode,
      ambition: story.ambition,
      engineSessionId: story.engineSessionId,
      agentStatus: story.agentStatus,
      agentLastError: story.agentLastError,
      agentModels: story.agentModels,
      mergedAt: story.mergedAt,
      mergeCommit: story.mergeCommit,
      baseCommit: story.baseCommit,
      discardedReason: story.discardedReason,
      createdAt: story.createdAt,
      updatedAt: story.updatedAt,
    }
  }

  toSummary() {
    return UserStoryTransformer.summary(this.resource)
  }

  /** The summary with the story's own attachments, which the board does not need. */
  toObject() {
    return {
      ...UserStoryTransformer.summary(this.resource),
      codeSelectionAttachments: this.resource.codeSelectionAttachments,
      fileAttachments: this.resource.fileAttachments,
    }
  }
}
