import { screenshotRefs } from "../tool-calls/describe-preview-devtools.ts"
import type { ScreenshotRef } from "../tool-calls/tool-call-view.ts"

export type ScreenshotItem = {
  caption?: string
  id: string
  ref?: ScreenshotRef
  blob?: boolean
}

type ScreenshotActivity = {
  kind: string
  detail: string
  images?: ReadonlyArray<{ id: string; caption: string }>
}

// Tool results can be saved as desktop references or replicated engine blobs.
export function screenshotItemsFromActivities(
  activities: readonly ScreenshotActivity[]
) {
  const items = new Map<string, ScreenshotItem>()
  for (const activity of activities) {
    if (activity.kind !== "tool") continue
    if (activity.detail.includes("screenshot_ref")) {
      try {
        for (const ref of screenshotRefs(JSON.parse(activity.detail))) {
          items.set(ref.id, { ...items.get(ref.id), id: ref.id, ref })
        }
      } catch {
        // Older tool detail can be truncated; use any engine images instead.
      }
    }
    for (const image of activity.images ?? []) {
      if (!/^[0-9a-f]{64}$/u.test(image.id)) continue
      items.set(image.id, { ...items.get(image.id), ...image, blob: true })
    }
  }
  return [...items.values()]
}
