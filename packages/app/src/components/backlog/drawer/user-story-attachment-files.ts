import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"

export async function fileAttachment(
  file: File,
  aiContextMarkdown?: string
): Promise<UserStoryFileAttachment & { content: string }> {
  return {
    ...(aiContextMarkdown ? { aiContextMarkdown } : {}),
    content: await fileContent(file),
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type,
  }
}

export function pendingFileAttachments(attachments: UserStoryFileAttachment[]) {
  return attachments.map((attachment) => ({
    aiContextMarkdown: attachment.aiContextMarkdown,
    file: fileFromAttachment(attachment),
    id: attachment.id,
    previewUrl: attachment.type.startsWith("image/")
      ? attachment.downloadUrl
      : undefined,
    storedAttachment: attachment.content === undefined ? attachment : undefined,
  }))
}

function fileFromAttachment(attachment: UserStoryFileAttachment) {
  if (attachment.content === undefined) {
    return new File([], attachment.name, { type: attachment.type })
  }
  const binary = atob(attachment.content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new File([bytes], attachment.name, { type: attachment.type })
}

function fileContent(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      resolve(value.split(",", 2)[1] ?? "")
    })
    reader.addEventListener("error", () => reject(reader.error))
    reader.readAsDataURL(file)
  })
}

export type FileAttachmentReplacement = {
  id: string
  attachment: UserStoryFileAttachment
}

// Edited uploads have new IDs: stored attachment objects are immutable.
export function replaceFileAttachments(
  current: UserStoryFileAttachment[],
  replacements: FileAttachmentReplacement[]
) {
  const byId = new Map(
    replacements.map(({ id, attachment }) => [id, attachment])
  )
  return current.map((attachment) => byId.get(attachment.id) ?? attachment)
}
