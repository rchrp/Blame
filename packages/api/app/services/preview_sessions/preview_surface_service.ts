import PreviewSessionRepository from '#services/preview_sessions/preview_session_repository'
import PreviewDistributedLock from '#services/preview_sessions/preview_distributed_lock'
import VercelSandboxDriver from '#services/sandboxes/vercel_sandbox_driver'
import { fenceRuntimeHandle, PreviewRuntimeError } from '@blame/preview-runtime'
import { displayActionCommand } from '@blame/preview-runtime/compose'

export default class PreviewSurfaceService {
  async action(
    ownerUserId: string,
    sessionId: string,
    serviceId: string,
    args: Record<string, unknown>
  ) {
    displayActionCommand(args)
    const repository = new PreviewSessionRepository()
    return new PreviewDistributedLock().withLock(sessionId, async ({ fencingToken }) => {
      const session = await repository.get(sessionId)
      if (!session || session.ownerUserId !== ownerUserId)
        throw denied('This preview is unavailable.')
      const surface = session.plan.services.find((s) => s.id === serviceId)?.surface
      if (surface?.type !== 'display' || surface.sidecarServiceId !== serviceId)
        throw denied('This preview has no screen.')
      if (session.state.host !== 'running' || session.desired.services !== 'running')
        return { exitCode: 1, stdout: '', stderr: 'Start the preview before using its screen.' }
      const handle = await repository.getRuntimeHandle(sessionId)
      if (!handle) throw denied('Start the preview before using its screen.')
      fenceRuntimeHandle(handle, fencingToken)
      await repository.setRuntimeHandle(sessionId, handle)
      return new VercelSandboxDriver().surfaceAction(handle, serviceId, args)
    })
  }
}
function denied(message: string) {
  return new PreviewRuntimeError({ code: 'PREVIEW_ACCESS_DENIED', message, retryable: false })
}
