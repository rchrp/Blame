import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  ListEndIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react"
import * as React from "react"

import {
  startsAfterChoices,
  startsAfterEntries,
  userStoryDisplayId,
  type StartsAfterEntry,
  type UserStory,
} from "@/components/backlog/data/backlog-data"
import { useBacklogSelector } from "@/components/backlog/data/backlog-store"
import {
  storyDependencyName,
  storyWaitText,
  useStoryWait,
} from "@/components/backlog/data/story-queue-waits"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  SelectorGroup,
  selectorChevronClassName,
  selectorSegmentClassName,
} from "@/components/ui/selector-group"
import { cn } from "@/lib/utils"

// The stories a story only starts after, once each is done: it stays in the
// Agent Queue until then. Editable while the story has not started; the API
// refuses what would not hold (a cycle, another target branch) with a
// message, shown here while the previous choice stays.
export const StartsAfterField = React.memo(function StartsAfterField({
  editable,
  onChange,
  queued,
  storyId,
  value,
}: {
  editable: boolean
  // Saves the choice; rejects with the API's message when it refuses it.
  onChange: (storyIds: string[]) => Promise<unknown> | void
  // The story waits in Agent Queue: it says why it does not start.
  queued: boolean
  storyId?: string
  value: readonly string[]
}) {
  const stories = useBacklogSelector((backlog) => backlog.stories)
  const entries = startsAfterEntries(value, stories)
  const [error, setError] = React.useState<string>()
  const [saving, setSaving] = React.useState(false)
  const wait = useStoryWait(storyId ?? "")
  const waitText = queued && wait ? storyWaitText(wait) : undefined

  const save = async (next: string[]) => {
    setError(undefined)
    setSaving(true)
    try {
      await onChange(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  const toggle = (id: string) =>
    save(
      value.includes(id) ? value.filter((item) => item !== id) : [...value, id]
    )

  if (!editable && !entries.length && !waitText) return null
  return (
    <div className="grid gap-1.5" data-slot="starts-after-field">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {editable ? (
          <StartsAfterPicker
            choices={startsAfterChoices(stories, storyId)}
            onToggle={(id) => void toggle(id)}
            saving={saving}
            value={value}
          />
        ) : (
          <span className="text-sm font-medium text-muted-foreground">
            Starts after
          </span>
        )}
        {entries.map((entry) => (
          <StartsAfterChip
            entry={entry}
            key={entry.id}
            onRemove={editable ? () => void toggle(entry.id) : undefined}
          />
        ))}
      </div>
      {error ? (
        <p className="text-xs break-words text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {waitText ? (
        <p className="flex items-center gap-1.5 text-xs font-medium break-words text-muted-foreground">
          <ClockIcon className="size-3 shrink-0" />
          {waitText}
        </p>
      ) : null}
    </div>
  )
})

function StartsAfterChip({
  entry,
  onRemove,
}: {
  entry: StartsAfterEntry
  onRemove?: () => void
}) {
  const name = storyDependencyName(entry.story ?? {})
  // Neither done in a way that holds: this story would never start.
  const gone = !entry.story || entry.story.status === "discarded"
  const label = gone
    ? `${name} (${entry.story ? "discarded" : "deleted"})`
    : name
  return (
    <span
      className={cn(
        "inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-xl bg-muted/70 pr-3 pl-3 text-sm font-medium",
        onRemove && "pr-1.5",
        gone && "text-destructive"
      )}
      title={label}
    >
      <span className="truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground"
          onClick={onRemove}
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </span>
  )
}

function StartsAfterPicker({
  choices,
  onToggle,
  saving,
  value,
}: {
  choices: readonly StoryChoice[]
  onToggle: (storyId: string) => void
  saving: boolean
  value: readonly string[]
}) {
  const [open, setOpen] = React.useState(false)
  const Chevron = open ? ChevronUpIcon : ChevronDownIcon
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SelectorGroup>
        <PopoverTrigger asChild>
          <Button
            type="button"
            aria-label="Starts after"
            className={selectorSegmentClassName}
          >
            {saving ? (
              <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
            ) : (
              <ListEndIcon className="size-4 shrink-0" />
            )}
            <span className="truncate">Starts after</span>
            <Chevron className={selectorChevronClassName} />
          </Button>
        </PopoverTrigger>
      </SelectorGroup>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-[22rem] rounded-xl p-1"
      >
        <Command>
          <CommandInput placeholder="Search stories" />
          <CommandList>
            <CommandEmpty>No story found.</CommandEmpty>
            <CommandGroup>
              {choices.map((story) => (
                <CommandItem
                  key={story.id}
                  value={`${storyDependencyName(story)} ${story.id}`}
                  data-checked={value.includes(story.id)}
                  disabled={saving}
                  onSelect={() => onToggle(story.id)}
                >
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {userStoryDisplayId(story)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{story.title}</span>
                  {value.includes(story.id) ? (
                    <CheckIcon className="size-4 shrink-0" />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          The story stays in Agent Queue until each of these is done.
        </p>
      </PopoverContent>
    </Popover>
  )
}

type StoryChoice = Pick<UserStory, "id" | "status" | "storyNumber" | "title">
