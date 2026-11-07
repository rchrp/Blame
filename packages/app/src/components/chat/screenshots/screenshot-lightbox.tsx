import * as React from "react"

import {
  ImageAttachmentGallery,
  type GalleryImage,
} from "@/components/attachments/image-attachment-gallery"
import { usePlatform, type AgentScreenshotsClient } from "@/context/platform"

import {
  useAgentScreenshot,
  type ScreenshotItem,
  type ScreenshotState,
} from "./agent-screenshot-context"

// The agent's screenshots in the shared image viewer, without annotation.
// Only the open screenshot is loaded; the others load when browsed to.
export function ScreenshotLightbox({
  index,
  items,
  onClose,
  onIndexChange,
  returnFocus,
}: {
  index: number
  items: ScreenshotItem[]
  onClose: () => void
  onIndexChange: (index: number) => void
  // The control that opened the lightbox: it gets the focus back.
  returnFocus?: HTMLElement | null
}) {
  const client = usePlatform().agentScreenshots
  const current = items[Math.min(Math.max(index, 0), items.length - 1)]
  const state = useAgentScreenshot(current)
  const images = React.useMemo(
    () =>
      items.map((item) =>
        galleryImage(
          item,
          item.id === current?.id ? state : { status: "loading" },
          client
        )
      ),
    [client, current?.id, items, state]
  )
  if (!current) return null
  return (
    <ImageAttachmentGallery
      images={images}
      initialId={current.id}
      onClose={onClose}
      onIndexChange={onIndexChange}
      onRestoreFocus={() => {
        if (returnFocus?.isConnected) returnFocus.focus()
      }}
    />
  )
}

function galleryImage(
  item: ScreenshotItem,
  state: ScreenshotState,
  client: AgentScreenshotsClient | undefined
): GalleryImage {
  const metadata = state.status === "ready" ? state.data.metadata : undefined
  const pageUrl = item.ref?.pageUrl || metadata?.pageUrl
  return {
    id: item.id,
    name: item.caption ?? (pageUrl ? `Screenshot of ${pageUrl}` : "Screenshot"),
    source: state.status === "ready" ? state.data.dataUrl : "",
    status: state.status === "ready" ? undefined : state.status,
    details: {
      caption: item.caption ?? pageUrl,
      colorScheme: item.ref?.colorScheme ?? metadata?.colorScheme,
      viewport: item.ref?.viewport ?? metadata?.viewport,
    },
    actions: client && {
      copy: () => client.copy({ id: item.id }),
      saveAs: () => client.saveAs({ id: item.id }),
    },
  }
}
