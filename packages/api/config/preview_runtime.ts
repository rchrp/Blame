import env from '#start/env'
import {
  workspaceArtifactsReady,
  workspaceArtifactTransferHosts,
} from '#config/workspace_artifacts'

export type PreviewRuntimeConfig = ReturnType<typeof previewRuntimeConfig>

export function previewRuntimeConfig() {
  const vercelPlan = env.get('BLAME_SANDBOX_VERCEL_PLAN') ?? 'hobby'
  const maxRetainedSuspended = nonNegativeInteger(
    env.get('BLAME_PREVIEW_MAX_RETAINED_SUSPENDED'),
    4
  )
  const maxUnreferencedBaselines = positiveInteger(
    env.get('BLAME_PREVIEW_BASELINE_MAX_UNREFERENCED'),
    1
  )
  return {
    enabled: env.get('BLAME_CLOUD_RUNTIME_ENABLED') ?? false,
    maxActivePerUser: positiveInteger(env.get('BLAME_PREVIEW_MAX_ACTIVE_PER_USER'), 2),
    maxConcurrentVcpusPerUser: positiveInteger(
      env.get('BLAME_PREVIEW_MAX_CONCURRENT_VCPUS_PER_USER'),
      8
    ),
    maxCreationsPerMinute: positiveInteger(env.get('BLAME_PREVIEW_MAX_CREATIONS_PER_MINUTE'), 3),
    maxCreationsPerDay: positiveInteger(env.get('BLAME_PREVIEW_MAX_CREATIONS_PER_DAY'), 20),
    maxCreationsPerMonth: positiveInteger(env.get('BLAME_PREVIEW_MAX_CREATIONS_PER_MONTH'), 100),
    monthlyBudgetUsd: positiveNumber(env.get('BLAME_PREVIEW_MONTHLY_BUDGET_USD'), 20),
    globalMonthlyBudgetUsd: positiveNumber(
      env.get('BLAME_PREVIEW_GLOBAL_MONTHLY_BUDGET_USD'),
      1_000
    ),
    disabledTenantIds: new Set(csv(env.get('BLAME_PREVIEW_DISABLED_TENANT_IDS'))),
    idleTimeoutMinutes: positiveInteger(env.get('BLAME_PREVIEW_IDLE_TIMEOUT_MINUTES'), 15),
    suspendedRetentionMinutes: positiveInteger(
      env.get('BLAME_PREVIEW_SUSPENDED_RETENTION_MINUTES'),
      60
    ),
    maxRetainedSuspended:
      vercelPlan === 'hobby' ? Math.min(maxRetainedSuspended, 4) : maxRetainedSuspended,
    leaseSeconds: positiveInteger(env.get('BLAME_PREVIEW_LEASE_SECONDS'), 90),
    rpoSeconds: Math.min(10, positiveInteger(env.get('BLAME_PREVIEW_RPO_SECONDS'), 10)),
    baselines: {
      enabled:
        env.get('BLAME_PREVIEW_BASELINES_ENABLED') ??
        Boolean(env.get('BLAME_SANDBOX_RUNNER_IMAGE')),
      retentionDays: positiveInteger(env.get('BLAME_PREVIEW_BASELINE_RETENTION_DAYS'), 7),
      maxUnreferenced:
        vercelPlan === 'hobby' ? Math.min(maxUnreferencedBaselines, 1) : maxUnreferencedBaselines,
      waitSeconds: positiveInteger(env.get('BLAME_PREVIEW_BASELINE_WAIT_SECONDS'), 90),
      maxBuilders: positiveInteger(env.get('BLAME_PREVIEW_BASELINE_MAX_BUILDERS'), 1),
      cachePolicyVersion: '2',
    },
    edgeOrigin: secureOrigin(env.get('BLAME_PREVIEW_EDGE_ORIGIN') ?? 'https://preview.blame.dev'),
    ticketTtlSeconds: positiveInteger(env.get('BLAME_PREVIEW_TICKET_TTL_SECONDS'), 60),
    capabilityPublicKey: normalizePem(env.get('BLAME_PREVIEW_CAPABILITY_PUBLIC_KEY')),
    capabilityPrivateKey: normalizePem(env.get('BLAME_PREVIEW_CAPABILITY_PRIVATE_KEY')?.release()),
    workspaceEncryptionReady: workspaceArtifactsReady(),
    artifactTransferHosts: workspaceArtifactTransferHosts(),
    sandbox: {
      image: env.get('BLAME_SANDBOX_RUNNER_IMAGE'),
      runnerVersion: env.get('BLAME_SANDBOX_RUNNER_VERSION') ?? '0.2.19',
      protocolVersion: positiveInteger(env.get('BLAME_SANDBOX_PROTOCOL_VERSION'), 3),
      vercelPlan,
      timeoutMinutes: positiveInteger(env.get('BLAME_SANDBOX_TIMEOUT_MINUTES'), 60),
      snapshotRetentionDays: positiveInteger(env.get('BLAME_SANDBOX_SNAPSHOT_RETENTION_DAYS'), 7),
      deploymentId: env.get('BLAME_SANDBOX_DEPLOYMENT_ID'),
      egressAllowlist: Array.from(
        new Set([
          'registry.npmjs.org',
          '*.npmjs.org',
          'github.com',
          'codeload.github.com',
          '*.githubusercontent.com',
          'auth.docker.io',
          'registry-1.docker.io',
          'production.cloudfront.docker.com',
          'docker-images-prod.s3.dualstack.us-east-1.amazonaws.com',
          ...csv(env.get('BLAME_SANDBOX_EGRESS_ALLOWLIST')),
        ])
      ),
      accessToken: env.get('VERCEL_ACCESS_TOKEN')?.release(),
      projectId: env.get('VERCEL_PROJECT_ID'),
      teamId: env.get('VERCEL_TEAM_ID'),
    },
  }
}

function positiveInteger(value: number | undefined, fallback: number) {
  return value && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function positiveNumber(value: number | undefined, fallback: number) {
  return value && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function csv(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function secureOrigin(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Managed preview edge origin must use HTTPS.')
  }
  return url.origin
}

function normalizePem(value: string | undefined) {
  return value?.replaceAll('\\n', '\n')
}
