import { LightbulbIcon, SlidersHorizontalIcon } from "lucide-react"
import type { NewProjectMode } from "./new-project-flow"

const modes = [
  {
    mode: "ai",
    title: "Let AI choose for you",
    description:
      "Describe what you want to build. Your agent asks questions, then chooses a stack for you to review.",
    icon: LightbulbIcon,
  },
  {
    mode: "manual",
    title: "Choose manually",
    description:
      "Pick your framework, styling, database and tools, one step at a time.",
    icon: SlidersHorizontalIcon,
  },
] as const

export function NewProjectModeOptions({
  onChooseMode,
}: {
  onChooseMode: (mode: NewProjectMode) => void
}) {
  return (
    <div className="grid gap-3">
      {modes.map(({ mode, title, description, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          data-mode={mode}
          className="project-mode-option relative flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={() => onChooseMode(mode)}
        >
          <span
            aria-hidden="true"
            className="project-mode-border pointer-events-none absolute -inset-px rounded-[inherit]"
          >
            <span className="story-status-corner story-status-corner-glow" />
            <span className="story-status-corner" />
          </span>
          <Icon
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          />
          <span className="grid min-w-0 gap-1.5">
            <span className="text-sm font-semibold">{title}</span>
            <span className="text-sm text-muted-foreground">{description}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
