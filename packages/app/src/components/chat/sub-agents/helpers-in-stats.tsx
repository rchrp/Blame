import { Pop } from "@/components/backlog/drawer/user-story-drawer-sidebar"
import { cn } from "@/lib/utils"

import { HelperAvatar } from "./helper-avatar"
import { formatDuration } from "./sub-agents-view"
import type { SubAgentRow } from "./sub-agents-view"

// The helper agents that run now, in the agent's stats island: a reminder, so
// that they stay in view when the conversation has scrolled away from them.

/** The expanded panel: each helper that works, with its flower and its time. */
export function HelpersSection({
  helpers,
}: {
  helpers: readonly SubAgentRow[]
}) {
  // The ones still to come first; the ones done have nothing to remind.
  const open = helpers.filter(
    (helper) => helper.status === "running" || helper.status === "waiting"
  )
  const working = open.filter((helper) => helper.status === "running")
  const waiting = open.length - working.length
  if (!open.length) return null
  return (
    <section aria-label="Helper agents running" className="grid gap-2.5">
      <Pop className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          Helpers
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {working.length} running{waiting ? ` · ${waiting} waiting` : ""}
        </span>
      </Pop>
      <Pop>
        <ul className="grid gap-1.5">
          {open.map((helper) => (
            <li
              key={helper.session}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 text-sm"
            >
              <HelperAvatar
                identity={helper.identity}
                size={20}
                status={helper.status}
              />
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 font-medium">
                  {helper.identity.name}
                </span>
                <span className="truncate text-muted-foreground">
                  {helper.status === "running"
                    ? (helper.current ?? helper.title)
                    : helper.title}
                </span>
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {helper.status === "waiting"
                  ? "Waiting"
                  : formatDuration(helper.durationMs)}
              </span>
            </li>
          ))}
        </ul>
      </Pop>
    </section>
  )
}

/** The pill: the flowers of the helpers that work, overlapped. */
export function HelpersPill({
  className,
  helpers,
}: {
  className?: string
  helpers: readonly SubAgentRow[]
}) {
  const shown = helpers.slice(0, 3)
  return (
    <Pop className={cn("flex items-center", className)}>
      <span
        className="flex items-center"
        role="img"
        aria-label={`${helpers.length} helper ${helpers.length === 1 ? "agent" : "agents"} running`}
      >
        {shown.map((helper, index) => (
          // The ring is on the avatar itself, which has an exact size: a
          // wrapper without one stretches its ring below the flower.
          <HelperAvatar
            key={helper.session}
            className={cn(
              "rounded-full ring-2 ring-card dark:ring-muted",
              index > 0 && "-ml-2"
            )}
            identity={helper.identity}
            size={20}
            status="running"
          />
        ))}
        {helpers.length > shown.length ? (
          <span className="ml-1 text-[10px] font-medium text-muted-foreground tabular-nums">
            +{helpers.length - shown.length}
          </span>
        ) : null}
      </span>
    </Pop>
  )
}

/** Room the pill needs for the flowers. */
export const helpersPillWidth = 64
