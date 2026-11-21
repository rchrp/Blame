import { UsersIcon } from "lucide-react"

// A `run_agents` call the engine did not start (ultra mode off for the
// message, a role this conversation cannot serve): said where the work is,
// not folded away with the steps.
export function SubAgentsNotice({ reason }: { reason: string }) {
  return (
    <p
      className="flex min-w-0 items-start gap-2.5 rounded-xl border border-dashed px-3.5 py-2.5 text-sm text-muted-foreground"
      role="status"
    >
      <UsersIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>Helper agents did not start. {reason}</span>
    </p>
  )
}
