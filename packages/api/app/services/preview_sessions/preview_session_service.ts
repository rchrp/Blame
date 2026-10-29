import Project from '#models/project'
import UserStory from '#models/user_story'
import PreviewSessionRepository from '#services/preview_sessions/preview_session_repository'
import {
  cumulativePeakDelta,
  summarizeCumulativeUsage,
} from '#services/preview_sessions/preview_usage_accounting'
import PreviewDistributedLock from '#services/preview_sessions/preview_distributed_lock'
import DatabasePreviewEventSink from '#services/preview_sessions/preview_event_sink'
import PreviewQuotaService from '#services/preview_sessions/preview_quota_service'
import PreviewLeaseService from '#services/preview_sessions/preview_lease_service'
import PreviewAccessTicketService from '#services/preview_gateway/preview_access_ticket_service'
import VercelSandboxDriver from '#services/sandboxes/vercel_sandbox_driver'
import {
  backgroundRunnerBusyProviderCode,
  providerSnapshotMissing,
} from '#services/sandboxes/vercel_sandbox_support'
import PreviewSession from '#models/preview_session'
import PreviewUsageSample from '#models/preview_usage_sample'
import WorkspaceArtifactService from '#services/workspace_artifacts/workspace_artifact_service'
import PreviewEdgeRouteService from '#services/preview_gateway/preview_edge_route_service'
import PreviewCapabilityService from '#services/preview_gateway/preview_capability_service'
import PreviewProjectBaselineService, {
  type PreviewBaselineSourceMetadata,
} from '#services/preview_baselines/preview_project_baseline_service'
import { previewRuntimeConfig, type PreviewRuntimeConfig } from '#config/preview_runtime'
import {
  sourceImportUnchanged,
  usesCurrentRunner,
} from '#services/preview_sessions/preview_session_reuse'
import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'
import {
  fenceRuntimeHandle,
  PreviewOrchestrator,
  PreviewReconciler,
  PreviewRuntimeError,
  compilePreviewManifest,
  previewFailure,
  type PreviewRuntimeDriver,
  type PreviewSessionCommand,
  type PreviewSessionRecord,
  type RuntimeProfileId,
} from '@blame/preview-runtime'
import type { PreviewManifest } from '@blame/preview-contract'
import {
  baselineImportAction,
  liveSourceDeltaMatches,
} from '#services/preview_sessions/source_import_policy'

export type CreateManagedPreviewInput = {
  userStoryId: string
  profile: 'vercel-compose'
  previewManifest: PreviewManifest
  cloudUploadConsentAt: string
  sourceRevision?: string
  sourceMetadata?: PreviewBaselineSourceMetadata
  resourceSize?: { vcpus: number; memoryGb: number }
}

export type PreviewSessionServiceDependencies = {
  config?: PreviewRuntimeConfig
  repository?: PreviewSessionRepository
  lock?: PreviewDistributedLock
  eventSink?: DatabasePreviewEventSink
  quota?: PreviewQuotaService
  lease?: PreviewLeaseService
  tickets?: PreviewAccessTicketService
  drivers?: PreviewRuntimeDriver[]
  baselines?: PreviewProjectBaselineService
}

export default class PreviewSessionService {
  private readonly config: PreviewRuntimeConfig
  private readonly repository: PreviewSessionRepository
  private readonly lock: PreviewDistributedLock
  private readonly eventSink: DatabasePreviewEventSink
  private readonly quota: PreviewQuotaService
  private readonly lease: PreviewLeaseService
  private readonly tickets: PreviewAccessTicketService
  private readonly artifacts: WorkspaceArtifactService
  private readonly edgeRoutes = new PreviewEdgeRouteService()
  private readonly capabilities = new PreviewCapabilityService()
  private readonly drivers: Map<string, PreviewRuntimeDriver>
  private readonly baselines: PreviewProjectBaselineService
  private readonly orchestrator: PreviewOrchestrator

  constructor(dependencies: PreviewSessionServiceDependencies = {}) {
    this.config = dependencies.config ?? previewRuntimeConfig()
    this.repository = dependencies.repository ?? new PreviewSessionRepository()
    this.lock = dependencies.lock ?? new PreviewDistributedLock()
    this.eventSink = dependencies.eventSink ?? new DatabasePreviewEventSink()
    this.quota = dependencies.quota ?? new PreviewQuotaService()
    this.lease = dependencies.lease ?? new PreviewLeaseService()
    this.tickets = dependencies.tickets ?? new PreviewAccessTicketService()
    this.artifacts = new WorkspaceArtifactService()
    this.baselines = dependencies.baselines ?? new PreviewProjectBaselineService(this.config)
    const drivers = dependencies.drivers ?? [new VercelSandboxDriver()]
    this.drivers = new Map(drivers.map((driver) => [driver.profile, driver]))
    this.orchestrator = new PreviewOrchestrator(
      this.repository,
      this.lock,
      this.eventSink,
      new PreviewReconciler({
        repository: this.repository,
        eventSink: this.eventSink,
        drivers: this.drivers,
      })
    )
  }

