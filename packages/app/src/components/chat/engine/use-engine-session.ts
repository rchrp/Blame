import * as React from "react"
import {
  TranscriptReducer,
  applyFollowEvent,
  type Transcript,
} from "@blame/engine-client/transcript"

import type { EngineLocation } from "@blame/agent-runtime/engine-protocol"

import { usePlatform } from "@/context/platform"

export type EngineSessionView = {
  transcript: Transcript | undefined
  /** The engine host could not follow the session (see `error`). */
  error?: string
  /** Every record the engine held when the view attached has arrived. */
  loaded: boolean
}

/**
 * The conversation of one engine session, as it is now: its records folded
 * by the transcript reducer, live deltas included. The same path serves a
 * conversation streaming right now and one reopened after a restart; the
 * renderer keeps nothing between loads.
 */
export function useEngineSession(
  session: string | null | undefined,
  location?: EngineLocation
): EngineSessionView {
  const platform = usePlatform()
  const [view, setView] = React.useState<EngineSessionView & { session?: string }>({
    loaded: false,
    transcript: undefined,
  })
  React.useEffect(() => {
    const engine = platform.engine
    if (!engine || !session) return
    const reducer = new TranscriptReducer()
    let loaded = false
    let frame: number | undefined
    // One render per frame, however fast deltas stream.
    const publish = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined
        setView({ loaded, session, transcript: reducer.snapshot() })
      })
    }
    const stop = engine.follow(
      session,
      (event) => {
      applyFollowEvent(reducer, event)
      if (event.type === "state" && event.state === "live") loaded = true
      if (event.type === "state" && event.state === "stopped" && event.error) {
        setView({
          error: errorText(event.error),
          loaded: true,
          session,
          transcript: reducer.snapshot(),
        })
        return
      }
      publish()
      },
      location
    )
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      stop()
    }
  }, [location, platform.engine, session])
  // A view of another session is not this one's, even for a frame.
  return view.session === session ? view : { loaded: false, transcript: undefined }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "The conversation could not be loaded."
}
