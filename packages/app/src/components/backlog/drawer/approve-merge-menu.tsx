import * as React from "react"
import type { PullRequestAvailability } from "@blame/agent-runtime"
import {
  CheckIcon,
  ChevronDownIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
} from "lucide-react"

import type { DrawerAction } from "@/components/backlog/shared/backlog-types"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export type ApproveMergeAction = Extract<
  DrawerAction,
  "Approve & Merge" | "Open PR" | "Merge without Push"
>

// Checked each time the menu opens: gh may have been signed in meanwhile.
type PullRequestCheck =
  | { status: "checking" }
  | PullRequestAvailability
  | { status: "failed"; message: string }

const primaryTone =
  "bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"

// Approve & Merge, with its other ways to deliver the story behind the arrow:
// a GitHub pull request, or a merge that is not pushed.
export function ApproveMergeMenu({
  activeAction,
  onAction,
  onCheckPullRequest,
  targetBranch,
}: {
  activeAction?: DrawerAction
  onAction: (action: ApproveMergeAction) => void
  // Absent where gh cannot run (the web app): Open PR is not offered.
  onCheckPullRequest?: () => Promise<PullRequestAvailability>
  targetBranch?: string | null
}) {
  const [pullRequest, setPullRequest] = React.useState<PullRequestCheck>()
  const checkRequest = React.useRef(0)
  const running = isApproveMergeAction(activeAction) ? activeAction : undefined
  const busy = Boolean(activeAction)

  function checkPullRequest(open: boolean) {
    if (!open || !onCheckPullRequest) return
    const request = ++checkRequest.current
    setPullRequest({ status: "checking" })
    onCheckPullRequest().then(
      (availability) => {
        if (request === checkRequest.current) setPullRequest(availability)
      },
      (error: unknown) => {
        if (request === checkRequest.current)
          setPullRequest({
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          })
      }
    )
  }

  return (
    <ButtonGroup>
      <Button
        type="button"
        className={primaryTone}
        disabled={busy}
        onClick={() => onAction("Approve & Merge")}
      >
        {running ? <LoaderCircleIcon className="animate-spin" /> : <CheckIcon />}
        {running ?? "Approve & Merge"}
      </Button>
      <DropdownMenu onOpenChange={checkPullRequest}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            className={cn(primaryTone, "border-l border-l-white/25")}
            disabled={busy}
            aria-label="More ways to deliver"
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-80">
          {onCheckPullRequest ? (
            <PullRequestItem
              check={pullRequest}
              onSelect={() => onAction("Open PR")}
            />
          ) : null}
          <MenuAction
            description={`Merge into ${targetBranch || "the target branch"} on this computer only.`}
            icon={GitMergeIcon}
            label="Merge without Push"
            onSelect={() => onAction("Merge without Push")}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  )
}

function PullRequestItem({
  check,
  onSelect,
}: {
  check?: PullRequestCheck
  onSelect: () => void
}) {
  if (!check || check.status === "checking")
    return (
      <MenuAction
        description="Checking GitHub and gh on this computer…"
        disabled
        icon={LoaderCircleIcon}
        iconClassName="animate-spin"
        label="Open PR"
      />
    )
  // A project without a GitHub origin has no pull request to open.
  if (check.status === "not-github") return null
  if (check.status === "available")
    return (
      <MenuAction
        description={`Commit, push the branch and open a pull request on ${check.repository}.`}
        icon={GitPullRequestIcon}
        label="Open PR"
        onSelect={onSelect}
      />
    )
  return (
    <MenuAction
      description={check.message}
      disabled
      icon={GitPullRequestIcon}
      label="Open PR"
      notice
    />
  )
}

function MenuAction({
  description,
  disabled,
  icon: Icon,
  iconClassName,
  label,
  notice,
  onSelect,
}: {
  description: string
  disabled?: boolean
  icon: React.ComponentType<{ className?: string }>
  iconClassName?: string
  label: string
  // An explanation to read, kept legible on a disabled item.
  notice?: boolean
  onSelect?: () => void
}) {
  return (
    <DropdownMenuItem
      className={cn(
        "items-start gap-2.5 py-2",
        notice && "data-disabled:opacity-100"
      )}
      disabled={disabled}
      onSelect={onSelect}
    >
      <Icon
        className={cn(
          "mt-0.5",
          notice && "opacity-50",
          iconClassName
        )}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("font-medium", notice && "opacity-50")}>
          {label}
        </span>
        <span
          className={cn(
            "text-xs text-muted-foreground",
            notice && "text-amber-700 dark:text-amber-300"
          )}
        >
          {description}
        </span>
      </span>
    </DropdownMenuItem>
  )
}

function isApproveMergeAction(
  action: DrawerAction | undefined
): action is ApproveMergeAction {
  return (
    action === "Approve & Merge" ||
    action === "Open PR" ||
    action === "Merge without Push"
  )
}
