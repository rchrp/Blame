import { ProposedStoriesCard } from "@/components/backlog/planning/proposed-stories-card"

import {
  useProposalHost,
  type ProposalCardProps,
  type ProposalCardRenderers,
} from "./proposal-context"
import { storyProposalToolName } from "./proposal-tools"

const defaultCards: ProposalCardRenderers = {
  [storyProposalToolName]: ProposedStoriesCard,
}

/** A proposal tool call, shown as its card next to the agent's reply. */
export function ProposalCard(props: ProposalCardProps) {
  const { cards } = useProposalHost()
  const toolName = props.activity.toolName ?? ""
  const Card = cards[toolName] ?? defaultCards[toolName]
  return Card ? <Card {...props} /> : null
}