  async create(ownerUserId: string, input: CreateManagedPreviewInput, operationId: string) {
    validateOperationId(operationId)
    const story = await UserStory.query()
      .where('id', input.userStoryId)
      .whereIn('projectId', Project.query().select('id').where('userId', ownerUserId))
      .firstOrFail()
    const consentAt = validRecentConsent(input.cloudUploadConsentAt)
    const plan = compilePreviewManifest(input.previewManifest)
    const planHash = stableHash(plan)
    const sessionId = idempotentSessionId(ownerUserId, operationId)
    return this.quota.withCreationLock(ownerUserId, async () => {
      const existing = await this.repository.get(sessionId)
      if (existing) {
        if (
          existing.ownerUserId !== ownerUserId ||
          existing.userStoryId !== input.userStoryId ||
          existing.profile !== input.profile ||
          existing.planHash !== planHash
        ) {
          throw new PreviewRuntimeError({
            code: 'INTERNAL',
            message: 'An idempotency key cannot be reused for another preview.',
            retryable: false,
          })
        }
        if (existing.state.host === 'destroyed') {
          await this.destroyForUserStory(ownerUserId, input.userStoryId, input.profile)
        } else {
          if (
            ['failed', 'provisioning', 'resuming', 'suspended', 'unprovisioned'].includes(
              existing.state.host
            )
          ) {
            await this.orchestrator.command(
              sessionId,
              { type: 'resume-host' },
              `create-recovery:${stableHash(operationId).slice(0, 32)}`
            )
          }
          const recovered = await this.get(ownerUserId, sessionId)
          if (recovered.state.host === 'running') await this.lease.renew(sessionId, ownerUserId)
          return recovered
        }
      }
      const reusable = await this.repository.latestForUserStory(
        ownerUserId,
        input.userStoryId,
        input.profile
      )
      if (reusable?.planHash === planHash && usesCurrentRunner(reusable, this.config.sandbox)) {
        if (
          ['failed', 'provisioning', 'resuming', 'suspended', 'unprovisioned'].includes(
            reusable.state.host
          )
        ) {
          await this.orchestrator.command(
            reusable.id,
            { type: 'resume-host' },
            `story-recovery:${stableHash(operationId).slice(0, 32)}`
          )
        }
        const recovered = await this.get(ownerUserId, reusable.id)
        if (recovered.state.host === 'running') await this.lease.renew(reusable.id, ownerUserId)
        return recovered
      }
      if (reusable) {
        await this.destroyForUserStory(ownerUserId, input.userStoryId, input.profile)
      }
      await this.releaseSuspendedSnapshots(
        Math.max(10, this.config.maxRetainedSuspended + 1)
      ).catch(() => undefined)
      const requestedVcpus = input.resourceSize?.vcpus ?? 2
      await this.quota.assertCanCreate(ownerUserId, requestedVcpus)
      const baseline = input.sourceMetadata
        ? await this.baselines.lookupForProject(story.projectId, planHash, input.sourceMetadata)
        : undefined
      const session = await this.orchestrator.create({
        id: sessionId,
        userStoryId: input.userStoryId,
        ownerUserId,
        profile: input.profile,
        plan,
        planHash,
        sourceRevision: input.sourceRevision,
        baselineId: baseline?.id,
        provisionSource: baseline?.providerSnapshotId
          ? { type: 'snapshot', snapshotId: baseline.providerSnapshotId }
          : undefined,
        resourceSize: input.resourceSize,
        cloudUploadConsentAt: consentAt,
      })
      if (baseline?.providerSnapshotId && !session.baselineId) {
        await this.baselines
          .markSnapshotUnavailable(baseline.id, baseline.providerSnapshotId)
          .catch(() => undefined)
      }
      await this.lease.renew(session.id, ownerUserId)
      return this.get(ownerUserId, session.id)
    })
  }

  async get(ownerUserId: string, sessionId: string) {
    const session = await this.orchestrator.get(sessionId)
    assertOwner(session.ownerUserId, ownerUserId)
    if (session.state.host === 'running') {
      await this.sampleUsage(sessionId, session.profile)
    }
    return {
      ...session,
      usage: await this.usageSummary(sessionId, session.resourceSize.memoryGb),
    }
  }

