import * as React from "react"
import { FoldVerticalIcon, LoaderCircleIcon } from "lucide-react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { storyMaxInputTokens } from "@/components/backlog/data/story-context-limit"
import { useStoryModelChoice } from "@/components/backlog/data/story-model-choice"
import { compactTokens } from "@/components/backlog/drawer/story-context-usage"
import { useModelSelection } from "@/components/model/model-selection"
import { Button } from "@/components/ui/button"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"

// Compacting a story's context on request: Cline's own manual compaction of
// the agent's session, picked up when the next message resumes it.

export type StoryContextCompaction =
  | { status: "unavailable" }
  | { status: "busy"; reason: string }
  | { status: "idle"; compact: () => void }
  | { status: "compacting" }
  | { status: "done"; tokensAfter?: number; tokensBefore?: number }
  | { status: "unchanged" }
  | { compact: () => void; message: string; status: "failed" }

export function useStoryContextCompaction(
  userStory?: UserStory
): StoryContextCompaction {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const selection = useModelSelection()
  const choice = useStoryModelChoice(userStory)
  const [result, setResult] = React.useState<{
    sessionId: string
    value:
      | Exclude<
          StoryContextCompaction,
          { status: "idle" | "busy" | "unavailable" | "failed" }
        >
      | { message: string; status: "failed" }
  }>()
  // A new run makes the last outcome stale: compacting is offered again.
  const agentStatus = userStory?.agentStatus
  const [seenAgentStatus, setSeenAgentStatus] = React.useState(agentStatus)
  if (seenAgentStatus !== agentStatus) {
    setSeenAgentStatus(agentStatus)
    if (agentStatus === "Running" && result?.value.status !== "compacting")
      setResult(undefined)
  }
  const compactSession = platform.agent?.sessions.compact
  const sessionId = userStory?.clineSessionId ?? undefined
  if (!compactSession || !sessionId || !userStory || !choice) {
    return { status: "unavailable" }
  }
  if (auth.status !== "authenticated") return { status: "unavailable" }
  const shown = result?.sessionId === sessionId ? result.value : undefined
  if (shown?.status === "compacting") return shown
  if (userStory.agentStatus === "Running") {
    return { status: "busy", reason: "Available once the agent pauses." }
  }

  const compact = () => {
    const provider = selection.allProviders.find(
      (item) => item.id === choice.providerId
    )
    setResult({ sessionId, value: { status: "compacting" } })
    void compactSession({
      apiConnection: auth.apiConnection,
      credentialLabel: choice.credentialLabel ?? undefined,
      maxInputTokens: storyMaxInputTokens(
        userStory.id,
        provider?.models[choice.modelId],
        selection.allProviders
      ),
      modelId: choice.modelId,
      providerId: choice.providerId,
      sessionId,
    })
      .then((outcome) =>
        setResult({
          sessionId,
          value: outcome.compacted
            ? {
                status: "done",
                tokensAfter: outcome.tokensAfter,
                tokensBefore: outcome.tokensBefore,
              }
            : { status: "unchanged" },
        })
      )
      .catch((error: unknown) =>
        setResult({
          sessionId,
          value: {
            status: "failed",
            message:
              error instanceof Error ? error.message : "Compaction failed.",
          },
        })
      )
  }
  if (shown?.status === "failed") return { ...shown, compact }
  if (shown) return shown
  return { status: "idle", compact }
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
