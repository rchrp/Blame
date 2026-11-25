import {
  CheckIcon,
  ChevronDownIcon,
  CloudUploadIcon,
  LoaderCircleIcon,
  SparklesIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const commitTone =
  "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-foreground/8 disabled:text-muted-foreground disabled:opacity-100"

// Commit, with Commit & Push behind the arrow, as Approve & Merge offers
// Approve, Merge & Push in the backlog.
export function CommitComposer({
  busy,
  canCommit,
  canGenerateMessage,
  generatingMessage,
  hasConflicts,
  hasChanges,
  message,
  onChange,
  onCommit,
  onCommitPush,
  onGenerateMessage,
  upstream,
}: {
  busy?: string
  canCommit: boolean
  canGenerateMessage: boolean
  generatingMessage: boolean
  hasConflicts: boolean
  hasChanges: boolean
  message: string
  onChange(value: string): void
  onCommit(): void
  onCommitPush(): void
  onGenerateMessage(): void
  upstream?: string
}) {
  const actionBusy = Boolean(busy) || generatingMessage
  const disabled = !canCommit || !message.trim() || actionBusy

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t p-3">
      <div
        className={cn(
          "flex min-w-0 flex-col rounded-2xl bg-popover shadow-[0_2px_4px_-2px_#00000012,0_10px_24px_-12px_#00000026] ring-1 ring-foreground/12 transition-[box-shadow] focus-within:ring-foreground/25 dark:shadow-[0_2px_4px_-2px_#0006,0_10px_24px_-12px_#0009]",
          !hasChanges && "opacity-60"
        )}
      >
        <Textarea
          aria-label="Commit message"
          className="max-h-48 min-h-20 resize-none rounded-2xl border-0 bg-transparent px-3.5 pt-3 pb-1 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          disabled={!hasChanges || hasConflicts || generatingMessage}
          placeholder={commitMessagePlaceholder(
            hasChanges,
            hasConflicts,
            generatingMessage
          )}
          value={message}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
              return
            event.preventDefault()
            if (!disabled) onCommit()
          }}
        />
        <div className="flex min-w-0 items-center gap-1 p-1.5 pt-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="h-8 rounded-full px-2.5 text-xs"
                disabled={!canGenerateMessage || actionBusy}
                type="button"
                variant="composer"
                onClick={onGenerateMessage}
              >
                {generatingMessage ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <SparklesIcon className="size-3.5" />
                )}
                {generatingMessage ? "Writing" : "Auto message"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Write the message from the selected changes
            </TooltipContent>
          </Tooltip>
          <div className="ml-auto flex items-center">
            <Button
              className={cn(
                "h-8 gap-1 rounded-l-full rounded-r-none pr-2.5 pl-3",
                commitTone
              )}
              disabled={disabled}
              title="Commit (⌘↵)"
              type="button"
              onClick={onCommit}
            >
              <CheckIcon className="size-3.5" />
              Commit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="More ways to commit"
                  className={cn(
                    "h-8 w-7 rounded-l-none rounded-r-full border-l border-l-white/25 pr-0.5 pl-0 disabled:border-l-foreground/10",
                    commitTone
                  )}
                  disabled={disabled}
                  type="button"
                >
                  <ChevronDownIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-72">
                <DropdownMenuItem
                  className="items-start gap-2.5 py-2"
                  onSelect={onCommitPush}
                >
                  <CloudUploadIcon className="mt-0.5" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">Commit &amp; Push</span>
                    <span className="text-xs text-muted-foreground">
                      Commit the selected files, then push them to{" "}
                      {upstream || "the remote"}.
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      <CommitHint
        busy={busy}
        canCommit={canCommit}
        hasChanges={hasChanges}
        hasConflicts={hasConflicts}
      />
    </div>
  )
}

function commitMessagePlaceholder(
  hasChanges: boolean,
  hasConflicts: boolean,
  generatingMessage: boolean
) {
  if (generatingMessage) return "Writing a commit message…"
  if (hasConflicts) return "Resolve conflicts first"
  return hasChanges ? "Commit message" : "No changes to commit"
}

function CommitHint({
  busy,
  canCommit,
  hasConflicts,
  hasChanges,
}: {
  busy?: string
  canCommit: boolean
  hasConflicts: boolean
  hasChanges: boolean
}) {
  if (busy)
    return <div className="truncate text-xs text-muted-foreground">{busy}</div>
  // Without changes, the message field already says so.
  if (!hasChanges) return null
  if (hasConflicts)
    return (
      <div className="text-xs text-muted-foreground">
        Resolve conflicts before committing.
      </div>
    )
  if (!canCommit)
    return (
      <div className="text-xs text-muted-foreground">
        Select files before committing.
      </div>
    )
  return null
}
