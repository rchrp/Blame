import { CheckIcon, MinusIcon, XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

import type { HelperIdentity } from "./helper-identity"
import type { SubAgentStatus } from "./sub-agents-view"

// A helper's face: its pixel-art flower in a circle. How it is doing shows on
// the face and not beside it: a running helper's flower glows, a waiting one
// is dimmed, and a finished one wears a small badge with its own shape (a
// check, a cross, a dash), so colour is never the only signal.
export function HelperAvatar({
  className,
  identity,
  size = 28,
  status,
}: {
  className?: string
  identity: HelperIdentity
  /** Pixels. */
  size?: number
  status?: SubAgentStatus
}) {
  const badge = status && badges[status]
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex shrink-0", className)}
      style={{ height: size, width: size }}
    >
      <img
        alt=""
        className={cn(
          "size-full rounded-full object-cover ring-1 ring-foreground/15 [image-rendering:pixelated]",
          status === "running" && "ring-2 ring-blue-500/60 dark:ring-blue-400/60",
          status === "waiting" && "opacity-45 grayscale"
        )}
        draggable={false}
        src={identity.avatar}
      />
      {badge && size >= 24 ? (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full ring-2 ring-background",
            badge.className
          )}
        >
          <badge.Icon className="size-2.5" strokeWidth={3} />
        </span>
      ) : null}
    </span>
  )
}

/** The first flowers of a group, overlapped: the mark of a set of helpers. */
export function HelperBouquet({
  className,
  identities,
}: {
  className?: string
  identities: readonly HelperIdentity[]
}) {
  return (
    <span aria-hidden="true" className={cn("flex items-center", className)}>
      {identities.slice(0, 3).map((identity, index) => (
        <img
          key={identity.name}
          alt=""
          className={cn(
            "size-3.5 rounded-full object-cover ring-2 ring-background [image-rendering:pixelated]",
            index > 0 && "-ml-1.5"
          )}
          draggable={false}
          src={identity.avatar}
        />
      ))}
    </span>
  )
}

const badges: Partial<
  Record<SubAgentStatus, { Icon: typeof CheckIcon; className: string }>
> = {
  done: { Icon: CheckIcon, className: "bg-emerald-500 text-white" },
  failed: { Icon: XIcon, className: "bg-destructive text-white" },
  cancelled: {
    Icon: MinusIcon,
    className: "bg-muted-foreground text-background",
  },
}