  async findForUserStory(ownerUserId: string, userStoryId: string, profile: RuntimeProfileId) {
    await UserStory.query()
      .where('id', userStoryId)
      .whereIn('projectId', Project.query().select('id').where('userId', ownerUserId))
      .firstOrFail()
    const session = await this.repository.latestForUserStory(ownerUserId, userStoryId, profile)
    return session ? this.get(ownerUserId, session.id) : null
  }

  async command(
    ownerUserId: string,
    sessionId: string,
    command: PreviewSessionCommand,
    operationId: string
  ) {
    const before = await this.get(ownerUserId, sessionId)
    if (['start-services', 'start-agent', 'resume-host'].includes(command.type)) {
      this.quota.assertRuntimeEnabled(ownerUserId)
      await this.quota.assertBudget(ownerUserId)
    }
    validateOperationId(operationId)
    if (command.type === 'destroy-host' && command.discardPendingDelta) {
      if (before.pendingDeltaArtifactId) {
        await this.artifacts.discard(
          before.pendingDeltaArtifactId,
          ownerUserId,
          command.discardPendingDelta.confirmationId
        )
      } else if (before.state.sync !== 'discarded') {
        throw new Error('There is no pending delta to discard.')
      }
    }
    const session = await this.orchestrator.command(sessionId, command, operationId)
    if (command.type === 'ack-local-sync' && before.pendingDeltaArtifactId) {
      await this.artifacts.markApplied(before.pendingDeltaArtifactId, ownerUserId)
    }
    if (session.state.host === 'running') await this.lease.renew(sessionId, ownerUserId)
    else if (session.state.host === 'suspended') await this.lease.neutralize(sessionId, ownerUserId)
    else await this.lease.release(sessionId, ownerUserId)
    if (session.state.host === 'destroyed') {
      await this.tickets.revokeSession(sessionId)
      await this.artifacts.scheduleSessionDeletion(sessionId)
    }
    await this.sampleUsage(sessionId, session.profile)
    return this.get(ownerUserId, sessionId)
  }

  async destroyForUserStory(ownerUserId: string, userStoryId: string, profile?: RuntimeProfileId) {
    const query = PreviewSession.query()
      .where('ownerUserId', ownerUserId)
      .where('userStoryId', userStoryId)
    if (profile) query.where('profile', profile)
    const sessions = await query.select('id')
    for (const session of sessions) {
      await this.lock.withLock(session.id, async ({ fencingToken }) => {
        const record = await this.repository.get(session.id)
        if (!record || record.ownerUserId !== ownerUserId || record.userStoryId !== userStoryId) {
          return
        }
        record.fencingToken = fencingToken
        record.desired.host = 'destroyed'
        record.desired.services = 'stopped'
        record.desired.preview = 'closed'
        record.desired.agent = 'idle'
        record.state.host = 'destroying'
        record.failure = undefined
        if (record.state.engine === 'running') record.state.engine = 'stopping'
        if (record.state.preview !== 'closed') record.state.preview = 'closing'
        record.endpointMap = undefined
        try {
          await this.saveSessionState(record, 'Destroying preview for deleted user story.')
          const handle = await this.fencedHandle(session.id, fencingToken)
          const driver = this.drivers.get(record.profile)
          await Promise.all([
            this.tickets.revokeSession(session.id),
            this.edgeRoutes.revokeSession(session.id),
          ])
          if (handle) {
            if (!driver) throw new Error(`No preview driver is registered for ${record.profile}.`)
            const receipt = await driver.destroyHost(handle)
            if (receipt.pendingCleanupIds.length) {
              throw new Error('The preview provider reported pending cleanup resources.')
            }
            await this.repository.setRuntimeHandle(session.id, undefined, fencingToken)
          }
          await this.artifacts.deleteSessionArtifacts(session.id)
          record.state.host = 'destroyed'
          record.state.engine = 'stopped'
          record.state.preview = 'closed'
          record.state.agent = 'idle'
          record.stoppedAt = DateTime.utc().toISO()!
          record.failure = undefined
          await this.saveSessionState(record, 'Preview resources destroyed.')
          await PreviewSession.query()
            .where('id', session.id)
            .where('ownerUserId', ownerUserId)
            .where('userStoryId', userStoryId)
            .delete()
        } catch (error) {
          record.failure = previewFailure(error)
          await this.saveSessionState(record, record.failure.message, 'failure').catch(
            () => undefined
          )
          throw error
        }
      })
    }
  }

