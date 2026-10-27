import { previewRuntimeConfig, type PreviewRuntimeConfig } from '#config/preview_runtime'
import PreviewEdgeRouteService from '#services/preview_gateway/preview_edge_route_service'
import { vercelNetworkPolicy } from '#services/sandboxes/vercel_network_policy'
import WorkspaceArtifactService from '#services/workspace_artifacts/workspace_artifact_service'
import { Sandbox, Snapshot, type NetworkPolicy } from '@vercel/sandbox'
import {
  ATTR_BLAME_OPERATION_STATUS,
  ATTR_BLAME_RUNTIME_NAME,
  ATTR_BLAME_RUNTIME_PHASE,
  getBlameTelemetry,
} from '@blame/telemetry'
import { randomUUID } from 'node:crypto'
import {
  PreviewRuntimeError,
  resolveCapabilities,
  runtimeHandle,
  type DurableDeltaReceipt,
  type EndpointMap,
  type ExecInput,
  type ExecResult,
  type LogRequest,
  type PreviewExecutionPlan,
  type PreviewLogEvent,
  type PreviewRuntimeDriver,
  type PreviewStartReceipt,
  type ProvisionInput,
  type RuntimeHandle,
  type RuntimeInspectOptions,
  type RuntimeObservation,
  type RuntimeProtocolHandshake,
  type RuntimeSelection,
  type RuntimeUsage,
  type SourceArtifact,
  type SyncInOptions,
} from '@blame/preview-runtime'
import {
  capabilityKeysMatch,
  backgroundRunnerCallOptions,
  delay,
  desiredPorts,
  effectiveSandboxTimeoutMinutes,
  inactiveObservation,
  ownedSnapshotIdForDeletion,
  providerFailure,
  providerResourceMissing,
  retryableProviderError,
  runnerFailure,
  sandboxNameFor,
  shortTag,
  vercelPlanLimits,
  vercelHandle,
  type VercelRuntimeHandle,
  type RunnerCallOptions,
} from '#services/sandboxes/vercel_sandbox_support'
type RunnerResponse<T> =
  { ok: true; result: T } | { ok: false; error: { code: string; message: string } }

type RunnerEndpointMap = {
  revision: number
  primaryRouteId: string
  routes: Array<{
    routeId: string
    serviceId: string
    endpointId: string
    protocol: 'http' | 'https' | 'ws' | 'wss'
    logicalPort: number
    targetHost: string
    targetPort: number
    sandboxPort: number
    basePathMode: 'root' | 'explicit-prefix'
    externallyCompatible: boolean
  }>
  supportsWebSocket: boolean
  integratedPreviewRequired: boolean
  incompatibilityReasons: string[]
}

const runnerBinary = '/opt/blame/bin/blame-sandbox-runner'
const runnerControlBinary = '/opt/blame/bin/blame-runnerctl'
const runnerRequestDirectory = '/run/blame/control/requests'
const telemetry = getBlameTelemetry()

export default class VercelSandboxDriver implements PreviewRuntimeDriver {
  readonly profile = 'vercel-compose' as const

  constructor(
    private readonly config: PreviewRuntimeConfig = previewRuntimeConfig(),
    private readonly routes: PreviewEdgeRouteService = new PreviewEdgeRouteService(config),
    private readonly artifacts: WorkspaceArtifactService = new WorkspaceArtifactService()
  ) {}

  limits() {
    const planLimits = vercelPlanLimits(this.config.sandbox.vercelPlan)
    return {
      observedAt: new Date().toISOString(),
      maxDurationHours: planLimits.maxDurationMinutes / 60,
      maxPublishedPorts: 15,
      maxVcpus: planLimits.maxVcpus,
      memoryGbPerVcpu: 2,
      region: 'iad1',
      source: '@vercel/sandbox@2.9.2',
    }
  }

  async capabilities(plan: PreviewExecutionPlan) {
    const report = resolveCapabilities(this.profile, plan)
    const configurationFailure = this.configurationFailure()
    if (configurationFailure) {
      report.compatible = false
      report.incompatibilities.push({
        code: 'CAPABILITY_REQUIRED',
        message: configurationFailure,
      })
    }
    return report
  }

