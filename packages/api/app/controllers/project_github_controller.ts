import ProjectGithubService, {
  serializeProjectGithub,
} from '#services/github/project_github_service'
import { linkGithubRepositoryValidator, updateGithubAgentAccessValidator } from '#validators/github'
import type { HttpContext } from '@adonisjs/core/http'

export default class ProjectGithubController {
  async show({ auth, params }: HttpContext) {
    const project = await new ProjectGithubService().show(auth.getUserOrFail().id, params.projectId)
    return { github: serializeProjectGithub(project) }
  }

  async linkRepository({ auth, params, request }: HttpContext) {
    const project = await new ProjectGithubService().linkRepository(
      auth.getUserOrFail().id,
      params.projectId,
      await request.validateUsing(linkGithubRepositoryValidator)
    )
    return { github: serializeProjectGithub(project) }
  }

  async unlinkRepository({ auth, params }: HttpContext) {
    const project = await new ProjectGithubService().unlinkRepository(
      auth.getUserOrFail().id,
      params.projectId
    )
    return { github: serializeProjectGithub(project) }
  }

  async updateAgentAccess({ auth, params, request }: HttpContext) {
    const { enabled } = await request.validateUsing(updateGithubAgentAccessValidator)
    const project = await new ProjectGithubService().setAgentAccess(
      auth.getUserOrFail().id,
      params.projectId,
      enabled
    )
    return { github: serializeProjectGithub(project) }
  }

  async agentToken({ auth, params, response }: HttpContext) {
    const token = await new ProjectGithubService().issueAgentToken(
      auth.getUserOrFail().id,
      params.projectId
    )
    response.header('Cache-Control', 'no-store')
    return token
  }
}