  async issueAccessTicket(ownerUserId: string, sessionId: string, routeId?: string) {
    this.quota.assertRuntimeEnabled(ownerUserId)
    const session = await this.get(ownerUserId, sessionId)
    if (session.state.preview !== 'ready' || !session.endpointMap) {
      throw new PreviewRuntimeError({
        code: 'ENDPOINT_NOT_LISTENING',
        message: 'The preview is not ready.',
        retryable: true,
      })
    }
    const selected = routeId ?? session.endpointMap.primaryRouteId
    if (!session.endpointMap.routes.some((route) => route.routeId === selected)) {
      throw new PreviewRuntimeError({
        code: 'PREVIEW_ACCESS_DENIED',
        message: 'The preview endpoint does not belong to this session.',
        retryable: false,
      })
    }
    await this.lease.renew(sessionId, ownerUserId)
    return this.tickets.issue(sessionId, selected, ownerUserId)
  }

  async issueDesktopBridgeGrant(ownerUserId: string, sessionId: string) {
    this.quota.assertRuntimeEnabled(ownerUserId)
    const session = await this.get(ownerUserId, sessionId)
    if (session.state.preview !== 'ready' || !session.endpointMap) {
      throw new PreviewRuntimeError({
        code: 'ENDPOINT_NOT_LISTENING',
        message: 'The preview is not ready.',
        retryable: true,
      })
    }
    await this.lease.renew(sessionId, ownerUserId)
    const providerRoutes = await this.edgeRoutes.resolveForDesktop(sessionId, ownerUserId)
    const routeById = new Map(providerRoutes.map((route) => [route.routeId, route]))
    return {
      sessionId,
      endpointRevision: session.endpointMap.revision,
      integratedPreviewRequired: session.endpointMap.integratedPreviewRequired,
      primaryRouteId: session.endpointMap.primaryRouteId,
      routes: session.endpointMap.routes.map((logical) => {
        const provider = routeById.get(logical.routeId)
        if (!provider) throw new Error('Provider route is unavailable.')
        const capability = this.capabilities.issue(provider)
        return {
          routeId: logical.routeId,
          serviceId: logical.serviceId,
          endpointId: logical.endpointId,
          logicalHost: logical.logicalHost,
          logicalPort: logical.logicalPort,
          protocol: logical.protocol,
          providerUrl: provider.upstreamUrl,
          capability: capability.token,
          capabilityExpiresAt: new Date(capability.expiresAt * 1000).toISOString(),
        }
      }),
    }
  }

  async *events(ownerUserId: string, sessionId: string, cursor?: string) {
    await this.get(ownerUserId, sessionId)
    yield* this.orchestrator.events(sessionId, cursor)
  }

  async *logs(ownerUserId: string, sessionId: string, cursor?: string) {
    const session = await this.get(ownerUserId, sessionId)
    const handle = await this.repository.getRuntimeHandle(sessionId)
    const driver = this.drivers.get(session.profile)
    if (!handle || !driver) return
    yield* driver.logs({ handle, cursor })
  }

  async prepareSourceUpload(
    ownerUserId: string,
    sessionId: string,
    input: {
      sha256: string
      size: number
      sourceRevision: string
      baseline?: PreviewBaselineSourceMetadata
      sanitizedTreeHash?: string
      lockfileHash?: string
      workspaceHash?: string
      baseHash?: string
      mode?: 'full' | 'delta'
    }
  ) {
    await this.get(ownerUserId, sessionId)
    const upload = await this.artifacts.prepareSourceUpload({
      sessionId,
      ownerUserId,
      ...input,
    })
    return {
      ...upload,
      baseline: input.baseline
        ? await this.baselines.lookupForSession(sessionId, input.baseline)
        : undefined,
    }
  }

  async negotiateSource(
    ownerUserId: string,
    sessionId: string,
    metadata: PreviewBaselineSourceMetadata
  ) {
    const session = await this.get(ownerUserId, sessionId)
    const unchanged = sourceImportUnchanged(session, metadata)
    return {
      unchanged,
      session,
      baseline: unchanged ? undefined : await this.baselines.lookupForSession(sessionId, metadata),
    }
  }

