// A helper has no persona: its prompt is its role's and nothing else. It does
// get a face and a name so that the person can tell the helpers of a call
// apart and follow one from the conversation to the stats panel: a pixel-art
// flower and the flower's name, given by the call, so the same call shows the
// same helpers after a reload.

export type HelperIdentity = {
  name: string
  /** The 32 px pixel-art flower, bundled with the app. */
  avatar: string
}

// Bundled (not served from the public folder): the renderer runs from
// file:// and its address changes with the page, so a relative URL would not
// find them.
const flower = (file: string) =>
  new URL(`../../../assets/helpers/${file}`, import.meta.url).href

export const helperIdentities: readonly HelperIdentity[] = [
  { name: "Cornflower", avatar: flower("cornflower.png") },
  { name: "Fuchsia", avatar: flower("fuchsia.png") },
  { name: "Marigold", avatar: flower("marigold.png") },
  { name: "Iris", avatar: flower("iris.png") },
  { name: "Clover", avatar: flower("clover.png") },
]

/**
 * The identity of the helper at `index` of `call`: the call picks where to
 * start in the list, the index walks on from there, so the (at most four)
 * helpers of a call are never alike.
 */
export function helperIdentity(call: string, index: number): HelperIdentity {
  let hash = 2166136261
  for (let position = 0; position < call.length; position += 1) {
    hash = Math.imul(hash ^ call.charCodeAt(position), 16777619)
  }
  const start = (hash >>> 0) % helperIdentities.length
  return helperIdentities[(start + index) % helperIdentities.length]!
}
