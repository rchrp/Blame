import type ProjectCodePracticeAnalysis from '#models/project_code_practice_analysis'
import { BaseTransformer } from '@adonisjs/core/transformers'

export default class ProjectCodePracticeAnalysisTransformer extends BaseTransformer<ProjectCodePracticeAnalysis> {
  toObject() {
    return {
      projectId: this.resource.projectId,
      status: this.resource.status,
      agentProviderId: this.resource.agentProviderId,
      agentModelId: this.resource.agentModelId,
      error: this.resource.error,
      viewedAt: this.resource.viewedAt,
      createdAt: this.resource.createdAt,
      updatedAt: this.resource.updatedAt,
    }
  }
}
