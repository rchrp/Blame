import GithubAppInstallation from '#models/github_app_installation'
import { exchangeGithubUserCode, githubUserInstallations } from './github_app_client.js'
import {
  githubRequest,
  requiredGithubAppClient,
  requiredGithubAppOAuthConfig,
} from './github_app_access.js'
import { Exception } from '@adonisjs/core/exceptions'
import encryption from '@adonisjs/core/services/encryption'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

const statePurpose = 'github-app-installation'
const stateTtlMinutes = 10

/**
 * Connects installations of the Blame GitHub App to an account. GitHub's
 * installation_id parameter can be forged, so the callback trusts only the
 * installations GitHub lists for the user who authorized the app. Their user
 * token is used once and never stored.
 */
export default class GithubInstallationsService {
  createIntent(userId: string) {
    const config = requiredGithubAppOAuthConfig()
    requiredGithubAppClient()
    const state = encryption.encrypt({ userId }, `${stateTtlMinutes}m`, statePurpose)
    const url = new URL(
      `/apps/${encodeURIComponent(config.slug)}/installations/new`,
      'https://github.com'
    )
    url.searchParams.set('state', state)
    return { url: url.toString(), expiresAt: DateTime.utc().plus({ minutes: stateTtlMinutes }) }
  }

  async callback(input: { state: string; code: string }) {
    const config = requiredGithubAppOAuthConfig()
    const { appId } = requiredGithubAppClient()
    const userId = stateUser(input.state)
    const userToken = await githubRequest(() => exchangeGithubUserCode(config, input.code))
    const installations = await githubRequest(() => githubUserInstallations(userToken, appId))
    return db.transaction(async (transaction) => {
      const current = new Set(installations.map(({ installationId }) => installationId))
      // What GitHub no longer lists for the user is no longer theirs to use.
      await GithubAppInstallation.query({ client: transaction })
        .where('userId', userId)
        .if(current.size > 0, (query) => query.whereNotIn('installationId', [...current]))
        .delete()
      for (const installation of installations) {
        await GithubAppInstallation.updateOrCreate(
          { userId, installationId: installation.installationId },
          { accountLogin: installation.accountLogin },
          { client: transaction }
        )
      }
      return installations.length
    })
  }

  list(userId: string) {
    return GithubAppInstallation.query().where('userId', userId).orderBy('accountLogin', 'asc')
  }
}

export function serializeGithubInstallation(installation: GithubAppInstallation) {
  return { id: installation.id, accountLogin: installation.accountLogin }
}

function stateUser(state: string) {
  const payload = encryption.decrypt<{ userId?: unknown }>(state, statePurpose)
  if (!payload || typeof payload.userId !== 'string' || !payload.userId) {
    throw new Exception(
      'GitHub connection request is invalid or expired. Start again from Blame.',
      {
        status: 400,
        code: 'E_GITHUB_CONNECT_STATE_INVALID',
      }
    )
  }
  return payload.userId
}
