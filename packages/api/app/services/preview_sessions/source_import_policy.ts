import type { PreviewSessionRecord, SourceArtifact } from '@blame/preview-runtime'

export function baselineImportAction(input: {
  sourceMode?: 'full' | 'delta' | 'baseline'
  baselineId?: string
  provisionedBaselineId?: string
  sourceArtifactId?: string
  liveDeltaMatches?: boolean
}) {
  if (!input.baselineId) {
    if (input.sourceMode !== 'delta') return 'none'
    return input.liveDeltaMatches ? 'direct' : 'unavailable'
  }
  if (input.provisionedBaselineId === input.baselineId && !input.sourceArtifactId) {
    return 'reuse'
  }
  return 'restore'
}

export function liveSourceDeltaMatches(
  session:
    Pick<PreviewSessionRecord, 'workspaceHash' | 'state' | 'pendingDeltaArtifactId'> | undefined,
  source: SourceArtifact,
  baselineId?: string
) {
  return Boolean(
    session &&
    !baselineId &&
    source.mode === 'delta' &&
    source.baseHash &&
    source.workspaceHash &&
    source.baseHash !== source.workspaceHash &&
    session.workspaceHash === source.baseHash &&
    session.state.sync === 'clean' &&
    session.state.agent === 'idle' &&
    !session.pendingDeltaArtifactId
  )
}
