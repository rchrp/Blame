import * as React from "react"
import { toast } from "sonner"

import { usePlatform } from "@/context/platform"
import { cn } from "@/lib/utils"
import {
  browserStorage,
  claimStarInvite,
  starInviteDue,
  starInviteRepositoryUrl,
  type MergeOutcome,
} from "@/lib/star-invite"
import { StarInviteCard } from "./star-invite-card"

// Lets the merge's own confetti and toast land first.
const afterMergeMs = 1600
// The merge toast stays about 4 s: wait for it to leave rather than stack on
// it, but never longer than this behind a toast that stays open.
const toastWaitMs = 6000
// While something is in the way, look again this often, then leave a beat
// once it is gone so the card doesn't arrive on its exit.
const pollMs = 400
const settleMs = 500
const toastId = "blame-star-invite"

let pending = false
const listeners = new Set<() => void>()

/** Asks for the invitation after a merge; only the first merge ever gets it. */
export function inviteToStarAfter(outcome: MergeOutcome) {
  if (starInviteDue(outcome, browserStorage())) setPending(true)
}

function setPending(value: boolean) {
  if (pending === value) return
  pending = value
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function readPending() {
  return pending
}

// A dialog or drawer in front, or a window nobody can see.
function blocked() {
  if (document.visibilityState !== "visible") return true
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
    ) !== null
  )
}

// Another toast in the corner the card would share.
function cornerTaken() {
  return (
    document.querySelector(
      '[data-sonner-toaster][data-y-position="bottom"][data-x-position="right"] [data-sonner-toast]:not([data-removed="true"])'
    ) !== null
  )
}

/**
 * Shows a pending invitation once nothing is in its way. Mounted with the
 * main app only, so the onboarding never has it on top.
 */
export function StarInvite() {
  const platform = usePlatform()
  const isPending = React.useSyncExternalStore(subscribe, readPending)
  const shown = React.useRef(false)

  React.useEffect(() => {
    if (!isPending) return
    const startedAt = Date.now()
    let timer = 0
    let waited = false
    const check = () => {
      const crowded = cornerTaken() && Date.now() - startedAt < toastWaitMs
      if (blocked() || crowded) {
        waited = true
        timer = window.setTimeout(check, pollMs)
        return
      }
      if (waited) {
        waited = false
        timer = window.setTimeout(check, settleMs)
        return
      }
      setPending(false)
      if (!claimStarInvite(browserStorage())) return
      shown.current = true
      showStarInvite(() => {
        if (platform.openExternalLink)
          platform.openExternalLink(starInviteRepositoryUrl)
        else
          window.open(starInviteRepositoryUrl, "_blank", "noopener,noreferrer")
      })
    }
    timer = window.setTimeout(check, afterMergeMs)
    return () => window.clearTimeout(timer)
  }, [isPending, platform])

  React.useEffect(
    () => () => {
      if (shown.current) toast.dismiss(toastId)
    },
    []
  )
  return null
}

function showStarInvite(onStar: () => void) {
  toast.custom(
    (id) => (
      <StarInviteCard onClose={() => toast.dismiss(id)} onStar={onStar} />
    ),
    {
      id: toastId,
      // Alone in the corner, the card rises in place. Over another toast it
      // slides in as toasts do, so the two don't fade into each other.
      className: cn(stackedToast, cornerTaken() ? undefined : riseInPlace),
      duration: Infinity,
      position: "bottom-right",
    }
  )
}

// Behind a newer toast, the card's content steps aside like other toasts' do.
const stackedToast = "data-[expanded=false]:data-[front=false]:*:opacity-0!"
const riseInPlace = "data-[mounted=false]:[--y:translateY(0)]!"