  async importSource(
    ownerUserId: string,
    sessionId: string,
    artifactId: string,
    baselineId?: string
  ) {
    await this.get(ownerUserId, sessionId)
    const source = await this.artifacts.completeSourceUpload(artifactId, ownerUserId)
    const existing = await this.repository.get(sessionId)
    if (existing?.sourceArtifactId === source.id && existing.state.sync === 'clean') {
      return this.get(ownerUserId, sessionId)
    }
    const liveDelta = liveSourceDeltaMatches(existing, source, baselineId)
    if (
      source.mode === 'delta' &&
      existing &&
      ['running', 'starting', 'preparing'].includes(existing.state.engine) &&
      !liveDelta
    ) {
      throw new PreviewRuntimeError({
        code: 'SYNC_CONFLICT',
        message: 'Stop preview services before applying a workspace delta.',
        retryable: true,
      })
    }
    const baselineMetadata = {
      baseRevision: source.revision,
      sanitizedTreeHash: source.sanitizedTreeHash ?? source.revision,
      lockfileHash: source.lockfileHash ?? 'unknown',
      workspaceHash: source.workspaceHash,
    }
    const baseline = liveDelta
      ? undefined
      : baselineId
        ? await this.baselines.getReady(
            baselineId,
            sessionId,
            {
              baseRevision: source.revision,
              sanitizedTreeHash: source.sanitizedTreeHash ?? '',
              lockfileHash: source.lockfileHash ?? '',
              workspaceHash: source.workspaceHash,
            },
            source.mode === 'delta' ? 'exact' : 'compatible'
          )
        : await this.baselines.lookupForSession(sessionId, baselineMetadata)
    if (source.mode !== 'delta' && baseline?.match !== 'exact') {
      void this.baselines
        .ensure({ sessionId, source, sourceMetadata: baselineMetadata })
        .catch(() => undefined)
    }
    return this.lock.withLock(sessionId, async ({ fencingToken }) => {
      const record = await this.repository.get(sessionId)
      const handle = await this.fencedHandle(sessionId, fencingToken)
      const driver = record && this.drivers.get(record.profile)
      if (!record || !handle || !driver) throw new Error('Preview runtime is not provisioned.')
      const lockedLiveDelta = liveSourceDeltaMatches(record, source, baselineId)
      if (
        source.mode === 'delta' &&
        ['running', 'starting', 'preparing'].includes(record.state.engine) &&
        !lockedLiveDelta
      ) {
        throw new PreviewRuntimeError({
          code: 'SYNC_CONFLICT',
          message: 'Stop preview services before applying a workspace delta.',
          retryable: true,
        })
      }
      if (record.sourceArtifactId === source.id && record.state.sync === 'clean') {
        return this.get(ownerUserId, sessionId)
      }
      const importing = structuredClone(record)
      importing.state.sync = 'importing'
      importing.failure = undefined
      await this.saveSessionState(importing, 'Importing preview workspace source.')
      let runtimeLostDuringBaselineRestore = false
      let unavailableBaselineSnapshotId: string | undefined
      try {
        let syncHandle = handle
        const baselineAction = baselineImportAction({
          sourceMode: source.mode,
          baselineId: baseline?.id,
          provisionedBaselineId: record.baselineId,
          sourceArtifactId: record.sourceArtifactId,
          liveDeltaMatches: lockedLiveDelta,
        })
        if (baselineAction === 'unavailable') {
          throw new PreviewRuntimeError({
            code: 'UNSUPPORTED_CAPABILITY',
            message: 'The exact preview baseline is unavailable.',
            retryable: true,
          })
        }
        if (baselineAction === 'restore') {
          if (!baseline?.providerSnapshotId || !driver.restoreBaseline) {
            throw new PreviewRuntimeError({
              code: 'UNSUPPORTED_CAPABILITY',
              message: 'The preview baseline cannot be restored by the active runtime.',
              retryable: true,
            })
          }
          try {
            syncHandle = await driver.restoreBaseline(handle, baseline.providerSnapshotId)
          } catch (error) {
            runtimeLostDuringBaselineRestore = true
            if (providerSnapshotMissing(error)) {
              unavailableBaselineSnapshotId = baseline.providerSnapshotId
              await this.baselines
                .markSnapshotUnavailable(baseline.id, baseline.providerSnapshotId)
                .catch(() => undefined)
            }
            await driver.destroyHost(handle).catch(() => undefined)
            await this.repository
              .setRuntimeHandle(sessionId, undefined, fencingToken)
              .catch(() => undefined)
            if (unavailableBaselineSnapshotId) {
              throw new PreviewRuntimeError(
                {
                  code: 'SOURCE_SYNC_FAILED',
                  message: 'The preview baseline expired before source synchronization.',
                  providerCode: 'BASELINE_SNAPSHOT_NOT_FOUND',
                  retryable: true,
                },
                { cause: error }
              )
            }
            throw error
          }
          await this.repository.setRuntimeHandle(sessionId, syncHandle)
        }
        const receipt = await driver.syncIn(syncHandle, source, {
          preserveWarmCaches: source.mode !== 'delta' && Boolean(baseline),
        })
        const current = (await this.repository.get(sessionId))!
        if (baseline) {
          current.state.engine = 'stopped'
          current.state.preview = 'closed'
          current.endpointMap = undefined
        }
        current.state.sync = 'clean'
        current.sourceRevision = receipt.sourceRevision
        current.workspaceHash = receipt.workspaceHash
        current.sourceArtifactId = source.id
        if (!lockedLiveDelta) current.baselineId = baseline?.id
        if (!lockedLiveDelta) current.pendingDeltaArtifactId = undefined // superseded by this import
        current.lastExportedJournalRevision = '0'
        current.lastAppliedLocalRevision = '0'
        current.lastAcknowledgedRemoteRevision = '0'
        current.failure = undefined
        await this.saveSessionState(current, 'Preview workspace source synchronized.')
        return this.get(ownerUserId, sessionId)
      } catch (error) {
        const current = await this.repository.get(sessionId)
        if (current) {
          current.state.sync = 'failed'
          if (runtimeLostDuringBaselineRestore) {
            current.state.host = 'failed'
            current.state.engine = 'stopped'
            current.state.preview = 'closed'
            current.endpointMap = undefined
          }
          if (unavailableBaselineSnapshotId) {
            if (current.baselineId === baseline?.id) current.baselineId = undefined
            if (current.provisionSource?.snapshotId === unavailableBaselineSnapshotId) {
              current.provisionSource = undefined
            }
          }
          current.failure = previewFailure(error, 'SOURCE_SYNC_FAILED')
          await this.saveSessionState(current, current.failure.message, 'failure')
        }
        throw error
      }
    })
  }

