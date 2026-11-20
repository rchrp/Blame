import * as React from "react"
import type { EngineLocation } from "@blame/agent-runtime/engine-protocol"
import { FoldVerticalIcon, LoaderCircleIcon } from "lucide-react"

import { compactTokens } from "@/components/backlog/drawer/story-context-usage"
import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"

// Compacting a conversation's context on request: the engine summarises
// older records for the model; they stay in the conversation.

export type StoryContextCompaction =
  | { status: "unavailable" }
  | { status: "busy"; reason: string }
  | { status: "idle"; compact: () => void }
  | { status: "compacting" }
  | { status: "done"; tokensAfter?: number; tokensBefore?: number }
  | { status: "unchanged" }
  | { compact: () => void; message: string; status: "failed" }

/** Compaction of an engine session: a story's or a quick chat's. */
export function useEngineCompaction(input: {
  session?: string | null
  location?: EngineLocation
  /** The session has records to compact. */
  available: boolean
  running: boolean
}): StoryContextCompaction {
  const engine = usePlatform().engine
  const { session, location, available, running } = input
  const [result, setResult] = React.useState<
    { session: string; value: StoryContextCompaction } | undefined
  >()
  if (!session || !available || !engine) return { status: "unavailable" }
  const shown = result?.session === session ? result.value : undefined
  if (shown?.status === "compacting") return shown
  if (running)
    return { status: "busy", reason: "Available once the agent pauses." }
  const compact = () => {
    setResult({ session, value: { status: "compacting" } })
    void engine
      .call("compact", { session, location })
      .then(() => setResult({ session, value: { status: "done" } }))
      .catch((error: unknown) =>
        setResult({
          session,
          value: {
            status: "failed",
            compact,
            message:
              error instanceof Error ? error.message : "Compaction failed.",
          },
        })
      )
  }
  if (shown?.status === "failed") return { ...shown, compact }
  return shown ?? { status: "idle", compact }
}

export function CompactContextButton({
  compaction,
}: {
  compaction: StoryContextCompaction
}) {
  if (compaction.status === "unavailable") return null
  const compacting = compaction.status === "compacting"
  return (
    <Button
      className="h-6 shrink-0 gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:text-foreground"
      disabled={!("compact" in compaction)}
      size="sm"
      title={
        compaction.status === "busy"
          ? compaction.reason
          : "Summarize older steps now to free context"
      }
      type="button"
      variant="ghost"
      onClick={() => {
        if ("compact" in compaction) compaction.compact()
      }}
    >
      {compacting ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : (
        <FoldVerticalIcon className="size-3" />
      )}
      {compacting ? "Compacting…" : "Compact"}
    </Button>
  )
}

// What the compaction did, in place of the usual context note.
export function compactionNote(compaction: StoryContextCompaction) {
  if (compaction.status === "done") {
    const sizes =
      compaction.tokensBefore && compaction.tokensAfter
        ? ` about ${compactTokens(compaction.tokensBefore)} → ${compactTokens(compaction.tokensAfter)}`
        : ""
    return `Compacted${sizes}. The next message picks it up.`
  }
  if (compaction.status === "unchanged")
    return "Nothing to compact yet: the context is already small."
  if (compaction.status === "failed")
    return `Couldn't compact: ${compaction.message}`
  if (compaction.status === "compacting")
    return "Summarizing older steps with the story's model…"
  return undefined
}
