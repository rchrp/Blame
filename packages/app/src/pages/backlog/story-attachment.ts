import type { ApiConnection } from "@blame/agent-runtime"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import { fetchFileAttachment } from "@/lib/file-attachment-api"

/**
 * The bytes of a stored attachment (base64), for the engine: the API signs
 * a fresh download link, which needs the token only on the API itself.
 */
export async function readStoryAttachment(
  connection: ApiConnection,
  file: UserStoryFileAttachment
): Promise<string | undefined> {
  const stored = await fetchFileAttachment(connection, file.id)
  const url = stored.downloadUrl
  if (!url) return undefined
  const sameApi = url.startsWith(connection.url.replace(/\/api\/v1\/?$/, ""))
  const response = await fetch(url, {
    headers:
      sameApi && connection.token
        ? { Authorization: `Bearer ${connection.token}` }
        : {},
  })
  if (!response.ok)
    throw new Error(`${file.name} could not be read (${response.status}).`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
