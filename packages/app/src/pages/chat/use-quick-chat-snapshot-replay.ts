import * as React from "react"
import { replayAgentSnapshots } from "@/components/backlog/data/agent-snapshot-outbox"
import type {
  QuickChat,
  QuickChatAgentRun,
  QuickChatAgentRunFinalization,
  QuickChatAgentRunUpdate,
} from "@/components/chat/data/quick-chat-data"
import type { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { reportAgentPersistenceError, terminalAgentStatus } from "./quick-chat-helpers"

const agentSnapshotReplayIntervalMs = 60_000

type QuickChatSnapshotReplayInput = {
  chatsRef: React.RefObject<QuickChat[]>
  clearStream: (chat: QuickChat, run: QuickChatAgentRun) => void
  loading: boolean
  projectId: string | undefined
  quickChatsRef: React.RefObject<ReturnType<typeof useQuickChatStore>>
}

// Replays agent events persisted locally while the app was offline or closed.
export function useQuickChatSnapshotReplay({
  chatsRef,
  clearStream,
  loading,
  projectId,
  quickChatsRef,
}: QuickChatSnapshotReplayInput) {
  const clearRunStream = React.useEffectEvent(clearStream)
  React.useEffect(() => {
    if (!projectId || loading) return
    const replay = async () => {
      const chatStore = quickChatsRef.current
      await replayAgentSnapshots(
        window.localStorage,
        projectId,
        "quick-chat",
        async (snapshot) => {
          const chat = chatsRef.current.find(
            (item) => item.id === snapshot.targetId
          )
          if (!chat) return
          const detailed = await chatStore.loadDetail(chat)
          const run = detailed.agentRuns?.find(
            (item) => item.id === snapshot.runId
          )
          if (!run) return
          const update = snapshot.update as
            | QuickChatAgentRunFinalization
            | QuickChatAgentRunUpdate
          if ((run.lastSequenceNumber ?? 0) >= snapshot.event.sequenceNumber) {
            if (terminalAgentStatus(update.status)) {
              clearRunStream(detailed, run)
            }
            return
          }
          if (terminalAgentStatus(update.status)) {
            await chatStore.finalizeAgentRun(
              detailed,
              run,
              update as QuickChatAgentRunFinalization
            )
            clearRunStream(detailed, run)
            return
          }
          await chatStore.updateAgentRun(detailed, run, update)
        }
      )
    }
    void replay().catch(reportAgentPersistenceError)
    const timer = window.setInterval(
      () => void replay().catch(reportAgentPersistenceError),
      agentSnapshotReplayIntervalMs
    )
    window.addEventListener("online", replay)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("online", replay)
    }
  }, [chatsRef, loading, projectId, quickChatsRef])
}
