import type { ComposerAttachment } from "./attachment-types"
import {
  freshDownloadUrl,
  renewRefusedDownloadUrl,
} from "./stored-attachment-url.ts"

// Persisted attachments use an empty File placeholder; always read their original URL.
export async function readAttachmentFile(
  attachment: ComposerAttachment,
  maxBytes = 100 * 1024 * 1024,
  signal?: AbortSignal
) {
  const stored = attachment.storedAttachment
  if (!stored) {
    if (attachment.file.size > maxBytes)
      throw new Error(
        "This file is too large to preview. Download the original instead."
      )
    return attachment.file
  }
  if (!stored.downloadUrl)
    throw new Error(
      "The original file is unavailable. Attach it again to preview it."
    )
  if (stored.size > maxBytes)
    throw new Error(
      "This file is too large to preview. Download the original instead."
    )
  const timeout = signal ?? AbortSignal.timeout(30_000)
  const url = (await freshDownloadUrl(stored)) ?? stored.downloadUrl
  let response = await fetchOriginal(url, timeout)
  if (!response.ok) {
    const renewed = await renewRefusedDownloadUrl(stored, url)
    if (renewed) response = await fetchOriginal(renewed, timeout)
  }
  if (!response.ok || !response.body)
    throw new Error(
      "Unable to load this file. Check your connection and try again."
    )
  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes)
        throw new Error(
          "This file is too large to preview. Download the original instead."
        )
      chunks.push(new Uint8Array(value))
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  return new File(chunks, stored.name, { type: stored.type })
}

export async function downloadAttachment(attachment: ComposerAttachment) {
  const link = document.createElement("a")
  const stored = attachment.storedAttachment
  const remote = stored ? await freshDownloadUrl(stored) : undefined
  const url = remote ?? URL.createObjectURL(attachment.file)
  link.href = url
  link.download = attachment.file.name
  link.rel = "noopener noreferrer"
  if (remote) link.target = "_blank"
  link.click()
  if (!remote) window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function fetchOriginal(url: string, signal: AbortSignal) {
  return fetch(url, { signal, credentials: "omit" })
}
