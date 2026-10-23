// Whether the previewed app refreshes the open page by itself when its
// files change. Frameworks with a hot reload client (Next.js, Vite, Nuxt...)
// do; server frameworks (Django, Rails, Flask, PHP, Express...) restart or
// re-render on the next request but leave the page as it was. Undefined when
// the stack is unknown, so callers do not reload on a guess.

const hotReloadStacks = new Set([
  "angular",
  "astro",
  "ember",
  "expo",
  "gatsby",
  "next",
  "nuxt",
  "parcel",
  "preact",
  "qwik",
  "react",
  "react-router",
  "remix",
  "solid",
  "solid-start",
  "storybook",
  "svelte",
  "sveltekit",
  "vite",
  "vue",
  "webpack",
])

export function previewHotReloads(stack: readonly string[] | undefined) {
  if (!stack?.length) return undefined
  return stack.some((entry) => hotReloadStacks.has(stackName(entry)))
}

function stackName(entry: string) {
  return entry
    .trim()
    .toLowerCase()
    .replace(/\.?js$/, "")
    .replace(/\s+/g, "-")
}
