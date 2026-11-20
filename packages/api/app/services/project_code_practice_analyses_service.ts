import ProjectCodePractice from '#models/project_code_practice'
import ProjectCodePracticeAnalysis from '#models/project_code_practice_analysis'
import ProjectsService from '#services/projects_service'
import type {
  completeProjectCodePracticeAnalysisValidator,
  failProjectCodePracticeAnalysisValidator,
  startProjectCodePracticeAnalysisValidator,
} from '#validators/project_code_practice_analysis'
import type { Infer } from '@vinejs/vine/types'
import { DateTime } from 'luxon'
import { Exception } from '@adonisjs/core/exceptions'

type StartInput = Infer<typeof startProjectCodePracticeAnalysisValidator>
type CompleteInput = Infer<typeof completeProjectCodePracticeAnalysisValidator>
type FailInput = Infer<typeof failProjectCodePracticeAnalysisValidator>
type Practice = CompleteInput['practices'][number]

export default class ProjectCodePracticeAnalysesService {
  async show(userId: string, projectId: string) {
    await new ProjectsService().findForUser(userId, projectId)
    return this.analysis(projectId)
  }

  async start(userId: string, projectId: string, input: StartInput) {
    await new ProjectsService().findForUser(userId, projectId)
    const analysis = await this.analysis(projectId)
    analysis.merge({
      status: 'running',
      agentProviderId: input.providerId,
      agentModelId: input.modelId,
      error: null,
      viewedAt: null,
    })
    await analysis.save()
    return analysis
  }

  async complete(userId: string, projectId: string, input: CompleteInput) {
    await new ProjectsService().findForUser(userId, projectId)
    validatePractices(input.practices)
    await Promise.all(input.practices.map((practice) => this.savePractice(projectId, practice)))
    const analysis = await this.analysis(projectId)
    analysis.merge({
      status: 'done',
      error: null,
      viewedAt: null,
    })
    await analysis.save()
    return analysis
  }

  async fail(userId: string, projectId: string, input: FailInput) {
    await new ProjectsService().findForUser(userId, projectId)
    const analysis = await this.analysis(projectId)
    analysis.merge({
      status: 'error',
      error: input.error,
    })
    await analysis.save()
    return analysis
  }

  async markViewed(userId: string, projectId: string) {
    await new ProjectsService().findForUser(userId, projectId)
    const analysis = await this.analysis(projectId)
    if (analysis.status !== 'done' || analysis.viewedAt) return analysis
    analysis.viewedAt = DateTime.now()
    await analysis.save()
    return analysis
  }

  private async analysis(projectId: string) {
    const existing = await ProjectCodePracticeAnalysis.find(projectId)
    if (existing) return existing
    try {
      return await ProjectCodePracticeAnalysis.create({ projectId, status: 'pending' })
    } catch {
      return ProjectCodePracticeAnalysis.findOrFail(projectId)
    }
  }

  private findOrCreatePractice(projectId: string, practice: Practice) {
    return ProjectCodePractice.firstOrCreate(
      { projectId, practice: practice.practice },
      {
        projectId,
        practice: practice.practice,
        detected: practice.detected,
        enabled: defaultEnabledPractice(practice),
        comment: practice.comment,
      }
    )
  }

  private async savePractice(projectId: string, practice: Practice) {
    const stored = await this.findOrCreatePractice(projectId, practice)
    stored.merge({ detected: practice.detected, comment: practice.comment })
    await stored.save()
  }
}

const requiredPractices: Practice['practice'][] = [
  'coding_style',
  'unit_tests',
  'layered_architecture',
  'commit_message_convention',
]

function validatePractices(practices: Practice[]) {
  const keys = new Set(practices.map(({ practice }) => practice))
  if (keys.size === requiredPractices.length) return
  throw new Exception('Code practice analysis must contain each practice exactly once', {
    status: 422,
    code: 'E_CODE_PRACTICES_INVALID',
  })
}

function defaultEnabledPractice(practice: Practice) {
  return practice.practice === 'coding_style' || practice.detected
}
