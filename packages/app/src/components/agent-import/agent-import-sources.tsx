import { ProviderIcon } from "@/components/model/model-selector"
import { cn } from "@/lib/utils"

// How each source looks on the first screen. A source with a logo in the
// provider sprite uses it; the others show their initials.
const looks: Record<
  string,
  { provider?: string; letters: string; color: string }
> = {
  "claude-desktop": { provider: "anthropic", letters: "Cl", color: "#d97757" },
  "claude-code": { provider: "anthropic", letters: "CC", color: "#c4623f" },
  codex: { provider: "openai", letters: "Cx", color: "#10a37f" },
  cursor: { letters: "Cu", color: "#4b5563" },
  vscode: { letters: "VS", color: "#2f80ed" },
  opencode: { provider: "opencode", letters: "OC", color: "#3b82f6" },
  cline: { letters: "Cl", color: "#8b5cf6" },
  kilo: { provider: "kilo", letters: "Ki", color: "#f59e0b" },
  roo: { letters: "Ro", color: "#ec4899" },
  gemini: { provider: "google", letters: "Ge", color: "#4285f4" },
  qwen: { letters: "Qw", color: "#6d28d9" },
  goose: { letters: "Go", color: "#0ea5e9" },
  continue: { letters: "Co", color: "#16a34a" },
  zed: { letters: "Z", color: "#0f766e" },
}

const fallbackColor = "#6b7280"

export function AgentImportSourceIcon({
  id,
  label,
  active,
  className,
}: {
  id: string
  label: string
  /** In colour; otherwise grey. */
  active: boolean
  className?: string
}) {
  const look = looks[id]
  const color = look?.color ?? fallbackColor
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold transition-[filter,opacity,background-color] duration-300",
        active ? "text-white" : "bg-foreground/10 text-foreground/45 grayscale",
        className
      )}
      style={active ? { backgroundColor: color } : undefined}
    >
      {look?.provider ? (
        <ProviderIcon className="size-6" providerId={look.provider} />
      ) : (
        (look?.letters ?? label.slice(0, 2))
      )}
    </span>
  )
}
