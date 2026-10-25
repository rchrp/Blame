import type FileAttachment from '#models/file_attachment'

export type FileAttachmentReference = {
  id: string
  content?: string
  downloadUrl?: string
  name: string
  size: number
  type: string
}

export function fileAttachmentReference(attachment: FileAttachment): FileAttachmentReference {
  return {
    ...(attachment.downloadUrl ? { downloadUrl: attachment.downloadUrl } : {}),
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    type: attachment.mimeType,
  }
}

export function orderedFileAttachments(attachments: FileAttachment[]) {
  return attachments
    .toSorted((left, right) => pivotPosition(left) - pivotPosition(right))
    .map(fileAttachmentReference)
}

function pivotPosition(attachment: FileAttachment) {
  return Number(attachment.$extras.pivot_position ?? 0)
}
