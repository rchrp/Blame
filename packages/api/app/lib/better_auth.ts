import { uuidV7 } from '#lib/uuid_v7'
import { sitePageUrl, siteUrl } from '#lib/site_url'
import {
  sendEmailVerificationEmail,
  sendPasswordResetEmail,
  sendSignInCodeEmail,
} from '#services/auth_email_service'
import env from '#start/env'
import hash from '@adonisjs/core/services/hash'
import { passkey } from '@better-auth/passkey'
import db from '@adonisjs/lucid/services/db'
import { betterAuth } from 'better-auth'
import { bearer, deviceAuthorization, twoFactor } from 'better-auth/plugins'
import { createPool } from 'mysql2/promise'
import { randomBytes } from 'node:crypto'

const baseURL = env.get('BETTER_AUTH_URL', env.get('APP_URL')).replace(/\/$/, '')
const betterAuthSecret = env.get('BETTER_AUTH_SECRET')?.release() ?? env.get('APP_KEY').release()
const socialProviders = configuredSocialProviders()

export const auth = betterAuth({
  appName: 'Blame',
  baseURL,
  basePath: '/api/v1/auth',
  secret: betterAuthSecret,
  database: createPool({
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: env.get('DB_USER'),
    password: env.get('DB_PASSWORD'),
    database: env.get('DB_DATABASE'),
    timezone: 'Z',
    connectionLimit: 10,
  }),
  advanced: {
    database: { generateId: () => uuidV7() },
    useSecureCookies: baseURL.startsWith('https://'),
    cookies: {
      two_factor: {
        attributes: baseURL.startsWith('https://')
          ? { sameSite: 'none', secure: true }
          : { sameSite: 'lax' },
      },
    },
  },
  trustedOrigins: trustedOrigins(),
  user: {
    modelName: 'users',
    fields: {
      name: 'full_name',
      emailVerified: 'email_verified',
      image: 'image',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  session: {
    modelName: 'auth_sessions',
    fields: {
      expiresAt: 'expires_at',
      token: 'token',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      userId: 'user_id',
    },
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  account: {
    modelName: 'auth_accounts',
    fields: {
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      scope: 'scope',
      password: 'password',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    accountLinking: {
      trustedProviders: ['google', 'github'],
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
      requireLocalEmailVerified: true,
      updateUserInfoOnLink: true,
    },
  },
  verification: {
    modelName: 'auth_verifications',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    autoSignIn: false,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 30,
    password: {
      hash: (password) => hash.make(password),
      verify: ({ hash: passwordHash, password }) => hash.verify(passwordHash, password),
    },
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({
        name: user.name,
        to: user.email,
        resetUrl: passwordResetUrl(url),
      })
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: false,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmailVerificationEmail({
        name: user.name,
        to: user.email,
        verificationUrl: verificationRedirectUrl(url),
      })
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({ data: { ...user, twoFactorEnabled: true } }),
        after: async (user) => createEmailTwoFactor(user.id),
      },
      update: { before: keepNameOnOAuthUpdate },
    },
  },
  socialProviders,
  plugins: [
    bearer({ requireSignature: true }),
    deviceAuthorization({
      expiresIn: '10m',
      interval: '5s',
      verificationUri: `${siteUrl}/auth/desktop`,
      validateClient: (clientId) => clientId === 'blame-desktop',
      schema: {
        deviceCode: {
          modelName: 'auth_device_codes',
          fields: {
            deviceCode: 'device_code',
            userCode: 'user_code',
            userId: 'user_id',
            expiresAt: 'expires_at',
            status: 'status',
            lastPolledAt: 'last_polled_at',
            pollingInterval: 'polling_interval',
            clientId: 'client_id',
            scope: 'scope',
          },
        },
      },
    }),
    twoFactor({
      twoFactorTable: 'auth_two_factors',
      totpOptions: { disable: true },
      backupCodeOptions: { storeBackupCodes: 'plain' },
      otpOptions: {
        period: 5,
        digits: 6,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        sendOTP: async ({ user, otp }) => {
          await sendSignInCodeEmail({ code: otp, name: user.name, to: user.email })
        },
      },
      schema: {
        user: { fields: { twoFactorEnabled: 'two_factor_enabled' } },
        twoFactor: {
          fields: {
            backupCodes: 'backup_codes',
            userId: 'user_id',
            failedVerificationCount: 'failed_verification_count',
            lockedUntil: 'locked_until',
          },
        },
      },
    }),
    passkey({
      rpName: 'Blame',
      rpID: new URL(siteUrl).hostname,
      origin: [new URL(siteUrl).origin, new URL(baseURL).origin],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
    }),
  ],
  rateLimit: {
    enabled: true,
    window: 60,
    max: 20,
  },
  telemetry: { enabled: false },
})

function trustedOrigins() {
  return Array.from(
    new Set([
      new URL(baseURL).origin,
      new URL(siteUrl).origin,
      ...env
        .get('BETTER_AUTH_TRUSTED_ORIGINS', '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ])
  )
}

function verificationRedirectUrl(generatedUrl: string) {
  const verificationUrl = new URL(generatedUrl)
  const callbackUrl = verificationUrl.searchParams.get('callbackURL')
  const destination = trustedVerificationPage(callbackUrl)
  if (!destination.searchParams.has('user_code')) {
    destination.searchParams.set('verified', 'true')
  }
  verificationUrl.searchParams.set('callbackURL', destination.toString())
  return verificationUrl.toString()
}

function passwordResetUrl(generatedUrl: string) {
  const resetUrl = new URL(generatedUrl)
  resetUrl.searchParams.set('callbackURL', sitePageUrl('/auth/reset-password'))
  return resetUrl.toString()
}

function trustedVerificationPage(value: string | null) {
  const fallback = new URL('/auth/verify-email', siteUrl)
  if (!value) return fallback
  const candidate = new URL(value, siteUrl)
  if (candidate.origin !== fallback.origin || candidate.pathname !== fallback.pathname) {
    return fallback
  }
  return candidate
}

function configuredSocialProviders() {
  const github = providerCredentials('GITHUB')
  const google = providerCredentials('GOOGLE')
  const microsoft = providerCredentials('MICROSOFT')
  return {
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
    ...(microsoft
      ? {
          microsoft: {
            ...microsoft,
            tenantId: env.get('MICROSOFT_TENANT_ID', 'common'),
            prompt: 'select_account' as const,
          },
        }
      : {}),
  }
}

function providerCredentials(prefix: 'GITHUB' | 'GOOGLE' | 'MICROSOFT') {
  const clientId = env.get(`${prefix}_CLIENT_ID`)?.trim()
  const clientSecret = env.get(`${prefix}_CLIENT_SECRET`)?.release().trim()
  // Signing in refreshes the profile photo; keepNameOnOAuthUpdate keeps the
  // person's own name.
  return clientId && clientSecret
    ? { clientId, clientSecret, overrideUserInfoOnSignIn: true }
    : undefined
}

async function createEmailTwoFactor(userId: string) {
  await db.table('auth_two_factors').insert({
    id: uuidV7(),
    secret: randomBytes(32).toString('base64url'),
    backup_codes: '[]',
    user_id: userId,
    verified: true,
    failed_verification_count: 0,
  })
}

// Google, GitHub and Microsoft sign-ins and links copy the provider profile
// onto the user. Only the photo should follow the provider: the name stays
// the one the person already has.
async function keepNameOnOAuthUpdate(
  data: Record<string, unknown>,
  context: {
    path?: string
    context?: { session?: { user?: { name?: string | null } } | null }
  } | null
) {
  if (!context?.path?.includes('/callback/') || !('name' in data)) return
  try {
    const sessionName = context.context?.session?.user?.name
    const row =
      sessionName || typeof data.email !== 'string'
        ? undefined
        : await db.from('users').where('email', data.email).select('full_name').first()
    const current = sessionName ?? (row?.full_name as string | null | undefined)
    if (current) return { data: { name: current } }
  } catch {
    // Keep the provider name rather than failing the sign-in.
  }
}
