import { ArrowRightIcon } from "lucide-react"

import { containerAnchor, CornerLight, KindIcon } from "./environment-kinds"
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
      className="relative inline-flex items-center gap-2 rounded-lg border bg-background/70 px-2.5 py-1.5 text-sm font-medium transition-colors outline-none hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <CornerLight tone={kind} width="70%" height="140%" />
      <KindIcon kind={kind} image={image} className="size-3.5" />
      {node.id}
      {preview && node.port ? (
        <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
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
