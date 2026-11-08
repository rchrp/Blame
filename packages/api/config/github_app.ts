import env from '#start/env'

export type GithubAppCredentials = {
  appId: string
  privateKey: string
}

export type GithubAppOAuthConfig = {
  clientId: string
  clientSecret: string
  slug: string
}

/** What signs the app's requests to GitHub: without it, no token is issued. */
export function githubAppCredentials(): GithubAppCredentials | undefined {
  const appId = env.get('GITHUB_APP_ID')?.trim()
  const privateKey = env.get('GITHUB_APP_PRIVATE_KEY')?.release().replaceAll('\\n', '\n').trim()
  if (!appId || !privateKey) return undefined
  return { appId, privateKey }
}

/** What connects a person's installations of the app to their account. */
export function githubAppOAuthConfig(): GithubAppOAuthConfig | undefined {
  const clientId = env.get('GITHUB_APP_CLIENT_ID')?.trim()
  const clientSecret = env.get('GITHUB_APP_CLIENT_SECRET')?.release()
  const slug = env.get('GITHUB_APP_SLUG')?.trim()
  if (!clientId || !clientSecret || !slug) return undefined
  return { clientId, clientSecret, slug }
}
