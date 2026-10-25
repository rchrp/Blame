import {
  advancedOptionLabels,
  newProjectConfigurationChoices,
  optionLabel,
  type NewProjectConfiguration,
} from "./new-project-options"
import { cn } from "@/lib/utils"

const labels = {
  platform: "Platform",
  frontend: "Frontend",
  styling: "Styling",
  uiLibrary: "UI library",
  backend: "Backend",
  database: "Database",
  orm: "ORM",
  packageManager: "Package manager",
  codeQuality: "Code quality",
} as const

/** Both paths review exactly the same stack, including advanced options. */
export function NewProjectSummary({
  configuration,
  path,
}: {
  configuration: NewProjectConfiguration
  path?: string
}) {
  const choices = newProjectConfigurationChoices(configuration)
  const items = [
    ...(path ? [{ label: "Path", value: path }] : []),
    ...Object.entries(choices).map(([key, options]) => ({
      label: labels[key as keyof typeof labels],
      value: optionLabel(options, configuration[key as keyof typeof choices]),
    })),
    {
      label: "Advanced options",
      value:
        configuration.advancedOptions
          .map((option) => advancedOptionLabels[option])
          .join(", ") || "None",
    },
  ]
  return (
    <dl className="grid min-w-0 gap-x-8 sm:grid-cols-2">
      {items.map((item) => (
        <div
          key={item.label}
          className={cn(
            "min-w-0 border-b py-3",
            (item.label === "Path" || item.label === "Advanced options") &&
              "sm:col-span-2"
          )}
        >
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 text-sm font-medium break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
