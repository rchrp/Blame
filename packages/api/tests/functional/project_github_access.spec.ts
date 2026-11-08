import GithubAppInstallation from '#models/github_app_installation'
import Project from '#models/project'
import env from '#start/env'
import { Secret } from '@adonisjs/core/helpers'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createLicensedUser } from '#tests/helpers/create_licensed_user'

const appId = '12345'
const githubInstallationId = '987'
const issuedToken = ['ghs', 'issuedRepositoryScopedToken000000000'].join('_')
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

type GithubCall = { url: string; method: string; headers: Headers; body: unknown }

test.group('Project GitHub access for the agent', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => {
    configureGithubApp()
    return () => unconfigureGithubApp()
  })
  group.each.setup(() => testUtils.db().truncate())

  test('refuses a token for a project the user does not own', async ({ client, assert }) => {
    const owner = await createLicensedUser()
    const other = await createLicensedUser()
    const project = await linkedProject(owner.id, { agentAccess: true })
    const github = mockGithub(() => tokenResponse())
    try {
      const response = await client
        .post(`/api/v1/projects/${project.id}/github/agent-token`)
        .loginAs(other)
      response.assertStatus(404)
      assert.notInclude(JSON.stringify(response.body()), issuedToken)
      assert.lengthOf(github.calls, 0)
    } finally {
      github.restore()
    }
  })

  test('refuses a token while GitHub access for the agent is off', async ({ client, assert }) => {
    const user = await createLicensedUser()
    const project = await linkedProject(user.id, { agentAccess: false })
    const github = mockGithub(() => tokenResponse())
    try {
      const response = await client
        .post(`/api/v1/projects/${project.id}/github/agent-token`)
        .loginAs(user)
      response.assertStatus(403)
      assert.include(JSON.stringify(response.body()), 'turned off')
      assert.lengthOf(github.calls, 0)
    } finally {
      github.restore()
    }
  })

  test('asks GitHub for a token limited to the repository with the least permissions', async ({
    client,
    assert,
  }) => {
    const user = await createLicensedUser()
    const project = await linkedProject(user.id, { agentAccess: true })
    const github = mockGithub(() => tokenResponse())
    try {
      const response = await client
        .post(`/api/v1/projects/${project.id}/github/agent-token`)
        .loginAs(user)
      response.assertStatus(200)
      response.assertHeader('cache-control', 'no-store')
      assert.equal(response.body().token, issuedToken)
      assert.equal(response.body().repository, 'acme/web')

      assert.lengthOf(github.calls, 1)
      const call = github.calls[0]!
      assert.equal(call.method, 'POST')
      assert.equal(
        call.url,
        `https://api.github.com/app/installations/${githubInstallationId}/access_tokens`
      )
      assert.deepEqual(call.body, {
        repositories: ['web'],
        permissions: {
          checks: 'write',
          contents: 'read',
          issues: 'write',
          pull_requests: 'write',
        },
      })
      assertAppJwt(assert, call.headers)

      // Issued on demand only: the token is not kept with the project.
      const stored = await Project.findOrFail(project.id)
      assert.notInclude(JSON.stringify(stored.$attributes), issuedToken)
    } finally {
      github.restore()
    }
  })

  test('refuses a token GitHub did not limit to the repository', async ({ client }) => {
    const user = await createLicensedUser()
    const project = await linkedProject(user.id, { agentAccess: true })
    const github = mockGithub(() => tokenResponse(['web', 'billing']))
    try {
      const response = await client
        .post(`/api/v1/projects/${project.id}/github/agent-token`)
        .loginAs(user)
      response.assertStatus(502)
    } finally {
      github.restore()
    }
  })

  test('says the feature is off when the GitHub App is not configured', async ({
    client,
    assert,
  }) => {
    unconfigureGithubApp()
    const user = await createLicensedUser()
    const project = await linkedProject(user.id, { agentAccess: true })
    const github = mockGithub(() => tokenResponse())
    try {
      const response = await client
        .post(`/api/v1/projects/${project.id}/github/agent-token`)
        .loginAs(user)
      response.assertStatus(503)
      assert.include(JSON.stringify(response.body()), 'GITHUB_APP_ID')
      assert.lengthOf(github.calls, 0)

      const settings = await client.get(`/api/v1/projects/${project.id}/github`).loginAs(user)
      settings.assertStatus(200)
      assert.isFalse(settings.body().github.available)
    } finally {
      github.restore()
    }
  })

  test('links a repository only when the installation covers it', async ({ client, assert }) => {
    const user = await createLicensedUser()
    const project = await Project.create({ userId: user.id, name: 'Web' })
    const installation = await GithubAppInstallation.create({
      userId: user.id,
      installationId: githubInstallationId,
      accountLogin: 'acme',
    })
    let coveringInstallation = Number(githubInstallationId)
    const github = mockGithub(() => Response.json({ id: coveringInstallation }))
    try {
      const linked = await client
        .put(`/api/v1/projects/${project.id}/github/repository`)
        .json({ installationId: installation.id, owner: 'acme', name: 'web' })
        .loginAs(user)
      linked.assertStatus(200)
      assert.deepEqual(linked.body().github.repository, {
        installationId: installation.id,
        owner: 'acme',
        name: 'web',
      })
      assert.equal(github.calls[0]!.url, 'https://api.github.com/repos/acme/web/installation')
      assertAppJwt(assert, github.calls[0]!.headers)

      coveringInstallation = 1
      const elsewhere = await client
        .put(`/api/v1/projects/${project.id}/github/repository`)
        .json({ installationId: installation.id, owner: 'acme', name: 'other' })
        .loginAs(user)
      elsewhere.assertStatus(422)

      const other = await createLicensedUser()
      const otherProject = await Project.create({ userId: other.id, name: 'Other' })
      const borrowed = await client
        .put(`/api/v1/projects/${otherProject.id}/github/repository`)
        .json({ installationId: installation.id, owner: 'acme', name: 'web' })
        .loginAs(other)
      borrowed.assertStatus(404)
    } finally {
      github.restore()
    }
  })

  test('turns GitHub access for the agent on and off per project', async ({ client, assert }) => {
    const user = await createLicensedUser()
    const project = await Project.create({ userId: user.id, name: 'Web' })
    const initial = await client.get(`/api/v1/projects/${project.id}/github`).loginAs(user)
    assert.isFalse(initial.body().github.agentAccess)

    const enabled = await client
      .put(`/api/v1/projects/${project.id}/github/agent-access`)
      .json({ enabled: true })
      .loginAs(user)
    enabled.assertStatus(200)
    assert.isTrue(enabled.body().github.agentAccess)
    const stored = await Project.findOrFail(project.id)
    assert.isTrue(stored.githubAgentAccess)

    const other = await createLicensedUser()
    const refused = await client
      .put(`/api/v1/projects/${project.id}/github/agent-access`)
      .json({ enabled: false })
      .loginAs(other)
    refused.assertStatus(404)
  })

  test('connects only the installations GitHub lists for the authorizing user', async ({
    client,
    assert,
  }) => {
    const user = await createLicensedUser()
    const intent = await client.post('/api/v1/integrations/github/connect-intents').loginAs(user)
    intent.assertStatus(200)
    const url = new URL(intent.body().url)
    assert.equal(url.origin + url.pathname, 'https://github.com/apps/blame-test/installations/new')
    const state = url.searchParams.get('state')!

    const github = mockGithub((call) => {
      if (call.url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'ghu_userAuthorizationToken' })
      }
      return Response.json({
        installations: [
          { id: Number(githubInstallationId), app_id: Number(appId), account: { login: 'acme' } },
          { id: 4, app_id: 99, account: { login: 'another-app' } },
        ],
      })
    })
    try {
      const forged = await client.get('/api/v1/integrations/github/callback').qs({
        state: 'forged',
        code: 'code',
        installation_id: githubInstallationId,
      })
      forged.assertStatus(400)
      assert.lengthOf(github.calls, 0)

      const connected = await client
        .get('/api/v1/integrations/github/callback')
        .qs({ state, code: 'code', installation_id: '4', setup_action: 'install' })
      connected.assertStatus(200)
      assert.deepEqual(
        github.calls.map((call) => call.url),
        [
          'https://github.com/login/oauth/access_token',
          'https://api.github.com/user/installations?per_page=100',
        ]
      )

      const listed = await client.get('/api/v1/integrations/github/installations').loginAs(user)
      listed.assertStatus(200)
      assert.deepEqual(
        listed
          .body()
          .installations.map(({ accountLogin }: { accountLogin: string }) => accountLogin),
        ['acme']
      )
      assert.notInclude(JSON.stringify(listed.body()), 'ghu_')
    } finally {
      github.restore()
    }
  })
})

