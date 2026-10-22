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
import { Button } from "@/components/ui/button"
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

export function PlannedStoryCard({
  adding,
  dependencyLabel = (key) => key,
  missingDependencies,
  onAdd,
  onDismiss,
  onEdit,
  onOpen,
  story,
}: {
  adding: boolean
  // How to name a dependency: its backlog id once it was added.
  dependencyLabel?: (key: string) => string
  // Proposals this one needs that are not in the backlog yet.
  missingDependencies: string[]
  onAdd: () => void
  onDismiss: (dismissed: boolean) => void
  onEdit: (patch: PlanStoryEdit) => void
  onOpen?: () => void
  story: PlanStory
}) {
  const [expanded, setExpanded] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [title, setTitle] = React.useState(story.title)
  const [summary, setSummary] = React.useState(story.summary)

  if (story.addedAs) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
          <CheckIcon className="size-3" />
        </span>
        <span className="shrink-0 font-mono text-xs font-medium text-emerald-700 dark:text-emerald-400">
          {story.addedAs}
        </span>
        <span className="min-w-0 truncate text-sm">{story.title}</span>
        {onOpen ? (
          <Button
            className="ml-auto shrink-0"
            size="xs"
            type="button"
            variant="ghost"
            onClick={onOpen}
          >
            Open
            <ArrowUpRightIcon />
          </Button>
        ) : null}
      </div>
    )
  }

  if (story.dismissed) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-dashed px-3 py-1.5 text-muted-foreground">
        <StoryKey value={story.key} />
        <span className="min-w-0 truncate text-sm line-through decoration-muted-foreground/50">
          {story.title}
        </span>
        <Button
          className="ml-auto shrink-0"
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => onDismiss(false)}
        >
          <Undo2Icon />
          Restore
        </Button>
      </div>
    )
  }

  const criteria = acceptanceCriteriaCount(story.summary)
  const finishEditing = () => {
    const nextTitle = title.trim() || story.title
    setTitle(nextTitle)
    onEdit({ title: nextTitle, summary: summary.trim() || story.summary })
    setEditing(false)
  }
  const startEditing = () => {
    setTitle(story.title)
    setSummary(story.summary)
    setEditing(true)
    setExpanded(true)
  }

  return (
    <article
      className={cn(
        "group/plan rounded-xl border bg-card shadow-xs transition-shadow duration-200 hover:shadow-sm",
        editing && "ring-2 ring-ring/30"
      )}
    >
      <div className="flex items-start gap-3 px-3 pt-3 pb-2.5">
        <StoryKey value={story.key} className="mt-0.5" />
        <div className="grid min-w-0 flex-1 gap-1.5">
          {editing ? (
            <Input
              aria-label="Story title"
              autoFocus
              className="h-8 text-sm font-semibold"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") finishEditing()
              }}
            />
          ) : (
            <button
              type="button"
              className="text-left text-sm leading-snug font-semibold outline-none hover:underline hover:decoration-muted-foreground/40 hover:underline-offset-4 focus-visible:underline"
              onClick={() => setExpanded((value) => !value)}
            >
              {story.title}
            </button>
          )}
          {!expanded ? (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {storyGist(story.summary)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <PriorityMenu
              value={story.priority}
              onChange={(priority) => onEdit({ priority })}
            />
            {story.dependsOn.map((key) => {
              const dependency = dependencyLabel(key)
              return (
                <span
                  key={key}
                  className="inline-flex h-5 items-center gap-1 rounded-full border border-dashed px-2 text-[11px] text-muted-foreground"
                  title={`Needs ${dependency} merged first`}
                >
                  <CornerDownRightIcon className="size-3" />
                  after <span className="font-mono">{dependency}</span>
                </span>
              )
            })}
            {criteria ? (
              <span className="text-[11px] text-muted-foreground">
                {criteria} acceptance{" "}
                {criteria === 1 ? "criterion" : "criteria"}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {expanded ? (
        <div className="border-t px-3 py-3">
          {editing ? (
            <Textarea
              aria-label="Story description"
              className="max-h-96 min-h-48 font-mono text-xs leading-relaxed"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          ) : (
            <MarkdownPreview
              className="text-sm"
              markdown={story.summary}
              placeholder="No description."
            />
          )}
        </div>
      ) : null}
      <div className="flex items-center gap-1 border-t px-1.5 py-1.5">
        <Button
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon
            className={cn(
              "transition-transform duration-200",
              expanded && "rotate-180"
            )}
          />
          {expanded ? "Less" : "Details"}
        </Button>
        <Button
          size="xs"
          type="button"
          variant="ghost"
          onClick={editing ? finishEditing : startEditing}
        >
          {editing ? <CheckIcon /> : <PencilIcon />}
          {editing ? "Done" : "Edit"}
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            aria-label={`Dismiss ${story.key}`}
            size="xs"
            type="button"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => onDismiss(true)}
          >
            <XIcon />
            Dismiss
          </Button>
          <Button
            disabled={adding || editing}
            size="xs"
            type="button"
            onClick={onAdd}
            title={
              missingDependencies.length
                ? `Adds ${missingDependencies.join(", ")} first, since this story depends on it`
                : undefined
            }
          >
            {adding ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <PlusIcon />
            )}
            {missingDependencies.length
              ? `Add with ${missingDependencies.join(", ")}`
              : "Add to backlog"}
          </Button>
        </div>
      </div>
    </article>
  )
}

function StoryKey({ className, value }: { className?: string; value: string }) {
  return (
    <span
      className={cn(
        "flex h-5 min-w-7 shrink-0 items-center justify-center rounded-md bg-muted px-1.5 font-mono text-[11px] font-semibold text-muted-foreground",
        className
      )}
    >
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
          className="inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={`Priority: ${value}`}
        >
          <span className={cn("size-1.5 rounded-full", priorityTone[value])} />
          {value}
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
              <span
                className={cn("size-1.5 rounded-full", priorityTone[priority])}
              />
              {priority}
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