  async provisionHost(input: ProvisionInput) {
    const configurationFailure = this.configurationFailure()
    if (configurationFailure) {
      throw new PreviewRuntimeError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: configurationFailure,
        retryable: false,
      })
    }
    this.assertResourceSize(input.resourceSize)
    const gatewayPorts = desiredPorts(input.plan)
    const sandboxName = sandboxNameFor(input.sessionId)
    const timeout =
      effectiveSandboxTimeoutMinutes(
        this.config.sandbox.timeoutMinutes,
        this.config.sandbox.vercelPlan
      ) * 60_000
    const sandboxOptions = {
      ...this.credentials(),
      name: sandboxName,
      persistent: true,
      ports: gatewayPorts,
      resources: { vcpus: input.resourceSize.vcpus },
      timeout,
      snapshotExpiration: this.config.sandbox.snapshotRetentionDays * 86_400_000,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
      networkPolicy: this.networkPolicy(),
      tags: {
        application: 'blame',
        deployment: shortTag(this.config.sandbox.deploymentId!),
        session: shortTag(input.sessionId),
      },
    }
    const sandbox = await measureRuntimePhase(
      input.source ? 'baseline.restore' : 'sandbox.create',
      async () => {
        if (!input.source) {
          return this.providerCall('create', () =>
            Sandbox.getOrCreate({ ...sandboxOptions, image: this.config.sandbox.image! })
          )
        }
        if (!/^snap_[a-zA-Z0-9_-]+$/.test(input.source.snapshotId)) {
          throw runnerFailure('BASELINE_SNAPSHOT_INVALID', 'Baseline snapshot identity is invalid.')
        }
        const existing = await this.findSandboxByName(sandboxName, true)
        if (existing) return existing
        return this.providerCall('baseline-restore', () =>
          Sandbox.create({
            ...sandboxOptions,
            source: { type: 'snapshot', snapshotId: input.source!.snapshotId },
          })
        )
      }
    )
    try {
      await sandbox.update({
        persistent: true,
        ports: gatewayPorts,
        resources: { vcpus: input.resourceSize.vcpus },
        timeout,
        snapshotExpiration: this.config.sandbox.snapshotRetentionDays * 86_400_000,
        keepLastSnapshots: { count: 1, deleteEvicted: true },
        networkPolicy: this.networkPolicy(),
      })
      await this.bootstrap(sandbox)
      const handle: VercelRuntimeHandle = {
        kind: 'vercel-sandbox',
        sandboxName,
        sessionId: input.sessionId,
        generation: input.generation,
        fencingToken: input.fencingToken,
        gatewayPorts,
        resourceVcpus: input.resourceSize.vcpus,
      }
      const runtime = runtimeHandle(handle)
      const handshake = await this.assertHandshake(sandbox, runtime)
      if (input.source) {
        await this.runnerCallWithSandbox(sandbox, runtime, {
          operation: 'resume-host',
          sessionId: input.sessionId,
          generation: input.generation,
        })
      }
      return {
        handle: runtime,
        observation: {
          host: 'running' as const,
          engine: input.source ? ('stopped' as const) : ('idle' as const),
          generation: input.generation,
          services: [],
          handshake,
        },
      }
    } catch (error) {
      await sandbox.delete().catch(() => undefined)
      throw error
    }
  }

  async resumeHost(handle: RuntimeHandle) {
    const payload = vercelHandle(handle)
    payload.generation += 1
    const sandbox = await this.sandbox(payload, true)
    await sandbox.update({ ports: payload.gatewayPorts, networkPolicy: this.networkPolicy() })
    await this.bootstrap(sandbox)
    const handshake = await this.assertHandshake(sandbox, handle)
    await this.runnerCallWithSandbox(sandbox, handle, {
      operation: 'resume-host',
      sessionId: payload.sessionId,
      generation: payload.generation,
    })
    return {
      host: 'running' as const,
      engine: 'stopped' as const,
      generation: payload.generation,
      services: [],
      handshake,
    }
  }

  async syncIn(handle: RuntimeHandle, source: SourceArtifact, options: SyncInOptions = {}) {
    return measureRuntimePhase('workspace.sync', () =>
      this.runnerCall<{ sourceRevision: string; workspaceHash: string }>(handle, {
        operation: 'source-import',
        source,
        preserveWarmCaches: options.preserveWarmCaches,
      })
    )
  }

  async restoreBaseline(handle: RuntimeHandle, snapshotId: string) {
    return measureRuntimePhase('baseline.restore', async () => {
      const payload = vercelHandle(handle)
      if (!/^snap_[a-zA-Z0-9_-]+$/.test(snapshotId)) {
        throw runnerFailure('BASELINE_SNAPSHOT_INVALID', 'Baseline snapshot identity is invalid.')
      }
      const previous = await this.findSandbox(payload, false)
      if (previous) await this.deleteSandbox(previous, 'replace-baseline-sandbox')
      const timeout =
        effectiveSandboxTimeoutMinutes(
          this.config.sandbox.timeoutMinutes,
          this.config.sandbox.vercelPlan
        ) * 60_000
      let sandbox: Sandbox | undefined
      try {
        sandbox = await this.providerCall('baseline-restore', () =>
          Sandbox.create({
            ...this.credentials(),
            name: payload.sandboxName,
            source: { type: 'snapshot', snapshotId },
            persistent: true,
            ports: payload.gatewayPorts,
            resources: { vcpus: payload.resourceVcpus ?? 2 },
            timeout,
            snapshotExpiration: this.config.sandbox.snapshotRetentionDays * 86_400_000,
            keepLastSnapshots: { count: 1, deleteEvicted: true },
            networkPolicy: this.networkPolicy(),
            tags: {
              application: 'blame',
              deployment: shortTag(this.config.sandbox.deploymentId!),
              session: shortTag(payload.sessionId),
            },
          })
        )
        await this.bootstrap(sandbox)
        const restored = runtimeHandle({ ...payload })
        await this.assertHandshake(sandbox, restored)
        await this.runnerCallWithSandbox(sandbox, restored, {
          operation: 'resume-host',
          sessionId: payload.sessionId,
          generation: payload.generation,
        })
        return restored
      } catch (error) {
        await sandbox?.delete().catch(() => undefined)
        throw error
      }
    })
  }

  async prepareEngine(handle: RuntimeHandle, plan: PreviewExecutionPlan) {
    const payload = vercelHandle(handle)
    const { browserBindingUrls, routeIds } = await this.publishPlannedRoutes(payload, plan)
    await measureRuntimePhase('compose.prepare', () =>
      this.runnerCall(handle, {
        operation: 'prepare-engine',
        plan,
        browserBindingUrls,
        routeIds,
        capabilityPublicKey: this.config.capabilityPublicKey,
        sessionId: payload.sessionId,
        generation: payload.generation,
      })
    )
  }

  async startServices(handle: RuntimeHandle, selection: RuntimeSelection) {
    await measureRuntimePhase('services.start', () =>
      this.runnerCall(handle, { operation: 'start-services', selection })
    )
  }

  async startPreview(
    handle: RuntimeHandle,
    plan: PreviewExecutionPlan,
    selection: RuntimeSelection
  ): Promise<PreviewStartReceipt> {
    const payload = vercelHandle(handle)
    const { browserBindingUrls, routeIds } = await this.publishPlannedRoutes(payload, plan)
    const sandbox = await this.sandbox(payload, true)
    const started = await measureRuntimePhase('preview.start', () =>
      this.runnerCallWithSandbox<{
        observation: RuntimeObservation
        endpoints: RunnerEndpointMap
      }>(sandbox, handle, {
        operation: 'start-preview',
        plan,
        selection,
        browserBindingUrls,
        routeIds,
        capabilityPublicKey: this.config.capabilityPublicKey,
        sessionId: payload.sessionId,
        generation: payload.generation,
      })
    )
    started.observation.generation ??= payload.generation
    if (started.observation.handshake) {
      started.observation.handshake.imageDigest =
        sandbox.image?.split('@').at(-1) ?? started.observation.handshake.imageDigest
    }
    return {
      observation: started.observation,
      endpointMap: await this.publishEndpointMap(payload, sandbox, started.endpoints),
    }
  }

  async stopServices(handle: RuntimeHandle) {
    await this.runnerCall(handle, { operation: 'stop-services' })
    await this.routes.revokeSession(vercelHandle(handle).sessionId)
  }

  async exec(handle: RuntimeHandle, input: ExecInput) {
    const cwd = input.cwd ?? '/workspace'
    if (cwd !== '/workspace' && !cwd.startsWith('/workspace/')) {
      throw new PreviewRuntimeError({
        code: 'PREVIEW_ACCESS_DENIED',
        message: 'Remote commands are restricted to the story workspace.',
        retryable: false,
      })
    }
    return this.runnerCall<ExecResult>(handle, {
      operation: 'exec',
      command: input.command,
      args: input.args ?? [],
      cwd,
      environment: input.environment,
      timeoutMs: input.timeoutMs,
    })
  }

  async inspect(
    handle: RuntimeHandle,
    options: RuntimeInspectOptions = {}
  ): Promise<RuntimeObservation> {
    const payload = vercelHandle(handle)
    const sandbox = await this.findSandbox(payload, false)
    if (!sandbox) return inactiveObservation(payload.generation, 'missing', 'idle')
    if (['stopped', 'aborted', 'snapshotting'].includes(sandbox.status)) {
      return inactiveObservation(payload.generation, 'suspended', 'stopped')
    }
    if (sandbox.status === 'failed')
      return inactiveObservation(payload.generation, 'failed', 'failed')
    if (sandbox.status !== 'running')
      return inactiveObservation(payload.generation, 'running', 'idle')
    const observation = await this.runnerCall<RuntimeObservation>(
      handle,
      {
        operation: 'inspect',
        probeServices: options.probeServices,
      },
      backgroundRunnerCallOptions(Boolean(options.background))
    )
    observation.generation ??= payload.generation
    if (observation.handshake) {
      observation.handshake.imageDigest =
        sandbox.image?.split('@').at(-1) ?? observation.handshake.imageDigest
    }
    return observation
  }

  async endpoints(handle: RuntimeHandle): Promise<EndpointMap> {
    const payload = vercelHandle(handle)
    const sandbox = await this.sandbox(payload, true)
    const internal = await this.runnerCallWithSandbox<RunnerEndpointMap>(sandbox, handle, {
      operation: 'endpoints',
    })
    return this.publishEndpointMap(payload, sandbox, internal)
  }

  private async publishEndpointMap(
    payload: VercelRuntimeHandle,
    sandbox: Sandbox,
    internal: RunnerEndpointMap
  ): Promise<EndpointMap> {
    const routes = await Promise.all(
      internal.routes.map(async (route) => {
        if (!payload.gatewayPorts.includes(route.sandboxPort)) {
          throw runnerFailure(
            'UNDECLARED_GATEWAY_PORT',
            'Runner returned an undeclared gateway port.'
          )
        }
        const providerUrl = sandbox.domain(route.sandboxPort)
        const published = await this.routes.publish({
          sessionId: payload.sessionId,
          endpointId: route.endpointId,
          serviceId: route.serviceId,
          logicalPort: route.logicalPort,
          generation: payload.generation,
          upstreamUrl: providerUrl,
        })
        if (published.id !== route.routeId) {
          throw runnerFailure('ROUTE_ID_MISMATCH', 'Runner route identity is invalid.')
        }
        return { ...route, logicalHost: 'localhost' as const, publicUrl: published.publicUrl }
      })
    )
    const primary = routes.find(({ routeId }) => routeId === internal.primaryRouteId)
    return {
      revision: internal.revision,
      primaryRouteId: internal.primaryRouteId,
      primaryPublicUrl: primary?.publicUrl ?? '',
      routes,
      supportsWebSocket: internal.supportsWebSocket,
      integratedPreviewRequired: internal.integratedPreviewRequired,
      incompatibilityReasons: internal.incompatibilityReasons,
    }
  }

  async *logs(input: LogRequest): AsyncIterable<PreviewLogEvent> {
    const events = await this.runnerCall<PreviewLogEvent[]>(input.handle, {
      operation: 'logs',
      cursor: input.cursor,
      serviceId: input.serviceId,
    })
    for (const event of events) yield event
  }

  async exportDelta(handle: RuntimeHandle, revision: string): Promise<DurableDeltaReceipt> {
    const payload = vercelHandle(handle)
    const artifact = await this.artifacts.prepareDeltaUpload(payload.sessionId, payload.generation)
    const prepared = await this.runnerCall<{
      sha256: string
      size: number
      baseHash: string
      finalHash: string
      generation: number
      revision: string
    }>(handle, { operation: 'source-export-prepare', revision, artifactId: artifact.artifactId })
    if (prepared.generation !== payload.generation) {
      throw runnerFailure('DELTA_GENERATION_MISMATCH', 'Runner delta generation is stale.')
    }
    const upload = await this.artifacts.deltaUploadTarget(
      artifact.artifactId,
      prepared.sha256,
      prepared.size
    )
    await this.runnerCall(handle, {
      operation: 'source-export-upload',
      artifactId: artifact.artifactId,
      upload,
    })
    const receipt = {
      artifactId: artifact.artifactId,
      baseHash: prepared.baseHash,
      finalHash: prepared.finalHash,
      generation: payload.generation,
      revision: prepared.revision,
      durableAt: new Date().toISOString(),
      sha256: prepared.sha256,
      size: prepared.size,
    }
    await this.artifacts.confirmDelta(receipt)
    return receipt
  }

  async acknowledgeDelta(handle: RuntimeHandle, revision: string) {
    await this.runnerCall(handle, { operation: 'source-export-ack', revision })
  }

  async suspendHost(handle: RuntimeHandle) {
    const payload = vercelHandle(handle)
    const sandbox = await this.findSandbox(payload, false)
    await this.routes.revokeSession(payload.sessionId)
    if (!sandbox || ['stopped', 'aborted'].includes(sandbox.status)) {
      return { snapshotId: sandbox?.currentSnapshotId, suspendedAt: new Date().toISOString() }
    }
    const snapshot = await this.providerCall('snapshot', () =>
      sandbox.snapshot({ expiration: this.config.sandbox.snapshotRetentionDays * 86_400_000 })
    )
    return { snapshotId: snapshot.snapshotId, suspendedAt: new Date().toISOString() }
  }

  async destroyHost(handle: RuntimeHandle) {
    const payload = vercelHandle(handle)
    await this.routes.revokeSession(payload.sessionId)
    const sandbox = await this.findSandbox(payload, false)
    if (!sandbox) return { destroyedAt: new Date().toISOString(), pendingCleanupIds: [] }
    await this.deleteSandbox(sandbox, 'delete')
    return { destroyedAt: new Date().toISOString(), pendingCleanupIds: [] }
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage> {
    const sandbox = await this.sandbox(vercelHandle(handle), false)
    const snapshotBytes = sandbox.currentSnapshotId
      ? await this.providerCall('snapshot-usage', () =>
          Snapshot.get({
            ...this.credentials(),
            snapshotId: sandbox.currentSnapshotId!,
          }).then((snapshot) => snapshot.sizeBytes)
        )
      : 0
    const activeCpuSeconds = (sandbox.totalActiveCpuDurationMs ?? 0) / 1000
    const durationSeconds = Math.max(0, (sandbox.totalDurationMs ?? 0) / 1000)
    const memoryGb = sandbox.memory ? sandbox.memory / 1024 : (sandbox.vcpus ?? 2) * 2
    const memoryGbSeconds = durationSeconds * memoryGb
    return {
      activeCpuSeconds,
      memoryGbSeconds,
      ingressBytes: sandbox.totalIngressBytes ?? 0,
      egressBytes: sandbox.totalEgressBytes ?? 0,
      snapshotBytes,
      estimatedCostUsd:
        (activeCpuSeconds / 3600) * 0.128 +
        (memoryGbSeconds / 3600) * 0.0212 +
        (((sandbox.totalIngressBytes ?? 0) + (sandbox.totalEgressBytes ?? 0)) / 1024 ** 3) * 0.15 +
        0.0000006,
      observedAt: new Date().toISOString(),
    }
  }

  async sweepOrphans(activeSessionIds: string[], olderThan: string) {
    const deploymentId = this.config.sandbox.deploymentId
    if (!deploymentId) throw new Error('Sandbox deployment ID is not configured.')
    const activeNames = new Set(activeSessionIds.map(sandboxNameFor))
    const cutoff = Date.parse(olderThan)
    const sandboxes = await this.providerCall('list', () =>
      Sandbox.list({
        ...this.credentials(),
        namePrefix: 'blame-',
        sortBy: 'name',
        tags: { application: 'blame' },
      }).then((result) => result.toArray())
    )
    let deleted = 0
    for (const sandbox of sandboxes) {
      if (sandbox.tags?.deployment !== shortTag(deploymentId)) continue
      const createdAt =
        sandbox.createdAt < 10_000_000_000 ? sandbox.createdAt * 1000 : sandbox.createdAt
      if (activeNames.has(sandbox.name) || createdAt >= cutoff) continue
      const resource = await this.providerCall('get-orphan', () =>
        Sandbox.get({
          ...this.credentials(),
          name: sandbox.name,
          resume: false,
        })
      )
      await this.deleteSandbox(resource, 'delete-orphan')
      deleted += 1
    }
    return { deleted }
  }

  private async deleteSandbox(sandbox: Sandbox, operation: string) {
    const snapshotId = ownedSnapshotIdForDeletion(sandbox.status, sandbox.currentSnapshotId)
    if (snapshotId) {
      await this.providerCall(`${operation}-snapshot`, async () => {
        try {
          const snapshot = await Snapshot.get({
            ...this.credentials(),
            snapshotId,
          })
          if (snapshot.status !== 'deleted') await snapshot.delete()
        } catch (error) {
          if (!providerResourceMissing(error)) throw error
        }
      })
    }
    await this.providerCall(operation, () => sandbox.delete())
  }

  private async runnerCall<T>(
    handle: RuntimeHandle,
    request: Record<string, unknown>,
    options?: RunnerCallOptions
  ) {
    const payload = vercelHandle(handle)
    const sandbox = await this.sandbox(payload, true)
    return this.runnerCallWithSandbox<T>(sandbox, handle, request, options)
  }

  private async runnerCallWithSandbox<T>(
    sandbox: Sandbox,
    handle: RuntimeHandle,
    request: Record<string, unknown>,
    options: RunnerCallOptions = {}
  ) {
    const payload = vercelHandle(handle)
    const requestPath = `${runnerRequestDirectory}/${randomUUID()}.json`
    await sandbox.asUser('root').writeFiles([
      {
        path: requestPath,
        content: JSON.stringify({ ...request, fencingToken: payload.fencingToken }),
        mode: 0o600,
      },
    ])
    const command = await this.providerCall('runner', () =>
      sandbox.runCommand({
        cmd: 'flock',
        args: [
          '--exclusive',
          '--conflict-exit-code',
          '75',
          '--wait',
          String(options.lockWaitSeconds ?? 120),
          '/run/blame/control/runner.lock',
          runnerControlBinary,
          '--request',
          requestPath,
        ],
        sudo: true,
        timeoutMs: options.timeoutMs ?? 120_000,
      })
    )
    if (command.exitCode === 75 && options.busyProviderCode) {
      throw new PreviewRuntimeError({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'The preview runner is busy with an interactive operation.',
        providerCode: options.busyProviderCode,
        retryable: true,
      })
    }
    const output = await command.stdout()
    let response: RunnerResponse<T>
    try {
      response = JSON.parse(output) as RunnerResponse<T>
    } catch {
      if (command.exitCode !== 0) {
        throw runnerFailure('RUNNER_COMMAND_FAILED', 'Sandbox runner request failed.')
      }
      throw runnerFailure('RUNNER_PROTOCOL_INVALID', 'Sandbox runner returned an invalid response.')
    }
    if (!response.ok) throw runnerFailure(response.error.code, response.error.message)
    if (command.exitCode !== 0) {
      throw runnerFailure('RUNNER_COMMAND_FAILED', 'Sandbox runner request failed.')
    }
    return response.result
  }

  private publishPlannedRoutes(handle: VercelRuntimeHandle, plan: PreviewExecutionPlan) {
    const routes = plan.networking.gatewayListeners.map((listener) => {
      if (!handle.gatewayPorts.includes(listener.sandboxPort)) {
        throw runnerFailure('UNDECLARED_GATEWAY_PORT', 'Plan contains an undeclared gateway port.')
      }
      const published = this.routes.identity(
        handle.sessionId,
        listener.serviceId,
        listener.endpointId
      )
      return {
        routeKey: listener.routeKey,
        routeId: published.id,
        publicUrl: published.publicUrl,
      }
    })
    return {
      browserBindingUrls: Object.fromEntries(
        routes.map((route) => [route.routeKey, route.publicUrl])
      ),
      routeIds: Object.fromEntries(routes.map((route) => [route.routeKey, route.routeId])),
    }
  }

  private async bootstrap(sandbox: Sandbox) {
    const result = await this.providerCall('runner-bootstrap', () =>
      sandbox.runCommand({ cmd: runnerBinary, args: ['bootstrap'], sudo: true, timeoutMs: 120_000 })
    )
    if (result.exitCode !== 0)
      throw runnerFailure('RUNNER_BOOTSTRAP_FAILED', 'Sandbox runner bootstrap failed.')
  }

  private async assertHandshake(sandbox: Sandbox, handle: RuntimeHandle) {
    const response = await this.runnerCallWithSandbox<RuntimeProtocolHandshake>(sandbox, handle, {
      operation: 'handshake',
    })
    if (response.protocolVersion !== this.config.sandbox.protocolVersion) {
      throw runnerFailure(
        'RUNNER_PROTOCOL_INCOMPATIBLE',
        `Runner protocol ${response.protocolVersion} is incompatible with control plane protocol ${this.config.sandbox.protocolVersion}.`
      )
    }
    if (response.runnerVersion !== this.config.sandbox.runnerVersion) {
      throw runnerFailure(
        'RUNNER_VERSION_INCOMPATIBLE',
        `Runner version ${response.runnerVersion} is incompatible with control plane version ${this.config.sandbox.runnerVersion}.`
      )
    }
    if (
      this.config.sandbox.image &&
      sandbox.image?.split('@').at(-1) !== this.config.sandbox.image.split('@')[1]
    ) {
      throw runnerFailure(
        'RUNNER_IMAGE_MISMATCH',
        'Runner image digest does not match the pinned image.'
      )
    }
    return response
  }

  private sandbox(handle: VercelRuntimeHandle, resume: boolean) {
    return this.providerCall('get', () =>
      Sandbox.get({ ...this.credentials(), name: handle.sandboxName, resume })
    )
  }

  private async findSandbox(handle: VercelRuntimeHandle, resume: boolean) {
    try {
      return await this.sandbox(handle, resume)
    } catch (error) {
      if (providerResourceMissing(error)) return undefined
      throw error
    }
  }

  private async findSandboxByName(name: string, resume: boolean) {
    try {
      return await this.providerCall('get', () =>
        Sandbox.get({ ...this.credentials(), name, resume })
      )
    } catch (error) {
      if (providerResourceMissing(error)) return undefined
      throw error
    }
  }

  private credentials() {
    const { accessToken: token, projectId, teamId } = this.config.sandbox
    return token && projectId && teamId ? { token, projectId, teamId } : {}
  }

  private networkPolicy(): NetworkPolicy {
    return vercelNetworkPolicy([
      ...this.config.sandbox.egressAllowlist,
      ...this.config.artifactTransferHosts,
    ]) as NetworkPolicy
  }

  private configurationFailure() {
    const { image, accessToken, projectId, teamId, deploymentId } = this.config.sandbox
    if (!deploymentId || !/^[A-Za-z0-9_.-]{1,80}$/.test(deploymentId)) {
      return 'A stable sandbox deployment ID is required.'
    }
    if (!this.config.workspaceEncryptionReady) {
      return 'Dedicated OVH SSE-OMK storage is required for workspace artifacts.'
    }
    if (!image || !/@sha256:[a-f0-9]{64}$/i.test(image))
      return 'The runner image must be pinned by digest.'
    if (accessToken && (!projectId || !teamId)) {
      return 'Vercel access-token authentication requires project and team IDs.'
    }
    if (!capabilityKeysMatch(this.config.capabilityPublicKey, this.config.capabilityPrivateKey))
      return 'A matching Ed25519 preview capability keypair is required.'
    return undefined
  }

  private assertResourceSize(size: { vcpus: number; memoryGb: number }) {
    const limits = this.limits()
    if (size.vcpus < 1 || size.vcpus > limits.maxVcpus || size.memoryGb !== size.vcpus * 2) {
      throw new PreviewRuntimeError({
        code: 'PROVIDER_QUOTA',
        message: 'Requested sandbox resources do not match current provider limits.',
        retryable: false,
      })
    }
  }

  private async providerCall<T>(operation: string, callback: () => Promise<T>) {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await callback()
      } catch (error) {
        lastError = error
        if (!retryableProviderError(error) || attempt === 3) break
        await delay(Math.min(2000, 150 * 2 ** attempt + Math.floor(Math.random() * 100)))
      }
    }
    throw providerFailure(operation, lastError)
  }
}

async function measureRuntimePhase<T>(phase: string, operation: () => Promise<T>) {
  const startedAt = performance.now()
  let outcome = 'succeeded'
  try {
    return await operation()
  } catch (error) {
    outcome = 'failed'
    throw error
  } finally {
    const attributes = {
      [ATTR_BLAME_RUNTIME_NAME]: 'vercel-compose',
      [ATTR_BLAME_RUNTIME_PHASE]: phase,
      [ATTR_BLAME_OPERATION_STATUS]: outcome,
    }
    telemetry.count('blame.runtime.phase.count', 1, attributes)
    telemetry.record(
      'blame.runtime.phase.duration',
      Math.max(0, performance.now() - startedAt) / 1_000,
      attributes
    )
  }
}
