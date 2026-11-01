import User from '#models/user'
import db from '@adonisjs/lucid/services/db'

const localUserEmail = 'local@blame.invalid'

/**
 * The person using the desktop app without an account. The local API has
 * exactly one user; it owns everything stored on this computer.
 */
export default class LocalSessionService {
  /**
   * Returns a fresh access token for the local user and revokes the previous
   * ones, so a token is only valid while the API process that issued it runs.
   */
  async start() {
    const user = await this.user()
    await db.from('auth_access_tokens').where('tokenable_id', user.id).delete()
    const token = await User.accessTokens.create(user, ['*'], { name: 'desktop' })
    return token.value!.release()
  }

  private async user() {
    const existing = await User.findBy('email', localUserEmail)
    if (existing) return existing
    return User.create({ email: localUserEmail, emailVerified: true, fullName: null })
  }
}