  async exportSourceDelta(ownerUserId: string, sessionId: string) {
    const session = await this.get(ownerUserId, sessionId)
    if (remoteWritersActive(session.state)) {
      throw new PreviewRuntimeError({
        code: 'SYNC_CONFLICT',
        message: 'Stop remote writers before applying a workspace delta locally.',
        retryable: true,
      })
    }
    return this.lock.withLock(sessionId, async ({ fencingToken }) => {
      const record = await this.repository.get(sessionId)
      if (!record) throw new Error('Preview runtime is not provisioned.')
      const handle = await this.fencedHandle(sessionId, fencingToken)
      if (!handle && record.pendingDeltaArtifactId) {
        return this.artifacts.download(record.pendingDeltaArtifactId, ownerUserId)
      }
      const driver = this.drivers.get(record.profile)
      if (!handle || !driver) throw new Error('Preview runtime is not provisioned.')
      if (remoteWritersActive(record.state)) {
        throw new PreviewRuntimeError({
          code: 'SYNC_CONFLICT',
          message: 'Remote writers became active before local synchronization.',
          retryable: true,
        })
      }
      const observation = await driver.inspect(handle)
      if (observation.engine === 'running' || observation.services.some(({ running }) => running)) {
        throw new PreviewRuntimeError({
          code: 'SYNC_CONFLICT',
          message: 'The runtime still reports an active remote writer.',
          retryable: true,
        })
      }
      const revision = observation.journalRevision ?? record.lastExportedJournalRevision ?? '0'
      if (record.pendingDeltaArtifactId && record.lastExportedJournalRevision === revision) {
        return this.artifacts.download(record.pendingDeltaArtifactId, ownerUserId)
      }
      const receipt = await driver.exportDelta(handle, revision)
      record.lastExportedJournalRevision = receipt.revision
      record.pendingDeltaArtifactId = receipt.artifactId
      record.state.sync = 'pending_local_sync'
      await this.saveSessionState(record, 'Preview workspace changes exported.')
      return this.artifacts.download(receipt.artifactId, ownerUserId)
    })
  }

  async reconcileExpired(limit = 50) {
    const now = DateTime.utc()
    const candidates = await this.repository.listReconcileCandidates(now.toISO()!, limit)
    const results: Array<{
      id: string
      status: 'suspended' | 'skipped' | 'failed'
      failure?: string
    }> = []
    for (const session of candidates) {
      if (!session.idleDeadlineAt || DateTime.fromISO(session.idleDeadlineAt) > now) {
        results.push({ id: session.id, status: 'skipped' })
        continue
      }
      try {
        const reconciled = await this.orchestrator.command(
          session.id,
          { type: 'suspend-host' },
          `reaper:${session.revision}:${session.generation}`,
          (current) =>
            current.revision === session.revision &&
            current.generation === session.generation &&
            current.idleDeadlineAt === session.idleDeadlineAt &&
            Boolean(current.idleDeadlineAt) &&
            DateTime.fromISO(current.idleDeadlineAt!) <= DateTime.utc()
        )
        if (reconciled.state.host !== 'suspended') {
          results.push({ id: session.id, status: 'skipped' })
          continue
        }
        await this.lease.neutralize(session.id, session.ownerUserId)
        await this.sampleUsage(session.id, session.profile)
        results.push({ id: session.id, status: 'suspended' })
      } catch (error) {
        results.push({ id: session.id, status: 'failed', failure: errorMessage(error) })
      }
    }
    const [, , , released] = await Promise.all([
      this.artifacts.cleanupExpired(limit * 5),
      this.tickets.cleanupExpired(limit * 10),
      this.baselines.gc(limit),
      this.releaseSuspendedSnapshots(limit),
    ])
    for (const result of released) {
      if (result.status === 'failed') {
        results.push({ id: result.id, status: 'failed', failure: result.failure })
      }
    }
    try {
      await this.sweepProviderOrphans()
    } catch (error) {
      results.push({
        id: 'provider-orphan-sweep',
        status: 'failed',
        failure: errorMessage(error),
      })
    }
    return results
  }

