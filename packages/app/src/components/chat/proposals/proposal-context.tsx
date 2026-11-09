import * as React from "react"

import type {
  UserStoryAgentActivity,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import type { AgentConversationRun } from "@/components/chat/agent-conversation"

import { fullToolDetail, storyProposalIds } from "./proposal-tools"

export type ProposalCardProps = {
  activity: UserStoryAgentActivity
  onLoadDetail: (activity: UserStoryAgentActivity) => Promise<string>
  run: AgentConversationRun
}

export type ProposalCardRenderers = Partial<
  Record<string, React.ComponentType<ProposalCardProps>>
>

type ProposalHost = {
  cards: ProposalCardRenderers
  // The files attached to the conversation, which a proposed story can
  // carry. Without them, proposals do not offer files.
  fileAttachments?: UserStoryFileAttachment[]
  // Opens a story added from a proposal; the backlog by default.
  onOpenStory?: (storyId: string) => void
}

const ProposalHostContext = React.createContext<ProposalHost>({ cards: {} })
const StoryProposalsContext = React.createContext<string[]>([])

/** Lets a surface render its own proposal cards or open stories its way. */
export function ProposalHostProvider({
  cards,
  children,
  fileAttachments,
  onOpenStory,
}: Partial<ProposalHost> & { children: React.ReactNode }) {
  const parent = React.useContext(ProposalHostContext)
  const value = React.useMemo(
    () => ({
      cards: cards ? { ...parent.cards, ...cards } : parent.cards,
      fileAttachments: fileAttachments ?? parent.fileAttachments,
      onOpenStory: onOpenStory ?? parent.onOpenStory,
    }),
    [cards, fileAttachments, onOpenStory, parent]
  )
  return (
    <ProposalHostContext.Provider value={value}>
      {children}
    </ProposalHostContext.Provider>
  )
}

export function useProposalHost() {
  return React.useContext(ProposalHostContext)
}

/** The story proposals of the conversation shown, oldest first. */
export function StoryProposalsProvider({
  children,
  runs,
}: {
  children: React.ReactNode
  runs: AgentConversationRun[]
}) {
  const ids = storyProposalIds(runs)
  const key = ids.join("|")
  const value = React.useMemo(() => (key ? key.split("|") : []), [key])
  return (
    <StoryProposalsContext.Provider value={value}>
      {children}
    </StoryProposalsContext.Provider>
  )
}

export function useStoryProposals() {
  return React.useContext(StoryProposalsContext)
}

/** The full tool call behind a card, loading it when the thread compacted it. */
export function useProposalDetail({
  activity,
  onLoadDetail,
}: ProposalCardProps) {
  const parsed = React.useMemo(
    () => fullToolDetail(activity.detail),
    [activity.detail]
  )
  const [loaded, setLoaded] =
    React.useState<ReturnType<typeof fullToolDetail>>()
  const ready = activity.status === "completed"
  React.useEffect(() => {
    if (parsed || !ready) return
    let current = true
    onLoadDetail(activity)
      .then((detail) => {
        if (current) setLoaded(fullToolDetail(detail))
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
    // Load once per call; the callback identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id, parsed, ready])
  return ready ? (parsed ?? loaded) : undefined
}
