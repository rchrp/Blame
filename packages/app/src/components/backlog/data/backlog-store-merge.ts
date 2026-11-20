import type { UserStory, UserStoryFileAttachment } from "./backlog-data.ts"

export function mergeLoadedStories(
  currentStories: UserStory[],
  loadedStories: UserStory[]
) {
  const currentById = new Map(currentStories.map((story) => [story.id, story]))
  return loadedStories.map((story) => {
    const currentStory = currentById.get(story.id)
    return currentStory ? mergeUserStory(currentStory, story) : story
  })
}

export function mergeUserStory(
  currentStory: UserStory,
  serverStory: UserStory
) {
  const newestStory = newestValue(currentStory, serverStory)
  return {
    ...newestStory,
    codeSelectionAttachments: providedValue(
      newestStory.codeSelectionAttachments,
      currentStory.codeSelectionAttachments
    ),
    fileAttachments: preserveLocalAttachmentContent(
      currentStory.fileAttachments,
      providedValue(newestStory.fileAttachments, currentStory.fileAttachments)
    ),
    ...localAttachmentUpload(currentStory),
  }
}

function localAttachmentUpload(story: UserStory): Partial<UserStory> {
  if (!story.fileAttachmentUploadStatus) return {}
  return {
    fileAttachments: story.fileAttachments,
    fileAttachmentUploadError: story.fileAttachmentUploadError,
    fileAttachmentUploadStatus: story.fileAttachmentUploadStatus,
  }
}

function preserveLocalAttachmentContent(
  currentAttachments: UserStoryFileAttachment[] | null | undefined,
  nextAttachments: UserStoryFileAttachment[] | null | undefined
) {
  if (!currentAttachments || !nextAttachments) return nextAttachments
  const localContentById = new Map(
    currentAttachments
      .filter((attachment) => attachment.content !== undefined)
      .map((attachment) => [attachment.id, attachment.content])
  )
  return nextAttachments.map((attachment) => {
    const content = localContentById.get(attachment.id)
    return content === undefined ? attachment : { ...attachment, content }
  })
}

function providedValue<T>(value: T | undefined, fallback: T | undefined) {
  return value === undefined ? fallback : value
}

function newestValue<T extends { updatedAt?: string | null }>(
  currentValue: T,
  serverValue: T
) {
  const currentUpdatedAt = timestamp(currentValue.updatedAt)
  const serverUpdatedAt = timestamp(serverValue.updatedAt)
  if (serverUpdatedAt === undefined) return currentValue
  if (currentUpdatedAt === undefined || serverUpdatedAt >= currentUpdatedAt) {
    return serverValue
  }
  return currentValue
}

function timestamp(value: string | null | undefined) {
  if (!value) return undefined
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : date
}
