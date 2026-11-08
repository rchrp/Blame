import { githubAppCredentials, githubAppOAuthConfig } from '#config/github_app'
import { GithubApiError, GithubAppClient } from './github_app_client.js'
import { Exception } from '@adonisjs/core/exceptions'

const unavailableCode = 'E_GITHUB_APP_UNAVAILABLE'

/** The app's client, or why this server cannot give the agent GitHub access. */
export function requiredGithubAppClient() {
  const credentials = githubAppCredentials()
  if (!credentials) {
    throw new Exception(
      'GitHub access for the agent is not available on this server: the Blame GitHub App is not configured (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY).',
      { status: 503, code: unavailableCode }
    )
  }
  try {
    return { appId: credentials.appId, client: new GithubAppClient(credentials) }
  } catch (error) {
    throw new Exception(
      `GitHub access for the agent is not available on this server: ${(error as Error).message}.`,
      { status: 503, code: unavailableCode }
    )
  }
}

export function requiredGithubAppOAuthConfig() {
  const config = githubAppOAuthConfig()
  if (!config) {
    throw new Exception(
      'Connecting GitHub is not available on this server: the Blame GitHub App is not configured (GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and GITHUB_APP_SLUG).',
      { status: 503, code: unavailableCode }
    )
  }
  return config
}

/** Runs a GitHub request; GitHub's own failures become a 502 that says so. */
export async function githubRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (error instanceof Exception) throw error
    const detail = error instanceof GithubApiError ? error.message : 'GitHub could not be reached'
    throw new Exception(detail, { status: 502, code: 'E_GITHUB_UNAVAILABLE', cause: error })
  }
}
