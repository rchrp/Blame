import * as React from "react"
import type { Transcript } from "@blame/engine-client/transcript"

import { planTabModel } from "./plan-model.ts"

/**
 * The plan to pin for a session's transcript. It follows the plan and the
 * turns, not the stream: a reply being written does not rebuild it.
 */
export function usePlanTabModel(transcript: Transcript | undefined) {
  const plan = transcript?.plan
  const turns = transcript?.turns
  const runningTurn = transcript?.runningTurn
  return React.useMemo(
    () =>
      plan && turns
        ? planTabModel({ plan, runningTurn, turns })
        : undefined,
    [plan, runningTurn, turns]
  )
}
