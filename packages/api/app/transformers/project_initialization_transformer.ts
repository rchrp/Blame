import type ProjectInitialization from '#models/project_initialization'
import type ProjectCodePractice from '#models/project_code_practice'
import { BaseTransformer } from '@adonisjs/core/transformers'

type ProjectInitializationResource = {
  initialization: ProjectInitialization | null
  practices: ProjectCodePractice[]
}

export default class ProjectInitializationTransformer extends BaseTransformer<ProjectInitializationResource> {
  toObject() {
    return {
      initialization: this.resource.initialization
        ? {
            projectId: this.resource.initialization.projectId,
            status: this.resource.initialization.status,
            step: this.resource.initialization.step,
            clineSessionId: this.resource.initialization.clineSessionId,
            agentProviderId: this.resource.initialization.agentProviderId,
            agentModelId: this.resource.initialization.agentModelId,
            previewManifest: this.resource.initialization.previewManifest,
            runConfigurations: this.resource.initialization.runConfigurations ?? [],
            databaseMode: this.resource.initialization.databaseMode,
            error: this.resource.initialization.error,
            repairReason: this.resource.initialization.repairReason,
            checkedCommit: this.resource.initialization.checkedCommit,
            createdAt: this.resource.initialization.createdAt,
            updatedAt: this.resource.initialization.updatedAt,
          }
        : null,
      practices: this.resource.practices.map((practice) => ({
        id: practice.id,
        projectId: practice.projectId,
        practice: practice.practice,
        detected: Boolean(practice.detected),
        enabled: Boolean(practice.enabled),
        comment: practice.comment,
        createdAt: practice.createdAt,
        updatedAt: practice.updatedAt,
      })),
    }
  }
}
