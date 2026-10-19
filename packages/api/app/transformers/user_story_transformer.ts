import type UserStory from '#models/user_story'
import UserStoryAgentRunTransformer from '#transformers/user_story_agent_run_transformer'
import UserStoryCommentTransformer from '#transformers/user_story_comment_transformer'
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
      previewUrl: story.previewUrl,
      runConfigurationId: story.runConfigurationId,
      worktree: story.worktree,
      workspaceMode: story.workspaceMode,
      runMode: story.runMode,
      agentStatus: story.agentStatus,
      clineSessionId: story.clineSessionId,
      agentProviderId: story.agentProviderId,
      agentModelId: story.agentModelId,
      agentLastEvent: story.agentLastEvent,
      agentLastError: story.agentLastError,
      activeAgentRunId: story.activeAgentRunId,
      runningAgentRuns: (story.agentRuns ?? []).map((run) =>
        UserStoryAgentRunTransformer.summary(run)
      ),
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

  toObject() {
    return {
      ...this.pick(this.resource, [
        'id',
        'projectId',
        'storyNumber',
        'title',
        'summary',
        'codeSelectionAttachments',
        'fileAttachments',
        'status',
        'priority',
        'owner',
        'branch',
        'previewUrl',
        'runConfigurationId',
        'worktree',
        'workspaceMode',
        'runMode',
        'agentStatus',
        'clineSessionId',
        'agentProviderId',
        'agentModelId',
        'agentLastEvent',
        'agentLastError',
        'activeAgentRunId',
        'agentActivities',
        'agentFinalResponse',
        'agentUsage',
        'agentSessionSummary',
        'mergedAt',
        'mergeCommit',
        'baseCommit',
        'discardedReason',
        'createdAt',
        'updatedAt',
      ]),
      fileAttachmentUploadPending: Boolean(this.resource.fileAttachmentUploadPending),
      comments: UserStoryCommentTransformer.transform(this.resource.comments ?? []),
      agentRuns: (this.resource.agentRuns ?? []).map((run) =>
        UserStoryAgentRunTransformer.full(run)
      ),
    }
  }
}
