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

/**
 * Where a screenshot is read from. An engine image comes from the account,
 * and when the account lacks it (a merged story's session leaves this
 * computer, its images with it, before they may have been copied), from
 * this device's agent screenshots: both are named by the image's sha256.
 */
export function screenshotStore(
  item: Pick<ScreenshotItem, "blob"> | undefined,
  engine: "loading" | "ready" | "unavailable"
): "engine" | "device" {
  return item?.blob && engine !== "unavailable" ? "engine" : "device"
}
