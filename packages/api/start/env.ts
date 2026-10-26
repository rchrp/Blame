/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  // Node
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  // App
  APP_KEY: Env.schema.secret(),
  APP_KEY_PREVIOUS: Env.schema.secret.optional(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),
  CORS_ORIGIN: Env.schema.string.optional(),
  BETTER_AUTH_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  BETTER_AUTH_SECRET: Env.schema.secret.optional(),
  BETTER_AUTH_TRUSTED_ORIGINS: Env.schema.string.optional(),
  BLAME_SITE_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  BLAME_MODEL_CATALOG_LIVE_REFRESH: Env.schema.boolean.optional(),
  BLAME_MODEL_CATALOG_REFRESH_HOURS: Env.schema.number.optional(),
  BLAME_MODELS_DEV_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  OPENROUTER_API_KEY: Env.schema.secret.optional(),
  BLAME_SPEECH_TO_TEXT_MODEL: Env.schema.string.optional(),
  BLAME_SPEECH_TO_TEXT_REQUESTS_PER_MINUTE: Env.schema.number.optional(),
  BLAME_SPEECH_TO_TEXT_MAX_CONCURRENT: Env.schema.number.optional(),
  BLAME_SPEECH_TO_TEXT_TIMEOUT_MS: Env.schema.number.optional(),
  AUTH_EMAIL_FROM: Env.schema.string.optional(),
  RESEND_API_KEY: Env.schema.secret.optional(),
  GITHUB_CLIENT_ID: Env.schema.string.optional(),
  GITHUB_CLIENT_SECRET: Env.schema.secret.optional(),
  GOOGLE_CLIENT_ID: Env.schema.string.optional(),
  GOOGLE_CLIENT_SECRET: Env.schema.secret.optional(),
  MICROSOFT_CLIENT_ID: Env.schema.string.optional(),
  MICROSOFT_CLIENT_SECRET: Env.schema.secret.optional(),
  MICROSOFT_TENANT_ID: Env.schema.string.optional(),
  ACCOUNT_CLOSURE_LEDGER_DIRECTORY: Env.schema.string.optional(),
  BLAME_TELEMETRY_MAX_PAYLOAD_BYTES: Env.schema.number.optional(),
  BLAME_TELEMETRY_PUBLIC_ENDPOINT: Env.schema.string({ format: 'url', tld: false }),
  BLAME_TELEMETRY_REQUESTS_PER_MINUTE: Env.schema.number.optional(),
  BLAME_TELEMETRY_TOKEN_SECRET: Env.schema.secret(),
  BLAME_TELEMETRY_TOKEN_TTL_SECONDS: Env.schema.number.optional(),
  BLAME_TELEMETRY_UPSTREAM_ENDPOINT: Env.schema.string({ format: 'url', tld: false }),
  BLAME_TELEMETRY_UPSTREAM_HEADERS: Env.schema.secret.optional(),
  BLAME_TELEMETRY_UPSTREAM_TIMEOUT_MS: Env.schema.number.optional(),
  ATTACHMENTS_STORAGE_DRIVER: Env.schema.enum.optional(['s3', 'memory'] as const),
  ATTACHMENTS_MAX_BYTES: Env.schema.number.optional(),
  ATTACHMENTS_DOWNLOAD_URL_TTL_SECONDS: Env.schema.number.optional(),
  ATTACHMENTS_UPLOAD_URL_TTL_SECONDS: Env.schema.number.optional(),
  ATTACHMENTS_ORPHAN_GRACE_HOURS: Env.schema.number.optional(),
  ATTACHMENTS_S3_ENDPOINT: Env.schema.string.optional({ format: 'url', tld: false }),
  ATTACHMENTS_S3_REGION: Env.schema.string.optional(),
  ATTACHMENTS_S3_BUCKET: Env.schema.string.optional(),
  ATTACHMENTS_S3_ACCESS_KEY_ID: Env.schema.secret.optional(),
  ATTACHMENTS_S3_SECRET_ACCESS_KEY: Env.schema.secret.optional(),
  ATTACHMENTS_S3_FORCE_PATH_STYLE: Env.schema.boolean.optional(),

  // Managed preview workspace artifacts (server-only, separate from conversation attachments)
  BLAME_WORKSPACE_STORAGE_DRIVER: Env.schema.enum.optional(['s3', 'memory'] as const),
  BLAME_WORKSPACE_DOWNLOAD_URL_TTL_SECONDS: Env.schema.number.optional(),
  BLAME_WORKSPACE_UPLOAD_URL_TTL_SECONDS: Env.schema.number.optional(),
  BLAME_WORKSPACE_S3_ENDPOINT: Env.schema.string.optional({ format: 'url', tld: false }),
  BLAME_WORKSPACE_S3_REGION: Env.schema.string.optional(),
  BLAME_WORKSPACE_S3_BUCKET: Env.schema.string.optional(),
  BLAME_WORKSPACE_S3_ACCESS_KEY_ID: Env.schema.secret.optional(),
  BLAME_WORKSPACE_S3_SECRET_ACCESS_KEY: Env.schema.secret.optional(),
  BLAME_WORKSPACE_S3_FORCE_PATH_STYLE: Env.schema.boolean.optional(),

  // Managed preview runtime (server-only)
  BLAME_CLOUD_RUNTIME_ENABLED: Env.schema.boolean.optional(),
  BLAME_PREVIEW_MAX_ACTIVE_PER_USER: Env.schema.number.optional(),
  BLAME_PREVIEW_MAX_CONCURRENT_VCPUS_PER_USER: Env.schema.number.optional(),
  BLAME_PREVIEW_MAX_CREATIONS_PER_MINUTE: Env.schema.number.optional(),
  BLAME_PREVIEW_MAX_CREATIONS_PER_DAY: Env.schema.number.optional(),
  BLAME_PREVIEW_MAX_CREATIONS_PER_MONTH: Env.schema.number.optional(),
  BLAME_PREVIEW_MONTHLY_BUDGET_USD: Env.schema.number.optional(),
  BLAME_PREVIEW_GLOBAL_MONTHLY_BUDGET_USD: Env.schema.number.optional(),
  BLAME_PREVIEW_DISABLED_TENANT_IDS: Env.schema.string.optional(),
  BLAME_PREVIEW_IDLE_TIMEOUT_MINUTES: Env.schema.number.optional(),
  BLAME_PREVIEW_SUSPENDED_RETENTION_MINUTES: Env.schema.number.optional(),
  BLAME_PREVIEW_MAX_RETAINED_SUSPENDED: Env.schema.number.optional(),
  BLAME_PREVIEW_LEASE_SECONDS: Env.schema.number.optional(),
  BLAME_PREVIEW_RPO_SECONDS: Env.schema.number.optional(),
  BLAME_PREVIEW_EDGE_ORIGIN: Env.schema.string.optional({ format: 'url', tld: false }),
  BLAME_PREVIEW_TICKET_TTL_SECONDS: Env.schema.number.optional(),
  BLAME_PREVIEW_CAPABILITY_PUBLIC_KEY: Env.schema.string.optional(),
  BLAME_PREVIEW_CAPABILITY_PRIVATE_KEY: Env.schema.secret.optional(),
  BLAME_PREVIEW_EDGE_CONTROL_TOKEN: Env.schema.secret.optional(),
  BLAME_SANDBOX_RUNNER_IMAGE: Env.schema.string.optional(),
  BLAME_SANDBOX_RUNNER_VERSION: Env.schema.string.optional(),
  BLAME_SANDBOX_PROTOCOL_VERSION: Env.schema.number.optional(),
  BLAME_SANDBOX_VERCEL_PLAN: Env.schema.enum.optional(['hobby', 'pro', 'enterprise'] as const),
  BLAME_SANDBOX_TIMEOUT_MINUTES: Env.schema.number.optional(),
  BLAME_SANDBOX_SNAPSHOT_RETENTION_DAYS: Env.schema.number.optional(),
  BLAME_SANDBOX_DEPLOYMENT_ID: Env.schema.string.optional(),
  BLAME_SANDBOX_EGRESS_ALLOWLIST: Env.schema.string.optional(),
  BLAME_PREVIEW_BASELINES_ENABLED: Env.schema.boolean.optional(),
  BLAME_PREVIEW_BASELINE_RETENTION_DAYS: Env.schema.number.optional(),
  BLAME_PREVIEW_BASELINE_MAX_UNREFERENCED: Env.schema.number.optional(),
  BLAME_PREVIEW_BASELINE_WAIT_SECONDS: Env.schema.number.optional(),
  BLAME_PREVIEW_BASELINE_MAX_BUILDERS: Env.schema.number.optional(),
  VERCEL_ACCESS_TOKEN: Env.schema.secret.optional(),
  VERCEL_PROJECT_ID: Env.schema.string.optional(),
  VERCEL_TEAM_ID: Env.schema.string.optional(),
  VERCEL_INTEGRATION_CLIENT_ID: Env.schema.string.optional(),
  VERCEL_INTEGRATION_CLIENT_SECRET: Env.schema.secret.optional(),
  VERCEL_INTEGRATION_SLUG: Env.schema.string.optional(),
  VERCEL_INTEGRATION_REDIRECT_URI: Env.schema.string.optional({ format: 'url', tld: false }),

  SEARXNG_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),

  // Session
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'database'] as const),

  // Stripe Billing
  STRIPE_SECRET_KEY: Env.schema.string.optional(),
  STRIPE_WEBHOOK_SECRET: Env.schema.string.optional(),
  STRIPE_MONTHLY_PRICE_ID: Env.schema.string.optional(),
  STRIPE_YEARLY_PRICE_ID: Env.schema.string.optional(),
  STRIPE_CHECKOUT_SUCCESS_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  STRIPE_CHECKOUT_CANCEL_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  STRIPE_PORTAL_RETURN_URL: Env.schema.string.optional({ format: 'url', tld: false }),
})
