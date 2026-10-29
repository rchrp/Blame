import type { PreviewSessionView } from '@blame/preview-runtime'
import type { PreviewRuntimeConfig } from '#config/preview_runtime'
import type { PreviewBaselineSourceMetadata } from '#services/preview_baselines/preview_project_baseline_service'

export function sourceImportUnchanged(
  session: Pick<
    PreviewSessionView,
    'state' | 'pendingDeltaArtifactId' | 'workspaceHash' | 'sourceRevision'
  >,
  metadata: PreviewBaselineSourceMetadata
) {
  return (
    session.state.sync === 'clean' &&
    !session.pendingDeltaArtifactId &&
    session.workspaceHash === metadata.workspaceHash &&
    session.sourceRevision === metadata.baseRevision &&
    ['running', 'suspended'].includes(session.state.host)
  )
}

// A sandbox started with another runner fails its handshake, so it is recreated.
export function usesCurrentRunner(
  session: { runnerVersion?: string; imageDigest?: string },
  sandbox: Pick<PreviewRuntimeConfig['sandbox'], 'image' | 'runnerVersion'>
) {
  const digest = sandbox.image?.split('@')[1]
  if (session.runnerVersion && session.runnerVersion !== sandbox.runnerVersion) return false
  return !digest || !session.imageDigest || session.imageDigest === digest
}
