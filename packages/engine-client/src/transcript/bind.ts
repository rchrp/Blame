import type { FollowEvent } from "../follow.js"
import type { TranscriptReducer } from "./reducer.js"

/**
 * Feeds what a `SessionFollower` reports into a reducer: records and deltas as
 * they come, and a fresh start for the live part whenever the follower
 * (re)attaches, since deltas missed during a drop are not coming back.
 */
export function applyFollowEvent(reducer: TranscriptReducer, event: FollowEvent): void {
  switch (event.type) {
    case "records":
      reducer.applyRecords(event.records)
      return
    case "delta":
      reducer.applyDelta(event.delta)
      return
    case "attached":
      reducer.resetLive()
      reducer.setActivity(event.activity)
      return
    case "state":
      return
  }
}
