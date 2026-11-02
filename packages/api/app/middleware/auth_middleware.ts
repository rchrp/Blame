import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type { Authenticators } from '@adonisjs/auth/types'
import AccountClosureLedgerService from '#services/account_closure_ledger_service'
import { authenticateBetterAuthSession } from '#lib/authenticate_better_auth_session'
import { deployment } from '#lib/deployment'

/**
 * Auth middleware is used authenticate HTTP requests and deny
 * access to unauthenticated users.
 */
export default class AuthMiddleware {
  async handle(
    ctx: HttpContext,
    next: NextFn,
    options: {
      guards?: (keyof Authenticators)[]
    } = {}
  ) {
    if (!ctx.auth.isAuthenticated) {
      try {
        await ctx.auth.authenticateUsing(options.guards)
      } catch {
        const authenticated = await authenticateBetterAuthSession(ctx)
        if (!authenticated) {
          return ctx.response.unauthorized({ message: 'Authentication required' })
        }
      }
    }
    // The local API has a single user and no account to close.
    if (!deployment.hostedServices) return next()
    const user = ctx.auth.getUserOrFail()
    const closureLedger = new AccountClosureLedgerService()
    if (user.closureRequestedAt || (await closureLedger.hasUser(user.id))) {
      return ctx.response.forbidden({
        code: 'ACCOUNT_CLOSURE_IN_PROGRESS',
        message: 'This account is closed and no longer accepts requests',
      })
    }
    return next()
  }
}
