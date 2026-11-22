import * as React from "react"
import type { EngineLocation } from "@blame/agent-runtime/engine-protocol"
import { CheckIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"

// A tool call the engine holds until the person decides (a preview deploy,
// a command outside the policy). The timeline shows the call; the decision
// goes back to the engine session that asked.

type Decide = (call: string, decision: "approved" | "denied") => Promise<void>

const ApprovalContext = React.createContext<Decide | undefined>(undefined)
const LocationContext = React.createContext<EngineLocation | undefined>(
  undefined
)

/** Where the conversation's engine is, for what the timeline follows beside it. */
export function useEngineLocation() {
  return React.useContext(LocationContext)
}

export function EngineApprovalProvider({
  children,
  location,
  session,
}: {
  children: React.ReactNode
  location?: EngineLocation
  session: string | null | undefined
}) {
  const engine = usePlatform().engine
  const decide = React.useMemo<Decide | undefined>(
    () =>
      engine && session
        ? async (call, decision) => {
            const applied = await engine.call("resolveApproval", {
              call,
              decision,
              location,
              session,
            })
            if (!applied)
              toast.info("This request was already decided or has ended.", {
                position: "bottom-right",
              })
          }
        : undefined,
    [engine, location, session]
  )
  return (
    <LocationContext.Provider value={location}>
      <ApprovalContext.Provider value={decide}>
        {children}
      </ApprovalContext.Provider>
    </LocationContext.Provider>
  )
}

/** Allow and Deny for one call waiting in the timeline. */
export function ApprovalDecision({
  call,
  neutral = false,
}: {
  call: string
  neutral?: boolean
}) {
  const decide = React.useContext(ApprovalContext)
  const [pending, setPending] = React.useState<"approved" | "denied">()
  if (!decide) return null
  const choose = (decision: "approved" | "denied") => {
    setPending(decision)
    decide(call, decision).catch((error: unknown) => {
      setPending(undefined)
      toast.error("The decision could not be sent", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
    })
  }
  return (
    <span className="flex gap-2 py-1">
      <Button
        disabled={pending !== undefined}
        size="sm"
        type="button"
        className={
          neutral
            ? "bg-foreground text-background hover:bg-foreground/85"
            : undefined
        }
        onClick={() => choose("approved")}
      >
        <CheckIcon />
        Allow
      </Button>
      <Button
        disabled={pending !== undefined}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => choose("denied")}
      >
        <XIcon />
        Deny
      </Button>
    </span>
  )
}
