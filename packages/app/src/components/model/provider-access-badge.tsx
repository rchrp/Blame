import { KeyRoundIcon, TerminalIcon } from "lucide-react"
import type * as React from "react"

import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type ProviderAccess = {
  className: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  title: string
  pros: string[]
  cons?: string[]
  note?: string
}

const providerAccess: Record<string, ProviderAccess> = {
  "openai-codex": {
    // The electric blue of Cloud Previews.
    className:
      "border-sky-500/35 bg-sky-500/8 text-sky-600 shadow-[0_0_8px_oklch(0.65_0.2_250_/_0.15)] dark:text-sky-300",
    icon: KeyRoundIcon,
    label: "OAuth",
    title: "Sign in with your ChatGPT account",
    pros: [
      "Uses your Plus or Pro plan instead of API credits.",
      "No API key to create or paste.",
      "Blame keeps the sign-in fresh for you.",
    ],
  },
  "claude-code": {
    // Anthropic's brand orange.
    className: "border-[#D97757]/40 bg-[#D97757]/10 text-[#C4623F] dark:text-[#E08A6C]",
    icon: TerminalIcon,
    label: "Local CLI",
    title: "Runs through Claude Code on this computer",
    pros: [
      "Uses your Pro or Max plan instead of API credits.",
      "Blame keeps its own tools, approvals and checks.",
    ],
    cons: [
      "Claude Code must be installed and signed in here.",
      "Each conversation starts a Claude Code process.",
      "Not yet available for stories in the Windows runtime.",
    ],
    note: "Anthropic doesn't let other apps sign in to Claude accounts, so Blame goes through Claude Code, Anthropic's own tool.",
  },
}

/** Shows how a subscription provider connects, with its trade-offs on hover. */
export function ProviderAccessBadge({ providerID }: { providerID: string }) {
  const access = providerAccess[providerID]
  if (!access) return null
  const Icon = access.icon

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={access.className}>
            <Icon />
            {access.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          sideOffset={6}
          className="flex max-w-72 flex-col items-start gap-2 px-3 py-2.5 text-left"
        >
          <p className="font-medium">{access.title}</p>
          <AccessList label="Pros" items={access.pros} />
          {access.cons ? <AccessList label="Cons" items={access.cons} /> : null}
          {access.note ? <p className="text-background/70">{access.note}</p> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function AccessList({ items, label }: { items: string[]; label: string }) {
  return (
    <div className="grid gap-1">
      <p className="text-[0.6875rem] font-semibold tracking-wide text-background/60 uppercase">
        {label}
      </p>
      <ul className="grid gap-0.5">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5">
            <span aria-hidden="true" className="text-background/50">
              ·
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
