import { ArrowRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { containerAnchor, KindTile } from "./environment-kinds"
import { startOrder, type StartNode } from "./environment-start-order"
import type { SavedSetup } from "./initialization-setup-draft"

// The order a story's preview starts its containers, ending on the one the
// preview opens. Each step points at its card further down.

export function EnvironmentStartChain({ setup }: { setup: SavedSetup }) {
  const steps = startOrder(setup)
  if (!steps.length) return null
  const images = new Map(
    [...setup.previewManifest.services, ...setup.previewManifest.setup].map(
      (item) => [item.id, item.container.image]
    )
  )
  return (
    <ol
      aria-label="Start order"
      className="flex flex-wrap items-center gap-x-2 gap-y-2.5"
    >
      {steps.map((step, index) => (
        <li
          key={step.map(({ id }) => id).join()}
          className="flex items-center gap-2"
        >
          {index ? (
            <ArrowRightIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground/60"
            />
          ) : null}
          <div className="flex flex-col items-start gap-1.5">
            {step.map((node) => (
              <ChainNode
                key={`${node.type}-${node.id}`}
                node={node}
                image={images.get(node.id)}
              />
            ))}
          </div>
        </li>
      ))}
    </ol>
  )
}

function ChainNode({ image, node }: { image?: string; node: StartNode }) {
  const preview = node.type === "service" && node.kind === "preview"
  const kind = node.type === "task" ? "task" : node.kind
  return (
    <button
      type="button"
      onClick={() => pointAt(containerAnchor(node.type, node.id))}
      aria-label={
        preview && node.port
          ? `${node.id}, preview on port ${node.port}`
          : node.id
      }
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border bg-background/70 py-1 pr-2.5 pl-1 text-sm font-medium transition-colors outline-none hover:border-foreground/25 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50",
        preview &&
          "border-blue-500/45 shadow-[0_0_0_1px_oklch(0.7_0.17_250/25%),0_0_14px_oklch(0.65_0.2_250/32%)] hover:border-blue-500/70"
      )}
    >
      <KindTile kind={kind} image={image} size="sm" />
      {node.id}
      {preview && node.port ? (
        <span className="font-mono text-xs font-normal text-blue-700 tabular-nums dark:text-blue-300">
          :{node.port}
        </span>
      ) : null}
    </button>
  )
}

/** Scrolls to a card and marks it for a moment, so the eye lands on it. */
function pointAt(anchor: string) {
  const card = document.getElementById(anchor)
  if (!card) return
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  card.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" })
  card.focus({ preventScroll: true })
  card.setAttribute("data-pointed", "")
  window.setTimeout(() => card.removeAttribute("data-pointed"), 1400)
}
