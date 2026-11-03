import * as React from "react"
import { ChevronRightIcon, LoaderCircleIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { userStoryDisplayId } from "@/components/backlog/data/backlog-data"
import { selectBacklogStory } from "@/components/backlog/data/backlog-navigation"
import { useBacklogStore } from "@/components/backlog/data/backlog-store"
import {
  useProposalDetail,
  useProposalHost,
  useStoryProposals,
  type ProposalCardProps,
} from "@/components/chat/proposals/proposal-context"
import {
  proposalId,
  proposedStories,
} from "@/components/chat/proposals/proposal-tools"
import { navigate } from "@/components/navigation/navigation"
import { Button } from "@/components/ui/button"
import { useProjects } from "@/context/projects"
import { readStoryRunMode } from "@/lib/runtime-preference"
import { cn } from "@/lib/utils"

import { PlanStoryCarousel } from "./plan-story-carousel"
import {
  addedStoryRefs,
  decidedStories,
  missingDependencies,
  pendingStories,
  plannedStoryMarkdown,
  storiesToAdd,
  type PlanStory,
} from "./story-proposal-data"
import {
  decideProposalStory,
  useProposalDecisions,
} from "./story-proposal-state"

/** The stories an agent proposed with propose_user_stories, as cards. */
export function ProposedStoriesCard(props: ProposalCardProps) {
  const detail = useProposalDetail(props)
  const projectId = useProjects().activeProject?.id
  const backlog = useBacklogStore()
  const host = useProposalHost()
  const decisions = useProposalDecisions(projectId)
  const conversationProposals = useStoryProposals()
  const id = proposalId(props.run, props.activity)
  const [adding, setAdding] = React.useState<ReadonlySet<string>>(new Set())
  const [showEarlier, setShowEarlier] = React.useState(false)
  const proposed = React.useMemo(
    () => (detail ? proposedStories(detail) : []),
    [detail]
  )
  const stories = decidedStories(proposed, decisions[id])
  if (!stories.length) return null

  const latest = conversationProposals.at(-1) === id
  const expanded = latest || showEarlier
  const pending = pendingStories(stories)
  const added = stories.filter((story) => story.addedAs).length
  const addingAll = pending.some((story) => adding.has(story.key))
  // Earlier proposals of the conversation may hold the dependencies.
  const earlier = conversationProposals.slice(
    0,
    Math.max(conversationProposals.indexOf(id), 0)
  )
  const earlierRefs = addedStoryRefs(
    earlier.map((key) =>
      Object.entries(decisions[key] ?? {}).map(([storyKey, decision]) => ({
        key: storyKey,
        title: decision.title ?? storyKey,
        summary: "",
        priority: "Medium" as const,
        dependsOn: [],
        ...decision,
      }))
    )
  )
  const dependencyLabel = (key: string) =>
    stories.find((story) => story.key === key)?.addedAs ??
    earlierRefs.get(key)?.displayId ??
    key
  const openStory = (storyId: string) => {
    if (host.onOpenStory) return host.onOpenStory(storyId)
    selectBacklogStory(storyId)
    navigate("/backlog")
  }

  async function addStories(keys: string[]) {
    const toAdd = storiesToAdd(stories, keys)
    if (!toAdd.length) return
    const refs = new Map(earlierRefs)
    setAdding((current) => new Set([...current, ...toAdd.map((s) => s.key)]))
    const created: string[] = []
    try {
      for (const story of toAdd) {
        const userStory = await backlog.create({
          title: story.title,
          summary: plannedStoryMarkdown(story, (key) => refs.get(key)),
          priority: story.priority,
          status: "backlog",
          runMode: readStoryRunMode(),
        })
        const displayId = userStoryDisplayId(userStory)
        refs.set(story.key, { id: userStory.id, displayId, title: story.title })
        created.push(displayId)
        decideProposalStory(projectId, id, story.key, {
          addedAs: displayId,
          addedStoryId: userStory.id,
          dismissed: undefined,
          title: story.title,
        })
      }
    } catch (error) {
      toast.error("Unable to add the story to the backlog", {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setAdding((current) => {
        const next = new Set(current)
        for (const story of toAdd) next.delete(story.key)
        return next
      })
    }
    if (created.length)
      toast.success(
        created.length === 1
          ? `${created[0]} added to the backlog`
          : `${created.length} stories added to the backlog`,
        { description: created.length > 1 ? created.join(", ") : undefined }
      )
  }

  const actionsFor = (story: PlanStory) => ({
    adding: adding.has(story.key),
    dependencyLabel,
    missingDependencies: missingDependencies(stories, story.key),
    onAdd: () => void addStories([story.key]),
    onDismiss: (dismissed: boolean) =>
      decideProposalStory(projectId, id, story.key, { dismissed }),
    onEdit: (patch: Parameters<typeof decideProposalStory>[3]) =>
      decideProposalStory(projectId, id, story.key, patch),
    onOpen:
      story.addedStoryId &&
      backlog.stories.some((item) => item.id === story.addedStoryId)
        ? () => openStory(story.addedStoryId!)
        : undefined,
  })

  return (
    <section className="grid gap-2" aria-label="Proposed stories">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={latest}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground outline-none enabled:hover:text-foreground"
          onClick={() => setShowEarlier((value) => !value)}
        >
          {!latest ? (
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform",
                showEarlier && "rotate-90"
              )}
            />
          ) : null}
          {latest ? "Proposed stories" : "Earlier proposal"} · {stories.length}
          {added ? ` · ${added} added` : ""}
        </button>
        {expanded && pending.length > 1 ? (
          <Button
            className="ml-auto"
            disabled={addingAll}
            size="sm"
            type="button"
            onClick={() => void addStories(pending.map((story) => story.key))}
          >
            {addingAll ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <PlusIcon />
            )}
            Add all {pending.length}
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <PlanStoryCarousel stories={stories} actionsFor={actionsFor} />
      ) : null}
    </section>
  )
}