function configureGithubApp() {
  env.set('GITHUB_APP_ID', appId)
  env.set('GITHUB_APP_PRIVATE_KEY', new Secret(privateKey))
  env.set('GITHUB_APP_CLIENT_ID', 'Iv1.test')
  env.set('GITHUB_APP_CLIENT_SECRET', new Secret('client-secret'))
  env.set('GITHUB_APP_SLUG', 'blame-test')
}

function unconfigureGithubApp() {
  for (const key of [
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_SLUG',
  ] as const) {
    env.set(key, undefined)
    delete process.env[key]
  }
}

async function linkedProject(userId: string, options: { agentAccess: boolean }) {
  const installation = await GithubAppInstallation.create({
    userId,
    installationId: githubInstallationId,
    accountLogin: 'acme',
  })
  return Project.create({
    userId,
    name: 'Web',
    githubInstallationId: installation.id,
    githubRepositoryOwner: 'acme',
    githubRepositoryName: 'web',
    githubAgentAccess: options.agentAccess,
  })
}

function tokenResponse(repositories = ['web']) {
  return Response.json(
    {
      token: issuedToken,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { checks: 'write', contents: 'read', issues: 'write', pull_requests: 'write' },
      repositories: repositories.map((name) => ({ name, full_name: `acme/${name}` })),
    },
    { status: 201 }
  )
}

/** Replaces fetch for GitHub's hosts only; the test client keeps the real one. */
function mockGithub(answer: (call: GithubCall) => Response) {
  const original = globalThis.fetch
  const calls: GithubCall[] = []
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!/^https:\/\/(api\.)?github\.com\//.test(url)) return original(input, init)
    const call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return answer(call)
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

function assertAppJwt(
  assert: { equal(actual: unknown, expected: unknown): void; isTrue(value: unknown): void },
  headers: Headers
) {
  const [header, payload, signature] = (headers.get('authorization') ?? '')
    .replace(/^Bearer /, '')
    .split('.')
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
  assert.equal(JSON.parse(Buffer.from(header!, 'base64url').toString()).alg, 'RS256')
  assert.equal(claims.iss, appId)
  assert.isTrue(claims.exp - claims.iat <= 600)
  assert.isTrue(
    verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      keys.publicKey,
      Buffer.from(signature!, 'base64url')
    )
  )
}
