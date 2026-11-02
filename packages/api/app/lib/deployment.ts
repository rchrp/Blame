import env from '#start/env'

export type DeploymentMode = 'cloud' | 'local'

const mode: DeploymentMode = env.get('BLAME_DEPLOYMENT', 'cloud')

/**
 * Where this API runs, read once at boot. It is the only switch between the
 * two deployments; the rest of the code asks it what is available.
 *
 * - `cloud`: the hosted API at api.blame.so, with accounts.
 * - `local`: the API the desktop app runs for one person without an account,
 *   on SQLite, reachable only from that computer.
 */
export const deployment = {
  mode,
  /**
   * Accounts and the services Blame hosts: sign-in, billing, Cloud Previews,
   * voice transcription, hosted uploads, deployments and web search.
   */
  hostedServices: mode === 'cloud',
}

export const accountRequired = {
  code: 'ACCOUNT_REQUIRED',
  message: 'Sign in to a Blame account to use this feature.',
} as const