  async releaseSuspendedSnapshots(limit = 50) {
    const cutoff = DateTime.utc().minus({ minutes: this.config.suspendedRetentionMinutes }).toISO()!
    const candidates = await this.repository.listSuspendedSnapshotCandidates(
      cutoff,
      this.config.maxRetainedSuspended,
      limit
    )
    const results: Array<{
      id: string
      status: 'released' | 'skipped' | 'failed'
      failure?: string
    }> = []
    for (const candidate of candidates) {
      try {
        const status = await this.lock.withLock(candidate.id, async ({ fencingToken }) => {
          const record = await this.repository.get(candidate.id)
          if (!record || record.state.host !== 'suspended') return 'skipped' as const
          const handle = await this.fencedHandle(candidate.id, fencingToken)
          const driver = this.drivers.get(record.profile)
          if (!handle || !driver) return 'skipped' as const
          await driver.destroyHost(handle)
          await this.repository.setRuntimeHandle(record.id, undefined, fencingToken)
          record.state.host = 'suspended'
          record.state.engine = 'stopped'
          record.state.preview = 'closed'
          record.endpointMap = undefined
          record.leaseExpiresAt = undefined
          record.idleDeadlineAt = undefined
          await this.saveSessionState(
            record,
            'Suspended preview snapshot released by retention policy.'
          )
          await this.tickets.revokeSession(record.id)
          return 'released' as const
        })
        results.push({ id: candidate.id, status })
      } catch (error) {
        results.push({ id: candidate.id, status: 'failed', failure: errorMessage(error) })
      }
    }
    return results
  }

  async checkpointActive(limit = 50) {
    const candidates = await this.repository.listActiveCheckpointCandidates(limit)
    const results: Array<{
      id: string
      status: 'exported' | 'unchanged' | 'suspended' | 'failed'
    }> = []
    for (const candidate of candidates) {
      try {
        const status = await this.lock.withLock(candidate.id, async ({ fencingToken }) => {
          const record = await this.repository.get(candidate.id)
          const handle = await this.fencedHandle(candidate.id, fencingToken)
          const driver = record && this.drivers.get(record.profile)
          if (!record || !handle || !driver || record.state.host !== 'running') return 'unchanged'
          const observation = await driver.inspect(handle, {
            background: true,
            probeServices: false,
          })
          await this.sampleUsage(record.id, record.profile)
          const revision = observation.journalRevision
          if (!revision || revision === record.lastExportedJournalRevision) return 'unchanged'
          const receipt = await driver.exportDelta(handle, revision)
          record.lastExportedJournalRevision = receipt.revision
          record.pendingDeltaArtifactId = receipt.artifactId
          if (record.state.sync === 'clean') record.state.sync = 'pending_local_sync'
          await this.saveSessionState(record, 'Preview workspace checkpoint exported.')
          return 'exported'
        })
        try {
          this.quota.assertRuntimeEnabled(candidate.ownerUserId)
          await this.quota.assertBudget(candidate.ownerUserId)
          results.push({ id: candidate.id, status })
        } catch (error) {
          if (
            !(error instanceof PreviewRuntimeError) ||
            !['PREVIEW_ACCESS_DENIED', 'BUDGET_EXCEEDED'].includes(error.failure.code)
          ) {
            throw error
          }
          await this.orchestrator.command(
            candidate.id,
            { type: 'suspend-host' },
            `runtime-guard:${candidate.revision}:${candidate.generation}`
          )
          await this.lease.neutralize(candidate.id, candidate.ownerUserId)
          results.push({ id: candidate.id, status: 'suspended' })
        }
      } catch (error) {
        if (
          error instanceof PreviewRuntimeError &&
          error.failure.providerCode === backgroundRunnerBusyProviderCode
        ) {
          results.push({ id: candidate.id, status: 'unchanged' })
          continue
        }
        results.push({ id: candidate.id, status: 'failed' })
      }
    }
    return results
  }

