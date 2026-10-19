import type UserStoryAgentRun from '#models/user_story_agent_run'
import { BaseTransformer } from '@adonisjs/core/transformers'

export default class UserStoryAgentRunTransformer extends BaseTransformer<UserStoryAgentRun> {
  static summary(run: UserStoryAgentRun) {
    return {
      id: run.id,
      userStoryId: run.userStoryId,
      commentId: run.commentId,
      kind: run.kind,
      clineSessionId: run.clineSessionId,
      executionId: run.executionId,
      providerId: run.providerId,
      modelId: run.modelId,
      reasoningEffort: run.reasoningEffort,
      lastSequenceNumber: run.lastSequenceNumber,
      checkpointRunCount: run.checkpointRunCount,
      diffEndRef: run.diffEndRef,
      status: run.status,
      completedAt: run.completedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }
  }

  static full(run: UserStoryAgentRun) {
    return {
      ...this.summary(run),
      activities: run.activities,
      finalResponse: run.finalResponse,
      usage: run.usage,
      sessionSummary: run.sessionSummary,
    }
  }

  toObject() {
    return UserStoryAgentRunTransformer.full(this.resource)
  }
}
