import * as React from "react"
import {
  TranscriptReducer,
  applyFollowEvent,
  type Transcript,
} from "@blame/engine-client/transcript"

import type { EngineLocation } from "@blame/agent-runtime/engine-protocol"

import { usePlatform } from "@/context/platform"

/** How long to wait before asking for a session that does not exist yet. */
const RETRY_MS = 400
/** How many times: the engine creates a helper's session within a moment. */
const MAX_RETRIES = 20

/**
 * Several engine sessions followed at once: the transcript of each, as
 * `useEngineSession` gives one. A session the engine has not created yet is
 * asked for again shortly, which is how the helpers of a call that has just
 * started are found. Sessions not listed are not followed.
 */
export function useEngineSessions(
  sessions: readonly string[],
  location?: EngineLocation
): ReadonlyMap<string, Transcript> {
  const platform = usePlatform()
  const [transcripts, setTranscripts] = React.useState<
    ReadonlyMap<string, Transcript>
  >(new Map())
  const key = sessions.join("\n")
  React.useEffect(() => {
    const engine = platform.engine
    const wanted = key ? key.split("\n") : []
    if (!engine || !wanted.length) return
    const stops: Array<() => void> = []
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const reducers = new Map<string, TranscriptReducer>()
    let frame: number | undefined
    let ended = false
    const publish = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined
        setTranscripts(
          new Map(
            [...reducers].map(([session, reducer]) => [
              session,
              reducer.snapshot(),
            ])
          )
        )
      })
    }
    const follow = (session: string, retries: number) => {
      const reducer = new TranscriptReducer()
      reducers.set(session, reducer)
      const stop = engine.follow(
        session,
        (event) => {
          if (ended) return
          if (
            event.type === "state" &&
            event.state === "stopped" &&
            event.error
          ) {
            // Not created yet, or gone: ask again shortly, a few times.
            if (retries >= MAX_RETRIES) return
            reducers.delete(session)
            const timer = setTimeout(() => {
              timers.delete(timer)
              if (!ended) follow(session, retries + 1)
            }, RETRY_MS)
            timers.add(timer)
            return
          }
          applyFollowEvent(reducer, event)
          publish()
        },
        location
      )
      stops.push(stop)
    }
    for (const session of wanted) follow(session, 0)
    return () => {
      ended = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      for (const timer of timers) clearTimeout(timer)
      for (const stop of stops) stop()
    }
  }, [key, location, platform.engine])
  return transcripts
}
