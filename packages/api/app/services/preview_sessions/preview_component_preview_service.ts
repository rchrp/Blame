import PreviewSessionRepository from '#services/preview_sessions/preview_session_repository'
import PreviewDistributedLock from '#services/preview_sessions/preview_distributed_lock'
import PreviewLeaseService from '#services/preview_sessions/preview_lease_service'
import PreviewCapabilityService from '#services/preview_gateway/preview_capability_service'
import { opaqueRouteId } from '#services/preview_gateway/preview_edge_route_service'
import VercelSandboxDriver, {
  type ComponentPreviewProviderRoute,
} from '#services/sandboxes/vercel_sandbox_driver'
import {
  componentPreviewSandbox,
  fenceRuntimeHandle,
  PreviewRuntimeError,
  type ComponentPreviewSandboxCursor,
  type ComponentPreviewSandboxStart,
  type RuntimeHandle,
} from '@blame/preview-runtime'

// open_component_preview for a cloud preview: the desktop starts Blame's
// temporary Vite server in the story's sandbox, reads its output while it
// starts, and reaches it through a route of its own. That route has the
// preview's provider and capability rules but is never part of the
// preview's endpoint map, so the preview's bridge grant and public routes
// stay exactly as they are.

type Driver = Pick<
  VercelSandboxDriver,
  | 'componentPreviewOutput'
  | 'componentPreviewRoute'
  | 'startComponentPreview'
  | 'stopComponentPreview'
>

export type PreviewComponentPreviewDependencies = {
  capabilities?: Pick<PreviewCapabilityService, 'issue'>
  driver?: Driver
  lease?: Pick<PreviewLeaseService, 'renew'>
  lock?: Pick<PreviewDistributedLock, 'withLock'>
  repository?: Pick<PreviewSessionRepository, 'get' | 'getRuntimeHandle' | 'setRuntimeHandle'>
}

// The longest a capability lives; the desktop asks for a new one before.
const capabilityTtlSeconds = 60

export default class PreviewComponentPreviewService {
  private readonly capabilities: Pick<PreviewCapabilityService, 'issue'>
  private readonly driver: Driver
  private readonly lease: Pick<PreviewLeaseService, 'renew'>
  private readonly lock: Pick<PreviewDistributedLock, 'withLock'>
  private readonly repository: Pick<
    PreviewSessionRepository,
    'get' | 'getRuntimeHandle' | 'setRuntimeHandle'
  >

  constructor(dependencies: PreviewComponentPreviewDependencies = {}) {
    this.capabilities = dependencies.capabilities ?? new PreviewCapabilityService()
    this.driver = dependencies.driver ?? new VercelSandboxDriver()
    this.lease = dependencies.lease ?? new PreviewLeaseService()
    this.lock = dependencies.lock ?? new PreviewDistributedLock()
    this.repository = dependencies.repository ?? new PreviewSessionRepository()
  }

  async start(ownerUserId: string, sessionId: string, input: ComponentPreviewSandboxStart) {
    return this.lock.withLock(sessionId, async ({ fencingToken }) => {
      const handle = await this.readyHandle(ownerUserId, sessionId)
      fenceRuntimeHandle(handle, fencingToken)
      await this.repository.setRuntimeHandle(sessionId, handle)
      const route = await this.driver.startComponentPreview(handle, {
        ...input,
        routeId: componentPreviewRouteId(sessionId),
      })
      // The handle now declares the reserved port, if it did not yet.
      await this.repository.setRuntimeHandle(sessionId, handle)
      await this.lease.renew(sessionId, ownerUserId)
      return this.grant(route, input.port)
    })
  }

  // A fresh capability for the running server; it also keeps the preview
  // from being suspended while only the component preview is used.
  async refresh(ownerUserId: string, sessionId: string, port: number) {
    const handle = await this.readyHandle(ownerUserId, sessionId)
    const route = await this.driver.componentPreviewRoute(handle)
    await this.lease.renew(sessionId, ownerUserId)
    return this.grant(route, port)
  }

  async output(ownerUserId: string, sessionId: string, cursor: ComponentPreviewSandboxCursor) {
    const handle = await this.ownedHandle(ownerUserId, sessionId)
    if (!handle) return { cursor, running: false, stderr: '', stdout: '' }
    return this.driver.componentPreviewOutput(handle, cursor)
  }

  async stop(ownerUserId: string, sessionId: string) {
    return this.lock.withLock(sessionId, async ({ fencingToken }) => {
      const handle = await this.ownedHandle(ownerUserId, sessionId)
      if (!handle) return { stopped: false }
      fenceRuntimeHandle(handle, fencingToken)
      await this.repository.setRuntimeHandle(sessionId, handle)
      return this.driver.stopComponentPreview(handle)
    })
  }

  private grant(route: ComponentPreviewProviderRoute, port: number): ComponentPreviewGrant {
    const routeId = componentPreviewRouteId(route.sessionId)
    const { serviceId, endpointId } = componentPreviewSandbox
    const capability = this.capabilities.issue(
      { sessionId: route.sessionId, routeId, serviceId, endpointId, generation: route.generation },
      capabilityTtlSeconds
    )
    return {
      sessionId: route.sessionId,
      endpointRevision: 0,
      integratedPreviewRequired: false,
      primaryRouteId: routeId,
      routes: [
        {
          routeId,
          serviceId,
          endpointId,
          logicalHost: 'localhost',
          logicalPort: port,
          protocol: 'http',
          providerUrl: route.providerUrl,
          capability: capability.token,
          capabilityExpiresAt: new Date(capability.expiresAt * 1000).toISOString(),
        },
      ],
    }
  }

  private async ownedHandle(ownerUserId: string, sessionId: string) {
    const session = await this.repository.get(sessionId)
    if (!session || session.ownerUserId !== ownerUserId) {
      throw denied('This preview is unavailable.')
    }
    return this.repository.getRuntimeHandle(sessionId)
  }

  private async readyHandle(ownerUserId: string, sessionId: string): Promise<RuntimeHandle> {
    const session = await this.repository.get(sessionId)
    if (!session || session.ownerUserId !== ownerUserId) {
      throw denied('This preview is unavailable.')
    }
    const handle =
      session.state.host === 'running' && session.state.preview === 'ready'
        ? await this.repository.getRuntimeHandle(sessionId)
        : undefined
    if (!handle) {
      throw new PreviewRuntimeError({
        code: 'ENDPOINT_NOT_LISTENING',
        message:
          'Start the cloud preview first: the component preview server runs in its sandbox, next to the installed dependencies.',
        retryable: true,
      })
    }
    return handle
  }
}

// The route's shape is the preview bridge's, so the desktop checks it the
// same way: an https provider of the sandbox and a capability.
export type ComponentPreviewGrant = {
  sessionId: string
  endpointRevision: number
  integratedPreviewRequired: boolean
  primaryRouteId: string
  routes: Array<{
    routeId: string
    serviceId: string
    endpointId: string
    logicalHost: 'localhost'
    logicalPort: number
    protocol: 'http'
    providerUrl: string
    capability: string
    capabilityExpiresAt: string
  }>
}

export function componentPreviewRouteId(sessionId: string) {
  return opaqueRouteId(
    sessionId,
    componentPreviewSandbox.serviceId,
    componentPreviewSandbox.endpointId
  )
}

function denied(message: string) {
  return new PreviewRuntimeError({ code: 'PREVIEW_ACCESS_DENIED', message, retryable: false })
}
