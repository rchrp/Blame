import { cn } from "@/lib/utils"

// How each source looks on the first screen (logos in ./icons, see NOTICE.md).
// A coloured logo is drawn as it is on a light tile; a single-colour one is
// drawn white on the tool's colour; a tool without a logo shows its initials.
const looks: Record<
  string,
  { logo?: "colour" | "mono"; letters: string; color: string }
> = {
  "claude-desktop": { logo: "colour", letters: "Cl", color: "#d97757" },
  "claude-code": { logo: "colour", letters: "CC", color: "#c4623f" },
  codex: { logo: "colour", letters: "Cx", color: "#10a37f" },
  antigravity: { logo: "colour", letters: "Ag", color: "#4285f4" },
  gemini: { logo: "colour", letters: "Ge", color: "#4285f4" },
  qwen: { logo: "colour", letters: "Qw", color: "#6d28d9" },
  cursor: { logo: "mono", letters: "Cu", color: "#27272a" },
  cline: { logo: "mono", letters: "Cl", color: "#7c3aed" },
  opencode: { logo: "mono", letters: "OC", color: "#2563eb" },
  kilo: { logo: "mono", letters: "Ki", color: "#d97706" },
  roo: { logo: "mono", letters: "Ro", color: "#db2777" },
  goose: { logo: "mono", letters: "Go", color: "#0284c7" },
  zed: { logo: "mono", letters: "Z", color: "#0f766e" },
  vscode: { letters: "VS", color: "#2f80ed" },
  continue: { letters: "Co", color: "#16a34a" },
}

const fallbackColor = "#6b7280"

const logos = import.meta.glob("./icons/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>

function logoUrl(id: string) {
  return logos[`./icons/${id}.svg`]
}

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
  const url = look?.logo ? logoUrl(id) : undefined
  const colour = Boolean(url) && look?.logo === "colour"
  const color = look?.color ?? fallbackColor
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold transition-[filter,opacity,background-color] duration-300",
        !active && "bg-foreground/10 text-foreground/45 grayscale",
        active && (colour ? "bg-white text-foreground" : "text-white"),
        className
      )}
      style={active && !colour ? { backgroundColor: color } : undefined}
    >
      {url ? (
        <img
          alt=""
          className={cn(
            "size-6",
            // Single-colour logos are black: white on the tool's colour,
            // a soft grey when the tool is not found.
            !colour &&
              (active
                ? "brightness-0 invert"
                : "opacity-40 brightness-0 dark:invert")
          )}
          draggable={false}
          src={url}
        />
      ) : (
        (look?.letters ?? label.slice(0, 2))
      )}
    </span>
  )
}
