import { previewRuntimeConfig, type PreviewRuntimeConfig } from '#config/preview_runtime'
import { vercelNetworkPolicy } from '#services/sandboxes/vercel_network_policy'
import {
  desiredPorts,
  effectiveSandboxTimeoutMinutes,
  providerSnapshotMissing,
  shortTag,
  type VercelPlan,
} from '#services/sandboxes/vercel_sandbox_support'
import { Sandbox, Snapshot } from '@vercel/sandbox'
import type {
  PreviewBaselineBuildInput,
  PreviewBaselineBuildReceipt,
  PreviewBaselineProvider,
} from '#services/preview_baselines/preview_baseline_provider'
import { randomUUID } from 'node:crypto'

const runnerBinary = '/opt/blame/bin/blame-sandbox-runner'
const runnerControlBinary = '/opt/blame/bin/blame-runnerctl'
const runnerRequestDirectory = '/run/blame/control/requests'

type RunnerResponse<T> =
  { ok: true; result: T } | { ok: false; error: { code: string; message: string } }

export default class VercelSandboxBaselineProvider implements PreviewBaselineProvider {
  constructor(private readonly config: PreviewRuntimeConfig = previewRuntimeConfig()) {}

  async build(input: PreviewBaselineBuildInput): Promise<PreviewBaselineBuildReceipt> {
    const image = this.config.sandbox.image
    if (!image) throw new Error('Baseline runner image is not configured.')
    const name = `blame-baseline-${input.fingerprint.slice(0, 24)}`
    const sandbox = await Sandbox.create({
      ...this.credentials(),
      name,
      image,
      persistent: true,
      ports: desiredPorts(input.plan),
      resources: { vcpus: Math.min(4, 2) },
      timeout:
        effectiveSandboxTimeoutMinutes(
          this.config.sandbox.timeoutMinutes,
          this.config.sandbox.vercelPlan as VercelPlan
        ) * 60_000,
      snapshotExpiration: this.config.sandbox.snapshotRetentionDays * 86_400_000,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
      networkPolicy: vercelNetworkPolicy([
        ...this.config.sandbox.egressAllowlist,
        ...this.config.artifactTransferHosts,
      ]) as import('@vercel/sandbox').NetworkPolicy,
      tags: {
        application: 'blame',
        deployment: shortTag(this.config.sandbox.deploymentId ?? 'unconfigured'),
        baseline: shortTag(input.fingerprint),
      },
    })
    let snapshotCreated = false
    try {
      const bootstrap = await sandbox.runCommand({
        cmd: runnerBinary,
        args: ['bootstrap'],
        sudo: true,
        timeoutMs: 120_000,
      })
      if (bootstrap.exitCode !== 0) throw new Error('Baseline runner bootstrap failed.')
      await runnerCall(sandbox, {
        operation: 'source-import',
        source: input.source,
      })
      const warm = await runnerCall<{ serviceCachesWarmed: boolean }>(sandbox, {
        operation: 'warm-baseline',
        sessionId: `baseline-${input.fingerprint.slice(0, 24)}`,
        generation: 1,
        plan: input.plan,
        source: input.source,
      })
      if (!warm.serviceCachesWarmed) {
        throw new Error('Baseline service cache warmup failed.')
      }
      await runnerCall(sandbox, { operation: 'sanitize-snapshot' })
      const snapshot = await sandbox.snapshot({
        expiration: this.config.sandbox.snapshotRetentionDays * 86_400_000,
      })
      snapshotCreated = true
      return {
        provider: 'vercel-sandbox',
        providerSnapshotId: snapshot.snapshotId,
        ownerSandboxName: name,
        snapshotBytes: snapshot.sizeBytes,
      }
    } catch (error) {
      if (!snapshotCreated) await sandbox.delete().catch(() => undefined)
      throw cleanProviderError(error)
    }
  }

  async delete(input: { providerSnapshotId: string; ownerSandboxName?: string | null }) {
    let snapshotGone = false
    try {
      const snapshot = await Snapshot.get({
        ...this.credentials(),
        snapshotId: input.providerSnapshotId,
      })
      await snapshot.delete()
      snapshotGone = true
    } catch (error) {
      if (providerSnapshotMissing(error)) snapshotGone = true
      else throw cleanProviderError(error)
    }
    if (snapshotGone && input.ownerSandboxName) {
      try {
        const sandbox = await Sandbox.get({
          ...this.credentials(),
          name: input.ownerSandboxName,
          resume: false,
        })
        await sandbox.delete()
      } catch (error) {
        if (!providerNotFound(error)) throw cleanProviderError(error)
      }
    }
  }

  async exists(providerSnapshotId: string) {
    try {
      await Snapshot.get({ ...this.credentials(), snapshotId: providerSnapshotId })
      return true
    } catch (error) {
      if (providerSnapshotMissing(error)) return false
      throw cleanProviderError(error)
    }
  }

  private credentials() {
    const { accessToken: token, projectId, teamId } = this.config.sandbox
    return token && projectId && teamId ? { token, projectId, teamId } : {}
  }
}

async function runnerCall<T>(sandbox: Sandbox, request: Record<string, unknown>) {
  const requestPath = `${runnerRequestDirectory}/${randomUUID()}.json`
  await sandbox.asUser('root').writeFiles([
    {
      path: requestPath,
      content: JSON.stringify({ ...request, fencingToken: 1 }),
      mode: 0o600,
    },
  ])
  const command = await sandbox.runCommand({
    cmd: 'flock',
    args: [
      '--exclusive',
      '--wait',
      '120',
      '/run/blame/control/runner.lock',
      runnerControlBinary,
      '--request',
      requestPath,
    ],
    sudo: true,
    timeoutMs: 120_000,
  })
  const output = await command.stdout()
  let response: RunnerResponse<T>
  try {
    response = JSON.parse(output) as RunnerResponse<T>
  } catch {
    throw new Error('Baseline runner returned an invalid response.')
  }
  if (!response.ok) throw new Error(`Baseline runner failed: ${response.error.code}`)
  if (command.exitCode !== 0) throw new Error('Baseline runner request failed.')
  return response.result
}

function cleanProviderError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Vercel baseline operation failed.'
  return new Error(
    message
      .replace(/https?:\/\/[^\s"']+/gi, '[redacted-url]')
      .replace(
        /\b(token|secret|password|credential|signature)\s*[:=]\s*[^\s,;]+/gi,
        '$1=[redacted]'
      )
      .replace(/\s+/g, ' ')
      .slice(0, 500)
  )
}

function providerNotFound(error: unknown) {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const response =
    value.response && typeof value.response === 'object'
      ? (value.response as Record<string, unknown>)
      : undefined
  return Number(response?.status ?? value.status ?? 0) === 404
}
