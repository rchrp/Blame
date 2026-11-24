import { CheckIcon } from "lucide-react"

import { ProviderIcon } from "@/components/model/model-selector"
import { cn } from "@/lib/utils"

export function EpicProviderField({
  connected,
  value,
  onChange,
}: {
  connected: { id: string; name: string }[]
  value: string[]
  onChange: (providers: string[]) => void
}) {
  // Keep a saved provider removable even if its credential was disconnected.
  const options = [
    { id: "", name: "Any provider" },
    ...connected,
    ...value
      .filter((id) => !connected.some((item) => item.id === id))
      .map((id) => ({ id, name: id })),
  ]
  return (
    <div
      aria-label="Story providers"
      role="group"
      className="flex flex-wrap gap-1.5"
    >
      {options.map(({ id, name }) => {
        const selected = id ? value.includes(id) : value.length === 0
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            className={cn(
              "inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-foreground/12 bg-foreground/6 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            )}
            onClick={() =>
              onChange(
                !id
                  ? []
                  : selected
                    ? value.filter((item) => item !== id)
                    : [...value, id]
              )
            }
          >
            {selected ? (
              <CheckIcon aria-hidden="true" className="size-3" />
            ) : null}
            {id ? <ProviderIcon providerId={id} /> : null}
            {name}
          </button>
        )
      })}
    </div>
  )
}
