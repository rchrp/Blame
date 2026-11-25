import * as React from "react"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import type { PendingFileAttachment } from "@/components/backlog/drawer/markdown-editor"
import { pendingFileAttachments } from "@/components/backlog/drawer/user-story-attachment-files"
import { useCloudAuth } from "@/context/cloud-auth"

import { readEngineImage } from "./engine-image"

type EngineImage = UserStoryFileAttachment & { blobId: string }

function isEngineImage(
  attachment: UserStoryFileAttachment
): attachment is EngineImage {
  return attachment.blobId !== undefined && attachment.type.startsWith("image/")
}

/**
 * The files of a message the engine holds. Its images are blobs that need the
 * API token, so each card gets a link made from the fetched bytes; a card
 * waits for its image, and falls back to a plain file if it cannot be read.
 */
export function useEngineFileAttachments(
  attachments: UserStoryFileAttachment[]
): PendingFileAttachment[] {
  const { apiConnection } = useCloudAuth()
  const [sources, setSources] = React.useState<
    ReadonlyMap<string, string | null>
  >(new Map())
  const blobIds = attachments.filter(isEngineImage).map((image) => image.blobId)
  const blobKey = blobIds.join(",")
  React.useEffect(() => {
    const controller = new AbortController()
    const created: string[] = []
    for (const id of blobKey ? blobKey.split(",") : []) {
      void readEngineImage(apiConnection, id, controller.signal)
        .catch(() => null)
        .then((blob) => {
          if (controller.signal.aborted) return
          const source = blob ? URL.createObjectURL(blob) : null
          if (source) created.push(source)
          setSources((current) => new Map(current).set(id, source))
        })
    }
    return () => {
      controller.abort()
      created.forEach((source) => URL.revokeObjectURL(source))
    }
  }, [apiConnection, blobKey])

  return React.useMemo(
    () =>
      attachments.flatMap((attachment) => {
        const [pending] = pendingFileAttachments([attachment])
        if (!isEngineImage(attachment)) return [pending]
        const source = sources.get(attachment.blobId)
        if (source === undefined) return []
        return [
          source
            ? { ...pending, previewUrl: source }
            : { ...pending, file: new File([], attachment.name) },
        ]
      }),
    [attachments, sources]
  )
}
