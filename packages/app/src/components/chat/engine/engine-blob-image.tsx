import * as React from "react"

import type { UserStoryAgentActivity } from "@/components/backlog/data/backlog-data"
import { useCloudAuth } from "@/context/cloud-auth"
import type { ApiConnection } from "@blame/agent-runtime"

// The images a tool answered with (screenshots), read from the engine's
// blobs in the user's account: the engine replicates each one there, so
// a conversation shows them on any computer.

const loaded = new Map<string, Promise<string | undefined>>()

function blobUrl(connection: ApiConnection, sha256: string) {
  const key = `${connection.url}\0${sha256}`
  let known = loaded.get(key)
  if (!known) {
    known = fetch(`${connection.url}/engine/blobs/${sha256}`, {
      headers: connection.token
        ? { Authorization: `Bearer ${connection.token}` }
        : {},
    })
      .then(async (response) => {
        if (!response.ok) return undefined
        const type =
          response.headers.get("x-blob-media-type") ??
          "application/octet-stream"
        const bytes = await response.arrayBuffer()
        return URL.createObjectURL(new Blob([bytes], { type }))
      })
      .catch(() => undefined)
    // A blob not replicated yet is asked for again next time.
    void known.then((url) => {
      if (!url) loaded.delete(key)
    })
    loaded.set(key, known)
  }
  return known
}

function EngineBlobImage({
  caption,
  sha256,
}: {
  caption: string
  sha256: string
}) {
  const { apiConnection } = useCloudAuth()
  const [url, setUrl] = React.useState<string>()
  React.useEffect(() => {
    let current = true
    void blobUrl(apiConnection, sha256).then((value) => {
      if (current) setUrl(value)
    })
    return () => {
      current = false
    }
  }, [apiConnection, sha256])
  if (!url)
    return (
      <span className="flex h-24 w-36 items-center justify-center rounded-md border text-xs text-muted-foreground">
        Image loading…
      </span>
    )
  return (
    <img
      alt={caption}
      className="max-h-64 max-w-full rounded-md border object-contain"
      src={url}
    />
  )
}

export function EngineToolImages({
  images,
}: {
  images: NonNullable<UserStoryAgentActivity["images"]>
}) {
  return (
    <span className="flex flex-wrap gap-2 py-1">
      {images.map((image, index) => (
        <EngineBlobImage
          key={`${image.id}-${index}`}
          caption={image.caption}
          sha256={image.id}
        />
      ))}
    </span>
  )
}