  private async sampleUsage(sessionId: string, profile: RuntimeProfileId) {
    const handle = await this.repository.getRuntimeHandle(sessionId)
    const session = await this.repository.get(sessionId)
    const driver = this.drivers.get(profile)
    if (!handle || !session || !driver) return
    try {
      const latest = await PreviewUsageSample.query()
        .where('sessionId', sessionId)
        .where('generation', session.generation)
        .orderBy('observedAt', 'desc')
        .first()
      if (latest && DateTime.utc().diff(latest.observedAt, 'milliseconds').milliseconds < 2_000) {
        return
      }
      const usage = await driver.usage(handle)
      const previousPeak = await PreviewUsageSample.query()
        .where('sessionId', sessionId)
        .where('generation', session.generation)
        .orderBy('cumulative_estimated_cost_usd', 'desc')
        .first()
      await PreviewUsageSample.create({
        sessionId,
        generation: session.generation,
        activeCpuSeconds: Math.round(usage.activeCpuSeconds),
        memoryGbSeconds: Math.round(usage.memoryGbSeconds),
        ingressBytes: Math.round(usage.ingressBytes),
        egressBytes: Math.round(usage.egressBytes),
        snapshotBytes: Math.round(usage.snapshotBytes),
        estimatedCostUsd: cumulativePeakDelta(
          usage.estimatedCostUsd,
          Number(previousPeak?.cumulativeEstimatedCostUsd ?? 0)
        ),
        cumulativeEstimatedCostUsd: usage.estimatedCostUsd,
        observedAt: DateTime.fromISO(usage.observedAt),
      })
    } catch {
      // Usage reconciliation is retried by the reaper and must not hide lifecycle results.
    }
  }

  private async fencedHandle(sessionId: string, fencingToken: number) {
    const handle = await this.repository.getRuntimeHandle(sessionId)
    if (!handle) return undefined
    fenceRuntimeHandle(handle, fencingToken)
    await this.repository.setRuntimeHandle(sessionId, handle)
    return handle
  }

  private async sweepProviderOrphans() {
    if (!previewRuntimeConfig().enabled) return
    const sweeper = [...this.drivers.values()].find((driver) => driver.sweepOrphans)
    if (!sweeper?.sweepOrphans) return
    const active = await PreviewSession.query()
      .where('profile', 'vercel-compose')
      .whereRaw("JSON_UNQUOTE(JSON_EXTRACT(state, '$.host')) <> 'destroyed'")
      .select('id')
    await sweeper.sweepOrphans(
      active.map(({ id }) => id),
      DateTime.utc().minus({ hours: 1 }).toISO()!
    )
  }

  private async usageSummary(sessionId: string, memoryGb: number) {
    const samples = await PreviewUsageSample.query()
      .where('sessionId', sessionId)
      .orderBy('observedAt', 'asc')
    const usage = summarizeCumulativeUsage(
      samples.map((sample) => ({
        generation: Number(sample.generation),
        memoryGbSeconds: Number(sample.memoryGbSeconds),
        cumulativeEstimatedCostUsd: Number(sample.cumulativeEstimatedCostUsd),
      })),
      memoryGb
    )
    return {
      ...usage,
      observedAt: samples.at(-1)?.observedAt.toUTC().toISO() ?? DateTime.utc().toISO()!,
    }
  }

  private async saveSessionState(
    record: PreviewSessionRecord,
    message: string,
    type: 'state' | 'failure' = 'state'
  ) {
    const expectedRevision = record.revision
    record.revision += 1
    record.stateChangedAt = DateTime.utc().toISO()!
    await this.repository.save(record, expectedRevision)
    await this.eventSink.append({
      sessionId: record.id,
      timestamp: record.stateChangedAt,
      type,
      state: structuredClone(record.state),
      stream: 'system',
      message,
    })
  }
}

function remoteWritersActive(state: { engine: string; agent: string }) {
  return !['idle', 'stopped', 'failed'].includes(state.engine) || state.agent !== 'idle'
}

function stableHash(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function idempotentSessionId(ownerUserId: string, operationId: string) {
  const suffix = createHash('sha256')
    .update(`${ownerUserId}\0${operationId}`)
    .digest('hex')
    .slice(0, 32)
  return `preview_${suffix}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function validRecentConsent(value: string) {
  const consent = DateTime.fromISO(value)
  if (!consent.isValid || consent > DateTime.utc().plus({ minutes: 1 })) {
    throw new PreviewRuntimeError({
      code: 'PREVIEW_ACCESS_DENIED',
      message: 'Cloud upload consent is invalid.',
      retryable: false,
    })
  }
  return consent.toUTC().toISO()!
}

function validateOperationId(value: string) {
  if (!/^[A-Za-z0-9:_-]{8,80}$/.test(value)) throw new Error('Invalid operation ID.')
}

function assertOwner(actual: string, expected: string) {
  if (actual !== expected) {
    throw new PreviewRuntimeError({
      code: 'PREVIEW_ACCESS_DENIED',
      message: 'Preview session not found.',
      retryable: false,
    })
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
