// A short burst of confetti for moments worth marking (a story merged).
// Plain DOM and the Web Animations API: nothing stays mounted afterwards,
// and nothing runs when the user prefers reduced motion.

const colors = [
  "oklch(0.72 0.19 250)",
  "oklch(0.78 0.17 160)",
  "oklch(0.83 0.16 85)",
  "oklch(0.7 0.2 20)",
  "oklch(0.72 0.18 300)",
]

export function celebrate(origin?: Element | null, pieces = 36) {
  if (typeof window === "undefined") return
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
  const rect = origin?.getBoundingClientRect()
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 200
  const y = rect ? rect.top + rect.height / 3 : window.innerHeight - 80

  const layer = document.createElement("div")
  layer.setAttribute("aria-hidden", "true")
  Object.assign(layer.style, {
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    position: "fixed",
    zIndex: "100",
  })
  document.body.append(layer)

  const animations = Array.from({ length: pieces }, (_, index) => {
    const piece = document.createElement("span")
    const size = 5 + Math.random() * 5
    Object.assign(piece.style, {
      background: colors[index % colors.length],
      borderRadius: index % 3 === 0 ? "999px" : "2px",
      height: `${index % 3 === 0 ? size : size * 0.45}px`,
      left: `${x}px`,
      position: "absolute",
      top: `${y}px`,
      width: `${size}px`,
    })
    layer.append(piece)
    // Mostly upward, fanned out, then falling with gravity.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9
    const speed = 140 + Math.random() * 200
    const dx = Math.cos(angle) * speed
    const dy = Math.sin(angle) * speed
    const spin = (Math.random() - 0.5) * 720
    return piece.animate(
      [
        { opacity: 1, transform: "translate(0, 0) rotate(0deg) scale(0.6)" },
        {
          offset: 0.35,
          opacity: 1,
          transform: `translate(${dx * 0.8}px, ${dy * 0.8}px) rotate(${spin * 0.4}deg) scale(1)`,
        },
        {
          opacity: 0,
          transform: `translate(${dx}px, ${dy + 260}px) rotate(${spin}deg) scale(0.9)`,
        },
      ],
      {
        delay: Math.random() * 80,
        duration: 1100 + Math.random() * 500,
        easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
        fill: "forwards",
      }
    ).finished
  })
  void Promise.allSettled(animations).then(() => layer.remove())
}

// Celebrates from the story's card on the board when it is visible.
export function celebrateStory(storyId: string) {
  celebrate(document.querySelector(`[data-story-id="${CSS.escape(storyId)}"]`))
}
