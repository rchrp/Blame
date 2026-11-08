import type { CloudRequester } from "./deploy-cloud-api.ts"

export type GithubInstallation = { id: string; accountLogin: string }

export type ProjectGithub = {
  // False when the Blame server has no GitHub App configured.
  available: boolean
  agentAccess: boolean
  repository: { installationId: string; owner: string; name: string } | null
}

export type GithubRepositoryInput = {
  installationId: string
  owner: string
  name: string
}

/** The Blame GitHub App: installations and a project's linked repository. */
export function createGithubCloudApi(request: CloudRequester) {
  return {
    githubConnectIntent() {
      return request<{ url: string; expiresAt: string }>(
        "/integrations/github/connect-intents",
        { method: "POST" }
      )
    },
    githubInstallations() {
      return request<{ installations: GithubInstallation[] }>(
        "/integrations/github/installations"
      )
    },
    projectGithub(projectId: string) {
      return request<{ github: ProjectGithub }>(projectGithubPath(projectId))
    },
    linkGithubRepository(projectId: string, input: GithubRepositoryInput) {
      return request<{ github: ProjectGithub }>(
        `${projectGithubPath(projectId)}/repository`,
        { body: JSON.stringify(input), method: "PUT" }
      )
    },
    unlinkGithubRepository(projectId: string) {
      return request<{ github: ProjectGithub }>(
        `${projectGithubPath(projectId)}/repository`,
        { method: "DELETE" }
      )
    },
    setGithubAgentAccess(projectId: string, enabled: boolean) {
      return request<{ github: ProjectGithub }>(
        `${projectGithubPath(projectId)}/agent-access`,
        { body: JSON.stringify({ enabled }), method: "PUT" }
      )
    },
  }
}

function projectGithubPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/github`
}

/**
 * Reads `owner/name`, also accepting a pasted github.com URL. The API checks
 * GitHub's naming rules; this only splits the two parts.
 */
export function parseGithubRepositoryInput(value: string) {
  const match = value
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .match(/^([^/\s]+)\/([^/\s]+)$/)
  if (!match) return undefined
  return { owner: match[1], name: match[2] }
}
