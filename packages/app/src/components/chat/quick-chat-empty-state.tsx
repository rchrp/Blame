import {
  BugIcon,
  CompassIcon,
  FlaskConicalIcon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react"

const suggestions = [
  {
    icon: CompassIcon,
    label: "Explain this project",
    prompt: "Give me a quick tour of this project: its structure, main modules and how they fit together.",
  },
  {
    icon: BugIcon,
    label: "Hunt a bug",
    prompt: "Help me find and fix a bug: ",
  },
  {
    icon: FlaskConicalIcon,
    label: "Add tests",
    prompt: "Add focused tests for ",
  },
  {
    icon: SparklesIcon,
    label: "Polish the UI",
    prompt: "Polish the UI of ",
  },
] as const

export function QuickChatEmptyState({
  onSuggestion,
}: {
  onSuggestion?: (prompt: string) => void
}) {
  return (
    <div className="onboarding-stagger grid place-items-center gap-5 pb-6">
      <span className="flex size-12 items-center justify-center rounded-2xl border bg-muted text-muted-foreground shadow-sm">
        <WrenchIcon className="size-5" />
      </span>
      <div className="grid max-w-md gap-1 text-center">
        <h2 className="font-heading text-xl font-semibold">
          What would you like to adjust?
        </h2>
        <p className="text-sm text-muted-foreground">
          Fix a bug, tweak a detail, or ask about your code. Chat is for
          focused changes; use the backlog to plan larger features.
        </p>
      </div>
      {onSuggestion ? (
        <div className="flex flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              className="group inline-flex h-8 items-center gap-1.5 rounded-full border bg-background/60 px-3 text-xs font-medium text-muted-foreground shadow-xs outline-none transition-[transform,color,background-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-background hover:text-foreground hover:shadow-sm focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:translate-y-0 active:scale-[0.98]"
              onClick={() => onSuggestion(suggestion.prompt)}
            >
              <suggestion.icon className="size-3.5 transition-colors group-hover:text-primary" />
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
