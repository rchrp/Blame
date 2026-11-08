import GithubInstallationsService, {
  serializeGithubInstallation,
} from '#services/github/github_installations_service'
import type { HttpContext } from '@adonisjs/core/http'
import { Exception } from '@adonisjs/core/exceptions'

export default class GithubInstallationsController {
  async createIntent({ auth }: HttpContext) {
    const intent = new GithubInstallationsService().createIntent(auth.getUserOrFail().id)
    return { url: intent.url, expiresAt: intent.expiresAt.toISO() }
  }

  // GitHub's setup URL after an installation, with the user's authorization code.
  async callback({ request, response }: HttpContext) {
    const state = callbackInput(request.input('state'), 4_096)
    const code = callbackInput(request.input('code'), 512)
    const count = await new GithubInstallationsService().callback({ state, code })
    response.header('Cache-Control', 'no-store')
    response.header('Content-Type', 'text/plain; charset=utf-8')
    return count
      ? 'GitHub is connected to Blame. You can close this page and go back to Blame.'
      : 'GitHub did not list any installation of the Blame GitHub App for your account. Install the app on GitHub, then try again from Blame.'
  }

  async index({ auth }: HttpContext) {
    const installations = await new GithubInstallationsService().list(auth.getUserOrFail().id)
    return { installations: installations.map(serializeGithubInstallation) }
  }
}

function callbackInput(value: unknown, maximum: number) {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    throw new Exception(
      'GitHub did not send an authorization with this installation. Enable "Request user authorization (OAuth) during installation" for the app, then try again.',
      { status: 400, code: 'E_GITHUB_CALLBACK_INVALID' }
    )
  }
  return value
}
