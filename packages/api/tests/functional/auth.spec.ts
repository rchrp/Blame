import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// The Better Auth data migration deliberately cannot roll back. Keep the schema
// and truncate test data between groups instead of resetting migrations.
test.group('Better Auth response forwarding', (group) => {
  group.setup(() => testUtils.db().truncate())

  test('forwards empty redirects', async ({ client, assert }) => {
    const response = await client
      .get('/api/v1/auth/callback/google?error=access_denied')
      .redirects(0)

    response.assertStatus(302)
    assert.match(response.header('location') ?? '', /\/api\/v1\/auth\/error\?error=/)
    assert.equal(response.text(), '')
  })

  test('redirects legacy authentication pages to the website', async ({ client, assert }) => {
    const passkey = await client.get('/api/v1/auth/desktop?user_code=ABCD2345').redirects(0)
    const reset = await client
      .get('/api/v1/auth/reset-password-page?token=reset-token')
      .redirects(0)
    const verified = await client.get('/api/v1/auth/verified').redirects(0)

    passkey.assertStatus(302)
    reset.assertStatus(302)
    verified.assertStatus(302)
    assert.equal(passkey.header('location'), 'https://blame.so/auth/passkey?user_code=ABCD2345')
    assert.equal(reset.header('location'), 'https://blame.so/auth/reset-password?token=reset-token')
    assert.equal(verified.header('location'), 'https://blame.so/auth/verify-email?verified=true')
  })

  test('returns email verification links to the website', async ({ client, assert }) => {
    const response = await client
      .get('/api/v1/auth/verify-email?token=invalid&callbackURL=/')
      .redirects(0)

    response.assertStatus(302)
    assert.equal(
      response.header('location'),
      'https://blame.so/auth/verify-email?verified=true&error=INVALID_TOKEN'
    )
  })
})

test.group('auth', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('accepts Better Auth bearer tokens on protected routes', async ({ client, assert }) => {
    const email = `${crypto.randomUUID()}@example.com`
    const password = 'password123!'
    const signup = await client.post('/api/v1/auth/sign-up/email').json({
      email,
      name: 'Ada Lovelace',
      password,
    })
    signup.assertStatus(200)
    assert.match(signup.body().user.id, uuidV7Pattern)
    assert.isNull(signup.body().token)
    const user = await User.findByOrFail('email', email)
    assert.equal(user.id, signup.body().user.id)
    user.emailVerified = true
    await user.save()
    await db.from('users').where('id', user.id).update({ two_factor_enabled: false })

    const signIn = await client.post('/api/v1/auth/sign-in/email').json({ email, password })
    signIn.assertStatus(200)
    const token = signIn.header('set-auth-token')
    assert.isString(token)

    const profile = await client
      .get('/api/v1/account/profile')
      .header('Authorization', `Bearer ${token}`)

    profile.assertStatus(200)
  })

  test('completes desktop device authorization without a deep link', async ({ client, assert }) => {
    const email = `${crypto.randomUUID()}@example.com`
    await client.post('/api/v1/auth/sign-up/email').json({
      email,
      name: 'Ada Lovelace',
      password: 'password123!',
    })
    const user = await User.findByOrFail('email', email)
    const authorization = await client.post('/api/v1/auth/device/code').json({
      client_id: 'blame-desktop',
      scope: 'openid profile email',
    })

    authorization.assertStatus(200)
    assert.match(
      authorization.body().verification_uri_complete,
      /^https:\/\/blame\.so\/auth\/desktop\?user_code=/
    )
    assert.equal(authorization.body().interval, 5)

    await db
      .from('auth_device_codes')
      .where('device_code', authorization.body().device_code)
      .update({ status: 'approved', user_id: user.id })

    const tokenResponse = await client.post('/api/v1/auth/device/token').json({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: authorization.body().device_code,
      client_id: 'blame-desktop',
    })

    tokenResponse.assertStatus(200)
    assert.isString(tokenResponse.body().access_token)

    const exchangeResponse = await client
      .post('/api/v1/auth/desktop-device-exchange')
      .json({ token: tokenResponse.body().access_token })

    exchangeResponse.assertStatus(200)
    const bearerToken = exchangeResponse.body().data.token
    assert.isString(bearerToken)
    const temporarySessions = await db
      .from('auth_sessions')
      .where('token', tokenResponse.body().access_token)
      .count('* as total')
      .first()
    assert.equal(Number(temporarySessions.total), 0)

    const profile = await client
      .get('/api/v1/account/profile')
      .header('Authorization', `Bearer ${bearerToken}`)

    profile.assertStatus(200)
  })

  test('rejects unknown desktop authorization clients', async ({ client }) => {
    const response = await client.post('/api/v1/auth/device/code').json({
      client_id: 'unknown-client',
    })

    response.assertStatus(400)
  })

  test('requires an email OTP after a valid password', async ({ client, assert }) => {
    const email = `${crypto.randomUUID()}@example.com`
    const password = 'password123!'
    await client.post('/api/v1/auth/sign-up/email').json({
      email,
      name: 'Ada Lovelace',
      password,
    })
    const user = await User.findByOrFail('email', email)
    user.emailVerified = true
    await user.save()

    const signIn = await client.post('/api/v1/auth/sign-in/email').json({ email, password })

    signIn.assertStatus(200)
    assert.isTrue(signIn.body().twoFactorRedirect)
    assert.deepEqual(signIn.body().twoFactorMethods, ['otp'])
    assert.isUndefined(signIn.header('set-auth-token'))
    const sessions = await db.from('auth_sessions').where('user_id', user.id)
    assert.lengthOf(sessions, 0)
  })
})
