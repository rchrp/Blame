// One event stream per agent run, whichever part of the app opened it. The
// story page and the background queue both follow runs; this registry keeps
// them from persisting the same events twice, and lets a new run close the
// streams of the run it replaces.
type RunStream = { close: () => void; storyId: string }

const streams = new Map<string, RunStream>()

export function runStreamOpen(runId: string) {
  return streams.has(runId)
}

// Registers the stream; returns false (and registers nothing) when this run
// already has one.
export function registerRunStream(
  runId: string,
  storyId: string,
  close: () => void
) {
  if (streams.has(runId)) return false
  streams.set(runId, { close, storyId })
  return true
}

export function forgetRunStream(runId: string, close?: () => void) {
  const current = streams.get(runId)
  if (!current || (close && current.close !== close)) return
  streams.delete(runId)
}

// Closes the streams of a story's earlier runs, e.g. the run an interrupting
// comment replaced, so they stop listening and persisting.
export function closeStoryRunStreams(storyId: string, exceptRunId?: string) {
  for (const [runId, stream] of [...streams]) {
    if (stream.storyId !== storyId || runId === exceptRunId) continue
    streams.delete(runId)
    stream.close()
  }
}
