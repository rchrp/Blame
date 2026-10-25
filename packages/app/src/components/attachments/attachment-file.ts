import type { ComposerAttachment } from "./attachment-types"

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
  const response = await fetch(stored.downloadUrl, {
    signal: signal ?? AbortSignal.timeout(30_000),
    credentials: "omit",
  })
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
  const remote = attachment.storedAttachment?.downloadUrl
  const url = remote ?? URL.createObjectURL(attachment.file)
  link.href = url
  link.download = attachment.file.name
  link.rel = "noopener noreferrer"
  if (remote) link.target = "_blank"
  link.click()
  if (!remote) window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
