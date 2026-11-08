import {
  ChevronDownIcon,
  ChevronUpIcon,
  CloudIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  LockIcon,
} from "lucide-react"
import * as React from "react"

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
import { usePlatform, type GitBranchList } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { cn } from "@/lib/utils"

const triggerClassName =
  "h-8 w-44 justify-between gap-2 rounded-xl bg-muted/70 px-3 text-sm font-medium text-foreground shadow-none ring-0 transition-colors hover:bg-muted active:translate-y-0"

const directNote = "Direct runs in the project folder, on its current branch."

// The branch a story starts from and merges into. Without a choice, the
// project folder's current branch, as before.
export const BranchSelector = React.memo(function BranchSelector({
  onChange,
  readOnly = false,
  value,
}: {
  value?: string | null
  onChange?(branch: string): void
  // Direct mode: the project folder's branch, shown and not chosen.
  readOnly?: boolean
}) {
  const workspace = usePlatform().workspace
  const root = useProjects().activeProject?.path
  const [branches, setBranches] = React.useState<GitBranchList>()
  const [error, setError] = React.useState<string>()
  const [tracking, setTracking] = React.useState<string>()

  const load = React.useCallback(async () => {
    if (!root || !workspace?.gitBranches) return
    try {
      setBranches(await workspace.gitBranches({ root }))
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [root, workspace])

  // Shows the project's current branch before the list is ever opened.
  React.useEffect(() => {
    if (!root || !workspace?.gitBranches) return
    let current = true
    workspace.gitBranches({ root }).then(
      (list) => {
        if (!current) return
        setBranches(list)
        setError(undefined)
      },
      (cause: unknown) => {
        if (current) setError(errorMessage(cause))
      }
    )
    return () => {
      current = false
    }
  }, [root, workspace])

  // A remote-only branch first gets the local branch that follows it.
  const selectRemote = async (remoteBranch: string) => {
    if (!root || !workspace?.gitTrackBranch) return
    setTracking(remoteBranch)
    try {
      const { branch } = await workspace.gitTrackBranch({ root, remoteBranch })
      onChange?.(branch)
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setTracking(undefined)
    }
  }

  return (
    <BranchSelectorView
      branches={branches}
      error={error}
      onOpen={load}
      onSelectBranch={(branch) => onChange?.(branch)}
      onSelectRemote={
        workspace?.gitTrackBranch
          ? (branch) => void selectRemote(branch)
          : undefined
      }
      readOnly={readOnly || !workspace?.gitBranches}
      tracking={tracking}
      value={value}
    />
  )
})

export function BranchSelectorView({
  branches,
  error,
  onOpen,
  onSelectBranch,
  onSelectRemote,
  readOnly,
  tracking,
  value,
}: {
  branches?: GitBranchList
  error?: string
  onOpen?(): void
  onSelectBranch(branch: string): void
  onSelectRemote?(remoteBranch: string): void
  readOnly: boolean
  // The remote branch whose local branch is being created.
  tracking?: string
  value?: string | null
}) {
  const [open, setOpen] = React.useState(false)
  const selected = readOnly ? branches?.current : (value ?? branches?.current)
  const label = tracking ?? selected ?? (branches ? "Detached HEAD" : "Branch")

  if (readOnly)
    return (
      <div
        aria-label={`Branch: ${label} (${directNote})`}
        className={cn("flex items-center", triggerClassName, "hover:bg-muted/70")}
        title={directNote}
      >
        <BranchLabel label={label} />
        <LockIcon className="size-3.5 shrink-0 opacity-70" />
      </div>
    )

  const choose = (select: () => void) => {
    select()
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen?.()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          aria-label={`Branch: ${label}`}
          className={triggerClassName}
        >
          <BranchLabel label={label} loading={Boolean(tracking)} />
          {open ? (
            <ChevronUpIcon className="size-4 shrink-0 opacity-70" />
          ) : (
            <ChevronDownIcon className="size-4 shrink-0 opacity-70" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-[22rem] rounded-xl p-1"
      >
        <Command>
          <CommandInput placeholder="Search branches" />
          <CommandList>
            <CommandEmpty>No branch found.</CommandEmpty>
            <CommandGroup heading="Local">
              {branches?.local.map((branch) => (
                <CommandItem
                  key={branch}
                  value={branch}
                  data-checked={branch === selected}
                  onSelect={() => choose(() => onSelectBranch(branch))}
                >
                  <GitBranchIcon />
                  <span className="min-w-0 flex-1 truncate">{branch}</span>
                  {branch === branches.current ? (
                    <span className="text-xs text-muted-foreground">
                      current
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
            {onSelectRemote && branches?.remote.length ? (
              <CommandGroup heading="Remote">
                {branches.remote.map((branch) => (
                  <CommandItem
                    key={branch}
                    value={branch}
                    disabled={Boolean(tracking)}
                    onSelect={() => choose(() => onSelectRemote(branch))}
                  >
                    <CloudIcon />
                    <span className="min-w-0 flex-1 truncate">{branch}</span>
                    <span className="text-xs text-muted-foreground">
                      creates a local branch
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
        {error ? (
          <p className="px-3 py-2 text-xs text-destructive">{error}</p>
        ) : null}
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          The story starts from the last commit of{" "}
          <span className="font-medium text-foreground">
            {selected ?? "this branch"}
          </span>{" "}
          and merges back into it. Uncommitted changes in the folder where it
          is checked out are not included.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function BranchLabel({ label, loading }: { label: string; loading?: boolean }) {
  const Icon = loading ? LoaderCircleIcon : GitBranchIcon
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon className={cn("size-4 shrink-0", loading && "animate-spin")} />
      <span className="truncate">{label}</span>
    </span>
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
