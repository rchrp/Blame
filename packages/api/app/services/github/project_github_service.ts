import GithubAppInstallation from '#models/github_app_installation'
import type Project from '#models/project'
import ProjectsService from '#services/projects_service'
import { githubAppCredentials } from '#config/github_app'
import { agentTokenPermissions, GithubApiError } from './github_app_client.js'
import { githubRequest, requiredGithubAppClient } from './github_app_access.js'
import { Exception } from '@adonisjs/core/exceptions'

export type LinkGithubRepositoryInput = {
  installationId: string
  owner: string
  name: string
}

/**
 * A project's GitHub repository and the agent's access to it. In cloud
 * sessions the agent gets a one-hour installation token limited to that
 * repository, issued on demand and never stored.
 */
export default class ProjectGithubService {
  show(userId: string, projectId: string) {
    return new ProjectsService().findForUser(userId, projectId)
  }

  async linkRepository(userId: string, projectId: string, input: LinkGithubRepositoryInput) {
    const { client } = requiredGithubAppClient()
    const project = await new ProjectsService().findForUser(userId, projectId)
    const installation = await GithubAppInstallation.query()
      .where('id', input.installationId)
      .where('userId', userId)
      .first()
    if (!installation) {
      throw new Exception('Connect this GitHub installation to your account first.', {
        status: 404,
        code: 'E_GITHUB_INSTALLATION_NOT_FOUND',
      })
    }
    const covering = await githubRequest(() =>
      client.repositoryInstallationId(input.owner, input.name)
    )
    if (covering !== installation.installationId) {
      throw new Exception(
        `The Blame GitHub App installation on ${installation.accountLogin} does not include ${input.owner}/${input.name}. Add the repository to the installation on GitHub.`,
        { status: 422, code: 'E_GITHUB_REPOSITORY_NOT_INSTALLED' }
      )
    }
    project.merge({
      githubInstallationId: installation.id,
      githubRepositoryOwner: input.owner,
      githubRepositoryName: input.name,
    })
    await project.save()
    return project
  }

  async unlinkRepository(userId: string, projectId: string) {
    const project = await new ProjectsService().findForUser(userId, projectId)
    project.merge({
      githubInstallationId: null,
      githubRepositoryOwner: null,
      githubRepositoryName: null,
    })
    await project.save()
    return project
  }

  async setAgentAccess(userId: string, projectId: string, enabled: boolean) {
    const project = await new ProjectsService().findForUser(userId, projectId)
    project.githubAgentAccess = enabled
    await project.save()
    return project
  }

  async issueAgentToken(userId: string, projectId: string) {
    const { client } = requiredGithubAppClient()
    const project = await new ProjectsService().findForUser(userId, projectId)
    if (!project.githubAgentAccess) {
      throw new Exception('GitHub access for the agent is turned off for this project.', {
        status: 403,
        code: 'E_GITHUB_AGENT_ACCESS_DISABLED',
      })
    }
    const repository = linkedRepository(project)
    if (!repository) {
      throw new Exception('Link this project to a GitHub repository first.', {
        status: 409,
        code: 'E_GITHUB_REPOSITORY_NOT_LINKED',
      })
    }
    const installation = await GithubAppInstallation.query()
      .where('id', repository.installationId)
      .where('userId', userId)
      .first()
    if (!installation) throw installationRevoked(repository)
    const issued = await githubRequest(async () => {
      try {
        return await client.createRepositoryToken(installation.installationId, repository.name)
      } catch (error) {
        // GitHub refuses an installation that was removed, suspended or lost the repository.
        if (error instanceof GithubApiError && [401, 403, 404, 422].includes(error.status)) {
          throw installationRevoked(repository)
        }
        throw error
      }
    })
    if (
      issued.repositories.length !== 1 ||
      issued.repositories[0]!.toLowerCase() !== repository.name.toLowerCase()
    ) {
      throw new Exception('GitHub returned a token that is not limited to the repository.', {
        status: 502,
        code: 'E_GITHUB_TOKEN_SCOPE_INVALID',
      })
    }
    return {
      token: issued.token,
      expiresAt: issued.expiresAt,
      repository: `${repository.owner}/${repository.name}`,
      permissions: agentTokenPermissions,
    }
  }
}

export function serializeProjectGithub(project: Project) {
  const repository = linkedRepository(project)
  return {
    available: Boolean(githubAppCredentials()),
    agentAccess: project.githubAgentAccess,
    repository: repository
      ? {
          installationId: repository.installationId,
          owner: repository.owner,
          name: repository.name,
        }
      : null,
  }
}

function linkedRepository(project: Project) {
  const { githubInstallationId, githubRepositoryOwner, githubRepositoryName } = project
  if (!githubInstallationId || !githubRepositoryOwner || !githubRepositoryName) return undefined
  return {
    installationId: githubInstallationId,
    owner: githubRepositoryOwner,
    name: githubRepositoryName,
  }
}

function installationRevoked(repository: { owner: string; name: string }) {
  return new Exception(
    `The Blame GitHub App no longer has access to ${repository.owner}/${repository.name}. Reconnect GitHub and link the repository again.`,
    { status: 409, code: 'E_GITHUB_INSTALLATION_INVALID' }
  )
}
