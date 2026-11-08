import type { GithubAppCredentials, GithubAppOAuthConfig } from '#config/github_app'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'

type Fetcher = typeof fetch

const apiOrigin = 'https://api.github.com'
const oauthTokenUrl = 'https://github.com/login/oauth/access_token'
const requestTimeoutMs = 15_000
const githubHeaders = {
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'Blame',
  'X-GitHub-Api-Version': '2022-11-28',
}

/**
 * The least the agent needs on its repository: issues, pull requests and
 * checks, and reading the code. Nothing else (no workflows, no admin, no push).
 */
export const agentTokenPermissions = {
  checks: 'write',
  contents: 'read',
  issues: 'write',
  pull_requests: 'write',
} as const

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GithubApiError'
  }
}

export type GithubRepositoryToken = {
  token: string
  expiresAt: string
  /** Names of the repositories GitHub scoped the token to. */
  repositories: string[]
}

export type GithubUserInstallation = {
  installationId: string
  accountLogin: string
}

/** Requests GitHub answers for the Blame GitHub App itself, signed with its key. */
export class GithubAppClient {
  private readonly key: KeyObject

  constructor(
    private readonly credentials: GithubAppCredentials,
    private readonly fetcher: Fetcher = fetch
  ) {
    try {
      this.key = createPrivateKey(credentials.privateKey)
    } catch {
      throw new Error('GITHUB_APP_PRIVATE_KEY is not a valid private key')
    }
    if (this.key.asymmetricKeyType !== 'rsa') {
      throw new Error('GITHUB_APP_PRIVATE_KEY must be the RSA key GitHub generated for the app')
    }
  }

  /** The id of the app's installation that covers owner/name, or null. */
  async repositoryInstallationId(owner: string, name: string) {
    try {
      const body = await this.request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`
      )
      return identifier(body.id) ?? null
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404) return null
      throw error
    }
  }

  /** A one-hour installation token for one repository, with agentTokenPermissions. */
  async createRepositoryToken(
    installationId: string,
    repositoryName: string
  ): Promise<GithubRepositoryToken> {
    const body = await this.request(
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: 'POST',
        body: { repositories: [repositoryName], permissions: agentTokenPermissions },
      }
    )
    const token = text(body.token)
    const expiresAt = text(body.expires_at)
    if (!token || !expiresAt || Number.isNaN(Date.parse(expiresAt))) {
      throw new GithubApiError('GitHub returned an invalid installation token', 502)
    }
    const repositories = Array.isArray(body.repositories)
      ? body.repositories
          .map((repository) => text(record(repository).name))
          .filter((name): name is string => Boolean(name))
      : []
    return { token, expiresAt, repositories }
  }

  private async request(path: string, input: { method?: string; body?: unknown } = {}) {
    const response = await this.fetcher(new URL(path, apiOrigin), {
      method: input.method ?? 'GET',
      headers: {
        ...githubHeaders,
        Authorization: `Bearer ${this.appJwt()}`,
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (!response.ok) throw await githubError(response)
    return record(await response.json())
  }

  // GitHub accepts app JWTs of at most ten minutes; iat is backdated for clock drift.
  private appJwt() {
    const now = Math.floor(Date.now() / 1000)
    const header = base64Url({ alg: 'RS256', typ: 'JWT' })
    const payload = base64Url({ iat: now - 60, exp: now + 540, iss: this.credentials.appId })
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), this.key)
    return `${header}.${payload}.${signature.toString('base64url')}`
  }
}

/** The user token GitHub grants for the code of an installation or authorization. */
export async function exchangeGithubUserCode(
  config: GithubAppOAuthConfig,
  code: string,
  fetcher: Fetcher = fetch
) {
  const response = await fetcher(oauthTokenUrl, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  if (!response.ok) throw await githubError(response)
  const token = text(record(await response.json()).access_token)
  if (!token) throw new GithubApiError('GitHub did not authorize this installation', 400)
  return token
}

/** Installations of the app that the user behind the token can access. */
export async function githubUserInstallations(
  userToken: string,
  appId: string,
  fetcher: Fetcher = fetch
): Promise<GithubUserInstallation[]> {
  const response = await fetcher(new URL('/user/installations?per_page=100', apiOrigin), {
    headers: { ...githubHeaders, Authorization: `Bearer ${userToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  if (!response.ok) throw await githubError(response)
  const installations = record(await response.json()).installations
  if (!Array.isArray(installations)) return []
  return installations.flatMap((value) => {
    const installation = record(value)
    const installationId = identifier(installation.id)
    const accountLogin = text(record(installation.account).login)
    if (identifier(installation.app_id) !== appId || !installationId || !accountLogin) return []
    return [{ installationId, accountLogin }]
  })
}

async function githubError(response: Response) {
  const body = await response.text().catch(() => '')
  let message: string | undefined
  try {
    message = text(record(JSON.parse(body)).message)
  } catch {}
  return new GithubApiError(
    `GitHub answered ${response.status}${message ? `: ${message.slice(0, 200)}` : ''}`,
    response.status
  )
}

function base64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function text(value: unknown) {
  return typeof value === 'string' && value && value.length <= 4_096 ? value : undefined
}

function identifier(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value
  return undefined
}
