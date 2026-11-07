import { useCallback, useEffect, useSyncExternalStore } from "react"
import type { ComposerAttachment } from "./attachment-types"
import {
  attachmentImageUrl,
  downloadUrlExpired,
  freshDownloadUrl,
  renewableImage,
  renewRefusedDownloadUrl,
  subscribeStoredAttachmentUrls,
} from "./stored-attachment-url"

/** An image card's link, renewed when it expires or fails to load. */
export function useAttachmentImageUrl(attachment: ComposerAttachment) {
  const url = useSyncExternalStore(subscribeStoredAttachmentUrls, () =>
    attachmentImageUrl(attachment)
  )
  const stored = renewableImage(attachment)
  useEffect(() => {
    if (stored && url && downloadUrlExpired(url)) void freshDownloadUrl(stored)
  }, [stored, url])
  const onError = useCallback(() => {
    if (stored && url) void renewRefusedDownloadUrl(stored, url)
  }, [stored, url])
  return { url, onError }
}
