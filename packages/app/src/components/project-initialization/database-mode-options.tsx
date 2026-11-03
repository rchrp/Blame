import {
  CheckIcon,
  ChevronRightIcon,
  DatabaseIcon,
  ServerIcon,
} from "lucide-react"
import type { ProjectInitializationDatabaseMode } from "@blame/agent-runtime"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// The one database choice a project makes for its previews, worded the same
// in the initialization dialog and on the Preview Environment page.

export const databaseModeOptions: Array<{
  mode: ProjectInitializationDatabaseMode
  title: string
  detail: string
}> = [
  {
    mode: "compose",
    title: "Isolated database (Blame)",
    detail:
      "Each preview gets its own fresh database. Your data is never touched.",
  },
  {
    mode: "existing",
    title: "Your database: DATABASE_URL from .env",
    detail:
      "Previews connect to the database your env files configure. A database on this computer is reached from the preview.",
  },
]

export function databaseModeTitle(mode: ProjectInitializationDatabaseMode) {
  return databaseModeOptions.find((option) => option.mode === mode)!.title
}

export function DatabaseModeOptions({
  current,
  onSelect,
}: {
  current?: ProjectInitializationDatabaseMode | null
  onSelect(mode: ProjectInitializationDatabaseMode): void
}) {
  return (
    <div className="grid gap-2">
      {databaseModeOptions.map((option) => {
        const Icon = option.mode === "compose" ? DatabaseIcon : ServerIcon
        const selected = option.mode === current
        return (
          <Button
            key={option.mode}
            type="button"
            variant="outline"
            aria-pressed={selected}
            className={cn(
              "h-auto justify-start gap-3 px-3 py-3 text-left whitespace-normal",
              selected && "border-primary/60"
            )}
            onClick={() => onSelect(option.mode)}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="font-medium">{option.title}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {option.detail}
              </span>
            </span>
            {selected ? (
              <CheckIcon className="size-4 shrink-0 text-primary" />
            ) : (
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
          </Button>
        )
      })}
    </div>
  )
}

/** The evidence that made Blame ask, in one sentence. */
export function databaseEvidenceSentence(evidence: string[] | undefined) {
  if (!evidence?.length)
    return "This project already has database configuration in its environment."
  const shown = evidence.slice(0, 3)
  const more = evidence.length - shown.length
  return `Blame found ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`
}
