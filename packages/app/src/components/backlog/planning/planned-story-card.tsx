import * as React from "react"
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react"

import { MarkdownPreview } from "@/components/backlog/drawer/markdown-preview"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import type { PlanStory } from "./plan-mode-data"
import type { PlanStoryEdit } from "./use-plan-mode"

const priorities = ["High", "Medium", "Low"] as const
const priorityTone: Record<PlanStory["priority"], string> = {
  High: "bg-rose-500",
  Medium: "bg-amber-500",
  Low: "bg-sky-500",
}

export type PlannedStoryActions = {
  adding: boolean
  // How to name a dependency: its backlog id once it was added.
  dependencyLabel: (key: string) => string
  // Proposals this one needs that are not in the backlog yet.
  missingDependencies: string[]
  onAdd: () => void
  onDismiss: (dismissed: boolean) => void
  onEdit: (patch: PlanStoryEdit) => void
  onOpen?: () => void
}

/** A proposal in the carousel: a backlog card, smaller. */
export function PlannedStoryCard({
  actions,
  onSelect,
  selected,
  story,
}: {
  actions: PlannedStoryActions
  onSelect: () => void
  selected: boolean
  story: PlanStory
}) {
  const criteria = acceptanceCriteriaCount(story.summary)
  const dependencies = story.dependsOn.map(actions.dependencyLabel)
  return (
    <Card
      size="sm"
      className={cn(
        "group/user-story h-full rounded-lg bg-white! transition-[box-shadow,opacity] duration-200 dark:bg-neutral-900!",
        selected && "ring-2 ring-blue-500/60 dark:ring-blue-400/60",
        story.dismissed && "opacity-55"
      )}
    >
      <CardHeader className="gap-1.5">
        <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="shrink-0 font-mono">
            {story.addedAs ?? story.key}
          </span>
          <PriorityLabel value={story.priority} />
        </p>
        <CardTitle className="min-w-0 text-sm leading-snug">
          <button
            type="button"
            aria-expanded={selected}
            className={cn(
              "line-clamp-2 text-left font-medium break-words text-card-foreground transition-colors outline-none group-hover/user-story:text-blue-600 focus-visible:text-blue-600 dark:group-hover/user-story:text-blue-300 dark:focus-visible:text-blue-300",
              story.dismissed && "line-through"
            )}
            onClick={onSelect}
          >
            {story.title}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid flex-1 content-start gap-2">
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {storyGist(story.summary)}
        </p>
        {dependencies.length ? (
          <p
            className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
            title={`Needs ${dependencies.join(", ")} merged first`}
          >
            <CornerDownRightIcon className="size-3 shrink-0" />
            <span className="truncate">
              after <span className="font-mono">{dependencies.join(", ")}</span>
            </span>
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="gap-2 py-2!">
        {story.addedAs ? (
          <Badge variant="outline" className="gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            In backlog
          </Badge>
        ) : story.dismissed ? (
          <Badge variant="outline">Dismissed</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">
            {criteria
              ? `${criteria} ${criteria === 1 ? "criterion" : "criteria"}`
              : "Proposed"}
          </span>
        )}
        <span className="ml-auto">
          <StoryAction actions={actions} story={story} compact />
        </span>
      </CardFooter>
    </Card>
  )
}

/** The selected proposal in full, under the carousel, to read and edit. */
export function PlannedStoryDetail({
  actions,
  onClose,
  story,
}: {
  actions: PlannedStoryActions
  onClose: () => void
  story: PlanStory
}) {
  const [editing, setEditing] = React.useState(false)
  const [title, setTitle] = React.useState(story.title)
  const [summary, setSummary] = React.useState(story.summary)
  const editable = !story.addedAs
  const finishEditing = () => {
    actions.onEdit({
      title: title.trim() || story.title,
      summary: summary.trim() || story.summary,
    })
    setEditing(false)
  }
  const startEditing = () => {
    setTitle(story.title)
    setSummary(story.summary)
    setEditing(true)
  }

  return (
    <Card
      size="sm"
      className="chat-enter-step rounded-lg bg-white! dark:bg-neutral-900!"
    >
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-1.5">
        <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="font-mono">{story.addedAs ?? story.key}</span>
          {editable ? (
            <PriorityMenu
              value={story.priority}
              onChange={(priority) => actions.onEdit({ priority })}
            />
          ) : (
            <PriorityLabel value={story.priority} />
          )}
          {story.dependsOn.map((key) => (
            <span key={key} className="inline-flex items-center gap-1">
              <CornerDownRightIcon className="size-3" />
              after{" "}
              <span className="font-mono">{actions.dependencyLabel(key)}</span>
            </span>
          ))}
        </p>
        <Button
          aria-label="Close details"
          className="row-span-2 -mt-1 -mr-1"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={onClose}
        >
          <XIcon />
        </Button>
        <CardTitle className="text-base! leading-snug">
          {editing ? (
            <Input
              aria-label="Story title"
              autoFocus
              className="h-8 text-sm font-medium"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") finishEditing()
              }}
            />
          ) : (
            story.title
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {editing ? (
          <Textarea
            aria-label="Story description"
            className="max-h-80 min-h-48 font-mono text-xs leading-relaxed"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        ) : (
          <div className="max-h-80 overflow-y-auto pr-1">
            <MarkdownPreview
              className="text-sm"
              markdown={story.summary}
              placeholder="No description."
            />
          </div>
        )}
      </CardContent>
      <CardFooter className="gap-1 py-2!">
        {editable ? (
          <Button
            size="xs"
            type="button"
            variant="ghost"
            onClick={editing ? finishEditing : startEditing}
          >
            {editing ? <CheckIcon /> : <PencilIcon />}
            {editing ? "Done" : "Edit"}
          </Button>
        ) : null}
        {editable && !story.dismissed ? (
          <Button
            className="text-muted-foreground"
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => {
              actions.onDismiss(true)
              onClose()
            }}
          >
            <XIcon />
            Dismiss
          </Button>
        ) : null}
        <span className="ml-auto">
          <StoryAction actions={actions} story={story} disabled={editing} />
        </span>
      </CardFooter>
    </Card>
  )
}

function StoryAction({
  actions,
  compact,
  disabled,
  story,
}: {
  actions: PlannedStoryActions
  compact?: boolean
  disabled?: boolean
  story: PlanStory
}) {
  if (story.addedAs)
    return actions.onOpen ? (
      <Button size="xs" type="button" variant="ghost" onClick={actions.onOpen}>
        Open
        <ArrowUpRightIcon />
      </Button>
    ) : null
  if (story.dismissed)
    return (
      <Button
        size="xs"
        type="button"
        variant="ghost"
        onClick={() => actions.onDismiss(false)}
      >
        <Undo2Icon />
        Restore
      </Button>
    )
  const missing = actions.missingDependencies
  return (
    <Button
      disabled={actions.adding || disabled}
      size="xs"
      type="button"
      onClick={actions.onAdd}
      title={
        missing.length
          ? `Adds ${missing.join(", ")} first, since this story depends on it`
          : "Add to the backlog as a draft"
      }
    >
      {actions.adding ? (
        <LoaderCircleIcon className="animate-spin" />
      ) : (
        <PlusIcon />
      )}
      {missing.length
        ? `Add with ${missing.join(", ")}`
        : compact
          ? "Add"
          : "Add to backlog"}
    </Button>
  )
}

function PriorityLabel({ value }: { value: PlanStory["priority"] }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", priorityTone[value])} />
      {value}
    </span>
  )
}

function PriorityMenu({
  onChange,
  value,
}: {
  onChange: (value: PlanStory["priority"]) => void
  value: PlanStory["priority"]
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={`Priority: ${value}`}
        >
          <PriorityLabel value={value} />
          <ChevronDownIcon className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-32">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as PlanStory["priority"])}
        >
          {priorities.map((priority) => (
            <DropdownMenuRadioItem key={priority} value={priority}>
              <PriorityLabel value={priority} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function acceptanceCriteriaCount(markdown: string) {
  return markdown.match(/^\s*[-*]\s+\[[ xX]\]\s+/gmu)?.length ?? 0
}

// The first paragraph of the brief, without Markdown marks.
export function storyGist(markdown: string) {
  const paragraph =
    markdown
      .split(/\n\s*\n/u)
      .map((block) => block.trim())
      .find((block) => block && !block.startsWith("#")) ?? ""
  return paragraph
    .replace(/[#*_`>]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
}
